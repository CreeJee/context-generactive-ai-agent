//! The Tantivy lexical index of the memory nodes. SQLite stays the source of truth: the host
//! journals every change of a node and applies the journal here in bounded batches, and a read
//! checks every hit against its SQLite snapshot (docs/memory-search-measurements.md, the
//! Tantivy bench).
//!
//! One index of every searchable node, with `ngram` (lowercased three-character grams with
//! positions, as FTS5's trigram, so a term is searched as the phrase of its grams) and `lindera`
//! (terms made by Kiwi's rules from Lindera's ko-dic morphemes). `seq` and `project` are fast
//! fields; the project is filtered while collecting, and every matching document is scored:
//! Block-WAND pruning barely cut the many-term unions the reads send, and full scoring stays
//! exact whatever the filter drops.
use crate::search_control::Outcome;
use lindera::dictionary::load_dictionary;
use lindera::mode::Mode;
use lindera::segmenter::Segmenter;
use napi::bindgen_prelude::*;
use napi_derive::napi;
use regex::Regex;
use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashSet};
use std::path::Path;
use tantivy::query::{
    BooleanQuery, EnableScoring, Occur, PhraseQuery, Query, RegexQuery, TermQuery, Weight,
};
use tantivy::schema::{
    Field, IndexRecordOption, NumericOptions, Schema, TextFieldIndexing, TextOptions, FAST,
    STRING,
};
use tantivy::tokenizer::{
    LowerCaser, RemoveLongFilter, SimpleTokenizer, TextAnalyzer, Token, TokenStream, Tokenizer,
};
use tantivy::{
    DocSet, Index, IndexReader, IndexWriter, ReloadPolicy, Score, Searcher, TantivyDocument,
    Term, TERMINATED,
};
use unicode_normalization::UnicodeNormalization;

/// Tokens longer than this many bytes are blobs (hashes, base64), not words.
const LONGEST_TOKEN: usize = 64;
const WRITER_THREADS: usize = 2;
/// Shared by the writer threads. The host's batches are small; a larger one flushes on its own.
const WRITER_HEAP: usize = 128 << 20;
/// How many matching documents a search scores between deadline checks.
const CHECK_EVERY: u32 = 1024;

/// A failure inside the index, as text. Only the napi methods turn it into a JS error: the Rust
/// unit-test executable has no Node to build one with.
type Failed<T> = std::result::Result<T, String>;

fn failed(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn js_error(error: String) -> Error {
    Error::from_reason(error)
}

/// Overlapping three-character grams at consecutive positions, as FTS5's trigram tokenizer makes
/// them. Tantivy's own n-gram tokenizer puts every gram at position 0, which rules out phrases.
#[derive(Clone)]
struct Trigrams;

struct TrigramStream<'a> {
    text: &'a str,
    /// Byte offsets of every character, then the text's end.
    starts: Vec<usize>,
    next: usize,
    token: Token,
}

impl Tokenizer for Trigrams {
    type TokenStream<'a> = TrigramStream<'a>;
    fn token_stream<'a>(&'a mut self, text: &'a str) -> TrigramStream<'a> {
        let starts = text
            .char_indices()
            .map(|(at, _)| at)
            .chain([text.len()])
            .collect();
        TrigramStream {
            text,
            starts,
            next: 0,
            token: Token::default(),
        }
    }
}

impl TokenStream for TrigramStream<'_> {
    fn advance(&mut self) -> bool {
        let Some(&[from, _, _, to]) = self.starts.get(self.next..self.next + 4) else {
            return false;
        };
        self.token.offset_from = from;
        self.token.offset_to = to;
        self.token.position = self.next;
        self.token.text.clear();
        self.token.text.push_str(&self.text[from..to]);
        self.next += 1;
        true
    }
    fn token(&self) -> &Token {
        &self.token
    }
    fn token_mut(&mut self) -> &mut Token {
        &mut self.token
    }
}

fn words_analyzer() -> TextAnalyzer {
    TextAnalyzer::builder(SimpleTokenizer::default())
        .filter(RemoveLongFilter::limit(LONGEST_TOKEN))
        .filter(LowerCaser)
        .build()
}

fn trigram_analyzer() -> TextAnalyzer {
    TextAnalyzer::builder(Trigrams).filter(LowerCaser).build()
}

fn tokens(analyzer: &mut TextAnalyzer, text: &str) -> Vec<String> {
    let mut stream = analyzer.token_stream(text);
    let mut out = Vec::new();
    while stream.advance() {
        out.push(stream.token().text.clone());
    }
    out
}

fn dedupe(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

/// The part-of-speech tags whose morphemes Kiwi keeps as terms, which ko-dic shares, and the nouns.
const KEPT_TAGS: [&str; 7] = ["NNG", "NNP", "NR", "VV", "VA", "XR", "SH"];
const NOUN_TAGS: [&str; 2] = ["NNG", "NNP"];
/// Stems too common to search by, as Kiwi leaves them out.
const LIGHT_STEMS: [&str; 13] = [
    "하", "되", "있", "없", "않", "같", "이", "아니", "어떻", "어떠", "그렇", "이렇", "저렇",
];

/// One ko-dic morpheme, and whether it follows the one before with no space between.
struct Morpheme {
    surface: String,
    tag: String,
    joined: bool,
}

/// Search terms from Lindera's ko-dic morphemes, picked by the rules the Kiwi analyzer this index
/// replaced used (docs/decisions.md); measured, they matched Kiwi's terms or did a little better. The text is NFKC-normalized first and every term lowercased.
pub(crate) struct Morphology {
    segmenter: Segmenter,
    latin_or_number: Regex,
}

impl Morphology {
    pub(crate) fn new() -> Failed<Self> {
        Ok(Morphology {
            segmenter: Segmenter::new(
                Mode::Normal,
                load_dictionary("embedded://ko-dic").map_err(failed)?,
                None,
            ),
            latin_or_number: Regex::new(r"[\p{Script=Latin}\p{Nd}]+").map_err(failed)?,
        })
    }

    /// An inflected, compound or pre-analyzed token lists its morphemes in its expression detail
    /// (`하/VV/*+았/EP/*`): ko-dic gives it one fused tag (`VV+EP`), which a tag filter cannot
    /// sort into stem and ending. Any other token is one morpheme.
    fn morphemes(&self, text: &str) -> Failed<Vec<Morpheme>> {
        let mut morphemes = Vec::new();
        let mut previous_end = None;
        for mut token in self
            .segmenter
            .segment(Cow::Borrowed(text))
            .map_err(failed)?
        {
            let joined = previous_end == Some(token.byte_start);
            previous_end = Some(token.byte_end);
            let surface = token.surface.to_string();
            let details = token.details();
            let tag = details.first().copied().unwrap_or("UNK").to_string();
            let expression = details.get(7).copied().unwrap_or("*");
            let parts: Vec<(String, String)> = match expression {
                "*" => vec![(surface, tag)],
                _ => expression
                    .split('+')
                    .filter_map(|part| {
                        let mut fields = part.split('/');
                        Some((fields.next()?.to_string(), fields.next()?.to_string()))
                    })
                    .collect(),
            };
            morphemes.extend(
                parts
                    .into_iter()
                    .enumerate()
                    .map(|(at, (surface, tag))| Morpheme {
                        surface,
                        tag,
                        joined: at > 0 || joined,
                    }),
            );
        }
        Ok(morphemes)
    }

    /// Kiwi's kept tags except the light stems, a run of nouns written without spaces also as one
    /// term, and Latin words and numbers taken from the text itself.
    pub(crate) fn terms(&self, input: &str) -> Failed<Vec<String>> {
        let text: String = input.nfkc().collect();
        let mut terms = Vec::new();
        let mut run: Vec<String> = Vec::new();
        for morpheme in self.morphemes(&text)? {
            let noun = NOUN_TAGS.contains(&morpheme.tag.as_str());
            // A noun right after the run goes on with it; anything else ends it.
            if !(noun && morpheme.joined && !run.is_empty()) {
                if run.len() > 1 {
                    terms.push(run.concat());
                }
                run.clear();
            }
            if KEPT_TAGS.contains(&morpheme.tag.as_str())
                && !LIGHT_STEMS.contains(&morpheme.surface.as_str())
                && !self.latin_or_number.is_match(&morpheme.surface)
            {
                terms.push(morpheme.surface.clone());
            }
            if noun {
                run.push(morpheme.surface);
            }
        }
        if run.len() > 1 {
            terms.push(run.concat());
        }
        terms.extend(
            self.latin_or_number
                .find_iter(&text)
                .map(|found| found.as_str().to_string()),
        );
        Ok(terms.into_iter().map(|term| term.to_lowercase()).collect())
    }
}

#[derive(Clone, Copy)]
struct Fields {
    seq: Field,
    project: Field,
    ngram: Field,
    lindera: Field,
}

fn text_field(
    builder: &mut tantivy::schema::SchemaBuilder,
    name: &str,
    tokenizer: &str,
    record: IndexRecordOption,
) -> Field {
    builder.add_text_field(
        name,
        TextOptions::default().set_indexing_options(
            TextFieldIndexing::default()
                .set_tokenizer(tokenizer)
                .set_index_option(record),
        ),
    )
}

fn schema() -> (Schema, Fields) {
    let mut builder = Schema::builder();
    let seq = builder.add_u64_field("seq", NumericOptions::default().set_fast().set_indexed());
    let project = builder.add_text_field("project", STRING | FAST);
    let ngram = text_field(
        &mut builder,
        "ngram",
        "trigram",
        IndexRecordOption::WithFreqsAndPositions,
    );
    let lindera = text_field(
        &mut builder,
        "lindera",
        "words",
        IndexRecordOption::WithFreqs,
    );
    (
        builder.build(),
        Fields {
            seq,
            project,
            ngram,
            lindera,
        },
    )
}

/// A node as the host sends it to be indexed.
#[napi(object)]
pub struct LexicalDocument {
    pub seq: i64,
    pub project: String,
    pub text: String,
}

/// A scored document: the score first, then the seq so equal scores order the same every run.
#[derive(PartialEq)]
struct Hit {
    score: Score,
    seq: u64,
}
impl Eq for Hit {}
impl PartialOrd for Hit {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Hit {
    /// Better hits order first, so a max-heap's top is the worst hit kept.
    fn cmp(&self, other: &Self) -> Ordering {
        other
            .score
            .total_cmp(&self.score)
            .then(self.seq.cmp(&other.seq))
    }
}

/// The best `k` of the documents offered, by score and then lower seq.
struct Best {
    k: usize,
    heap: BinaryHeap<Hit>,
}
impl Best {
    fn new(k: usize) -> Self {
        Best {
            k,
            heap: BinaryHeap::new(),
        }
    }
    fn offer(&mut self, seq: u64, score: Score) {
        if self.k == 0 {
            return;
        }
        self.heap.push(Hit { score, seq });
        if self.heap.len() > self.k {
            self.heap.pop();
        }
    }
    fn seqs(self) -> Vec<u64> {
        self.heap
            .into_sorted_vec()
            .into_iter()
            .map(|hit| hit.seq)
            .collect()
    }
}

struct Lexical {
    writer: IndexWriter,
    reader: IndexReader,
    fields: Fields,
    morphology: Morphology,
    /// Which build of the index this is; the host keeps the same value beside its journal.
    instance: Option<String>,
}

fn register(index: &Index) {
    index.tokenizers().register("words", words_analyzer());
    index.tokenizers().register("trigram", trigram_analyzer());
}

/// Opens the index in `dir`, or creates it when there is none. One that cannot be opened, or that
/// was written with another schema, is replaced by an empty one only when `recover` says so.
fn open_index(dir: &Path, recover: bool) -> Failed<Index> {
    let expected = schema().0;
    if dir.join("meta.json").exists() {
        match Index::open_in_dir(dir) {
            Ok(index) if index.schema() == expected => return Ok(index),
            _ if !recover => return Err("Lexical index layout mismatch".into()),
            _ => std::fs::remove_dir_all(dir).map_err(failed)?,
        }
    }
    std::fs::create_dir_all(dir).map_err(failed)?;
    Index::create_in_dir(dir, expected).map_err(failed)
}

impl Lexical {
    fn open(dir: &Path, recover: bool) -> Failed<Self> {
        let index = open_index(dir, recover)?;
        register(&index);
        let instance = index.load_metas().map_err(failed)?.payload;
        let writer = index
            .writer_with_num_threads(WRITER_THREADS, WRITER_HEAP)
            .map_err(|error| match error {
                tantivy::TantivyError::LockFailure(..) => {
                    "Lexical index is locked by another writer".to_string()
                }
                error => failed(error),
            })?;
        let reader = index
            .reader_builder()
            .reload_policy(ReloadPolicy::Manual)
            .try_into()
            .map_err(failed)?;
        Ok(Lexical {
            writer,
            reader,
            fields: schema().1,
            morphology: Morphology::new()?,
            instance,
        })
    }

    /// Commits with the instance as the payload, which every commit replaces, and makes the
    /// commit visible to the next search.
    fn commit(&mut self) -> Failed<()> {
        let mut prepared = self.writer.prepare_commit().map_err(failed)?;
        if let Some(instance) = &self.instance {
            prepared.set_payload(instance);
        }
        prepared.commit().map_err(failed)?;
        self.reader.reload().map_err(failed)
    }

    fn reset(&mut self, instance: String) -> Failed<()> {
        self.writer.delete_all_documents().map_err(failed)?;
        self.instance = Some(instance);
        self.commit()
    }

    fn apply(&mut self, documents: &[LexicalDocument], removed: &[i64]) -> Failed<u32> {
        let built = documents
            .iter()
            .map(|node| self.document(node))
            .collect::<Failed<Vec<_>>>()?;
        for value in removed.iter().chain(documents.iter().map(|node| &node.seq)) {
            self.writer
                .delete_term(Term::from_field_u64(self.fields.seq, seq(*value)?));
        }
        for doc in built {
            self.writer.add_document(doc).map_err(failed)?;
        }
        self.commit()?;
        Ok(self.searcher().num_docs() as u32)
    }

    fn document(&self, node: &LexicalDocument) -> Failed<TantivyDocument> {
        let mut doc = TantivyDocument::new();
        doc.add_u64(self.fields.seq, seq(node.seq)?);
        doc.add_text(self.fields.project, &node.project);
        doc.add_text(self.fields.ngram, &node.text);
        doc.add_text(
            self.fields.lindera,
            self.morphology.terms(&node.text)?.join(" "),
        );
        Ok(doc)
    }

    fn searcher(&self) -> Searcher {
        self.reader.searcher()
    }
}

fn seq(value: i64) -> Failed<u64> {
    u64::try_from(value).map_err(|_| "Invalid node seq".to_string())
}

/// Visits every live matching document of `weight` whose project is one of `projects`, with its
/// seq and score, checking `check` as it goes.
fn each_match(
    searcher: &Searcher,
    weight: &dyn Weight,
    projects: &[String],
    check: &dyn Fn() -> std::result::Result<(), Outcome>,
    mut visit: impl FnMut(u64, Score),
) -> std::result::Result<(), Outcome> {
    for segment in searcher.segment_readers() {
        let fast = segment.fast_fields();
        let seqs = fast.u64("seq").map_err(|_| Outcome::ReadFailed)?;
        let Some(project) = fast.str("project").map_err(|_| Outcome::ReadFailed)? else {
            continue;
        };
        // Each segment numbers its own project strings.
        let allowed: HashSet<u64> = projects
            .iter()
            .filter_map(|id| project.dictionary().term_ord(id).ok().flatten())
            .collect();
        if allowed.is_empty() {
            continue;
        }
        let alive = segment.alive_bitset();
        let mut scorer = weight
            .scorer(segment, 1.0)
            .map_err(|_| Outcome::ReadFailed)?;
        let mut doc = scorer.doc();
        let mut seen = 0u32;
        while doc != TERMINATED {
            seen += 1;
            if seen % CHECK_EVERY == 0 {
                check()?;
            }
            if alive.is_none_or(|alive| alive.is_alive(doc))
                && project.ords().first(doc).is_some_and(|ord| allowed.contains(&ord))
            {
                if let Some(seq) = seqs.first(doc) {
                    visit(seq, scorer.score());
                }
            }
            doc = scorer.advance();
        }
    }
    Ok(())
}

fn should(clauses: Vec<Box<dyn Query>>) -> BooleanQuery {
    BooleanQuery::new(
        clauses
            .into_iter()
            .map(|clause| (Occur::Should, clause))
            .collect(),
    )
}

/// A term as the phrase of its grams, as FTS5's trigram table matches a quoted term.
fn gram_phrase(field: Field, grams: &[String]) -> Box<dyn Query> {
    let terms: Vec<Term> = grams
        .iter()
        .map(|gram| Term::from_field_text(field, gram))
        .collect();
    match terms.as_slice() {
        [single] => Box::new(TermQuery::new(single.clone(), IndexRecordOption::WithFreqs)),
        _ => Box::new(PhraseQuery::new(terms)),
    }
}

/// The best `k` documents of a query, every match scored.
fn ranked(
    searcher: &Searcher,
    query: &dyn Query,
    k: usize,
    projects: &[String],
    check: &dyn Fn() -> std::result::Result<(), Outcome>,
) -> std::result::Result<Vec<u64>, Outcome> {
    let weight = query
        .weight(EnableScoring::enabled_from_searcher(searcher))
        .map_err(|_| Outcome::ReadFailed)?;
    let mut best = Best::new(k);
    each_match(searcher, weight.as_ref(), projects, check, |seq, score| {
        best.offer(seq, score)
    })?;
    Ok(best.seqs())
}

/// The read side of the index, for one read: a searcher fixed at the read's start.
pub(crate) struct LexicalSearch<'a> {
    lexical: &'a Lexical,
    searcher: Searcher,
}

impl LexicalSearch<'_> {
    /// The best `k` documents holding any of `terms` (3+ characters each), each searched as the
    /// phrase of its grams.
    pub(crate) fn phrases(
        &self,
        terms: &[String],
        k: usize,
        projects: &[String],
        check: &dyn Fn() -> std::result::Result<(), Outcome>,
    ) -> std::result::Result<Vec<u64>, Outcome> {
        let mut trigrams = trigram_analyzer();
        let clauses: Vec<Box<dyn Query>> = terms
            .iter()
            .map(|term| tokens(&mut trigrams, term))
            .filter(|grams| !grams.is_empty())
            .map(|grams| gram_phrase(self.lexical.fields.ngram, &grams))
            .collect();
        if clauses.is_empty() {
            return Ok(vec![]);
        }
        ranked(&self.searcher, &should(clauses), k, projects, check)
    }

    /// For each two-character term, the seqs of its newest `k` documents. A gram starts with the
    /// term wherever it occurs, except at the very end of a text, where a gram ends with it.
    pub(crate) fn short_terms(
        &self,
        terms: &[String],
        k: usize,
        projects: &[String],
        check: &dyn Fn() -> std::result::Result<(), Outcome>,
    ) -> std::result::Result<Vec<Vec<u64>>, Outcome> {
        let scoring = EnableScoring::disabled_from_searcher(&self.searcher);
        terms
            .iter()
            .map(|term| {
                let term = regex::escape(&term.to_lowercase());
                let query =
                    RegexQuery::from_pattern(&format!("(?s:{term}.|.{term})"), self.lexical.fields.ngram)
                        .map_err(|_| Outcome::InvalidInput)?;
                let weight = query.weight(scoring).map_err(|_| Outcome::ReadFailed)?;
                // Newest first: the heap keeps the highest seqs.
                let mut newest = BinaryHeap::new();
                each_match(&self.searcher, weight.as_ref(), projects, check, |seq, _| {
                    newest.push(std::cmp::Reverse(seq));
                    if newest.len() > k {
                        newest.pop();
                    }
                })?;
                Ok(newest
                    .into_sorted_vec()
                    .into_iter()
                    .map(|std::cmp::Reverse(seq)| seq)
                    .collect())
            })
            .collect()
    }

    /// The best `k` documents holding any morph term of `text`.
    pub(crate) fn morphs(
        &self,
        text: &str,
        k: usize,
        projects: &[String],
        check: &dyn Fn() -> std::result::Result<(), Outcome>,
    ) -> std::result::Result<Vec<u64>, Outcome> {
        let mut words = words_analyzer();
        let terms = self
            .lexical
            .morphology
            .terms(text)
            .map_err(|_| Outcome::ReadFailed)?;
        let clauses: Vec<Box<dyn Query>> = dedupe(terms.iter().flat_map(|term| tokens(&mut words, term)))
            .into_iter()
            .map(|term| {
                Box::new(TermQuery::new(
                    Term::from_field_text(self.lexical.fields.lindera, &term),
                    IndexRecordOption::WithFreqs,
                )) as Box<dyn Query>
            })
            .collect();
        if clauses.is_empty() {
            return Ok(vec![]);
        }
        ranked(&self.searcher, &should(clauses), k, projects, check)
    }
}

/// The lexical index, owned by the native search worker like the vector index. Its synchronous
/// methods are called only inside that worker.
#[napi]
pub struct LexicalIndex {
    /// `None` after `close`: later calls fail instead of reaching the released index.
    inner: Option<Lexical>,
}

impl LexicalIndex {
    fn lexical(&self) -> Failed<&Lexical> {
        self.inner
            .as_ref()
            .ok_or_else(|| "Lexical index is closed".to_string())
    }
    fn lexical_mut(&mut self) -> Failed<&mut Lexical> {
        self.inner
            .as_mut()
            .ok_or_else(|| "Lexical index is closed".to_string())
    }
    pub(crate) fn search(&self) -> Failed<LexicalSearch<'_>> {
        let lexical = self.lexical()?;
        Ok(LexicalSearch {
            lexical,
            searcher: lexical.searcher(),
        })
    }
}

#[napi]
impl LexicalIndex {
    /// Opens the index in `dir`, creating it when there is none. An index that cannot be opened or
    /// has another layout fails, unless `recover` replaces it with an empty one.
    #[napi(factory)]
    pub fn open(dir: String, recover: bool) -> Result<Self> {
        Ok(Self {
            inner: Some(Lexical::open(Path::new(&dir), recover).map_err(js_error)?),
        })
    }
    /// The build the index holds, as `reset` named it; none for a new or replaced index.
    #[napi]
    pub fn instance(&self) -> Result<Option<String>> {
        Ok(self.lexical().map_err(js_error)?.instance.clone())
    }
    /// Empties the index and names the new build.
    #[napi]
    pub fn reset(&mut self, instance: String) -> Result<()> {
        self.lexical_mut()
            .and_then(|lexical| lexical.reset(instance))
            .map_err(js_error)
    }
    /// Replaces the documents of `removed` and of every document's seq with `documents`, in one
    /// commit. Removing a seq the index does not hold does nothing.
    #[napi]
    pub fn apply(&mut self, documents: Vec<LexicalDocument>, removed: Vec<i64>) -> Result<u32> {
        self.lexical_mut()
            .and_then(|lexical| lexical.apply(&documents, &removed))
            .map_err(js_error)
    }
    /// How many documents the index holds.
    #[napi]
    pub fn size(&self) -> Result<u32> {
        Ok(self.lexical().map_err(js_error)?.searcher().num_docs() as u32)
    }
    /// Releases the index and its writer lock now rather than at garbage collection, after any
    /// merge still writing segment files has finished. Idempotent.
    #[napi]
    pub fn close(&mut self) {
        if let Some(lexical) = self.inner.take() {
            // Dropping the writer stops its indexing threads but not a running merge, which
            // would go on writing into the folder after close.
            let _ = lexical.writer.wait_merging_threads();
        }
    }
    /// The morph terms of `text`, for tests and evaluations of the analysis.
    #[napi]
    pub fn morph_terms(&self, text: String) -> Result<Vec<String>> {
        self.lexical()
            .and_then(|lexical| lexical.morphology.terms(&text))
            .map_err(js_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "lexical-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    fn node(seq: i64, project: &str, text: &str) -> LexicalDocument {
        LexicalDocument {
            seq,
            project: project.into(),
            text: text.into(),
        }
    }

    fn ok() -> std::result::Result<(), Outcome> {
        Ok(())
    }

    #[test]
    fn terms_follow_kiwi_rules() {
        let morphology = Morphology::new().unwrap();
        let terms = morphology
            .terms("메모리 검색엔진을 Tantivy로 바꿨고 drizzle-kit도 있었다")
            .unwrap();
        for expected in [
            "메모리", "검색", "엔진", "검색엔진", "바꾸", "tantivy", "drizzle", "kit",
        ] {
            assert!(terms.contains(&expected.to_string()), "{expected} in {terms:?}");
        }
        assert!(!terms.contains(&"있".to_string()));
    }

    #[test]
    fn trigrams_have_consecutive_positions() {
        let mut analyzer = trigram_analyzer();
        let mut stream = analyzer.token_stream("AbcD");
        let mut grams = Vec::new();
        while stream.advance() {
            grams.push((stream.token().text.clone(), stream.token().position));
        }
        assert_eq!(grams, [("abc".to_string(), 0), ("bcd".to_string(), 1)]);
    }

    fn size(lexical: &Lexical) -> u64 {
        lexical.searcher().num_docs()
    }

    fn search(lexical: &Lexical) -> LexicalSearch<'_> {
        LexicalSearch {
            lexical,
            searcher: lexical.searcher(),
        }
    }

    #[test]
    fn apply_replaces_and_searches_filter_by_project() {
        let dir = temp_dir("apply");
        let mut lexical = Lexical::open(&dir, false).unwrap();
        assert_eq!(lexical.instance, None);
        lexical.reset("first".into()).unwrap();
        lexical
            .apply(
                &[
                    node(1, "p", "검색엔진을 바꿨다"),
                    node(2, "p", "오늘 PR을 열었다"),
                    node(3, "q", "검색엔진 문서"),
                    node(4, "p", "다른 이야기 오늘"),
                ],
                &[],
            )
            .unwrap();
        assert_eq!(size(&lexical), 4);
        let projects = ["p".to_string()];
        {
            let search = search(&lexical);
            assert_eq!(search.morphs("검색엔진", 10, &projects, &ok).unwrap(), [1]);
            assert_eq!(
                search
                    .phrases(&["검색엔진".into()], 10, &projects, &ok)
                    .unwrap(),
                [1]
            );
            // Newest first; "오늘" ends the text of node 4.
            assert_eq!(
                search
                    .short_terms(&["오늘".into(), "PR".into()], 10, &projects, &ok)
                    .unwrap(),
                [vec![4, 2], vec![2]]
            );
        }
        // Node 1's text changed and node 2 went away.
        lexical.apply(&[node(1, "p", "[hidden]")], &[2]).unwrap();
        assert_eq!(size(&lexical), 3);
        {
            let search = search(&lexical);
            assert!(search.morphs("검색엔진", 10, &projects, &ok).unwrap().is_empty());
            assert_eq!(
                search
                    .short_terms(&["오늘".into()], 10, &projects, &ok)
                    .unwrap(),
                [vec![4]]
            );
        }
        drop(lexical);
        let reopened = Lexical::open(&dir, false).unwrap();
        assert_eq!(reopened.instance.as_deref(), Some("first"));
        assert_eq!(size(&reopened), 3);
        drop(reopened);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_held_writer_lock_fails_the_second_open() {
        let dir = temp_dir("lock");
        let first = Lexical::open(&dir, false).unwrap();
        assert!(Lexical::open(&dir, false).is_err());
        drop(first);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
