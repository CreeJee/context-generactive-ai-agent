//! Tantivy indexes of a copy of a storage folder, for the memory search redesign
//! (docs/memory-search-measurements.md). Not product code: it reads the copy's agent.db read-only,
//! builds indexes under <copy>/tantivy, and runs the search set's items (written by
//! packages/memory-agent/eval/search-set.ts) against them, writing ranked runs the set scores and
//! printing only counts, sizes and timings. The app's SQLite FTS5 statements are run and timed by
//! the set's own `fts` command, on node's SQLite as the app reads them.
//!
//!   tantivy-bench build <copy>
//!   tantivy-bench query <copy> [--repeat N]
//!
//! Indexes, suppressed nodes left out of all of them:
//!   global     fields `words` (letters and digits, lowercased, as FTS5's unicode61), `morph` (the
//!              Kiwi terms FTS5's nodes_morph holds, split the same way), `ngram` (lowercased
//!              three-character grams with positions, as FTS5's trigram, so a term is searched as
//!              the phrase of its grams) and `lindera` (terms made by Kiwi's rules from Lindera's
//!              ko-dic morphemes, for the nodes Kiwi analyzed); the project is a fast field,
//!              filtered while collecting
//!   project/N  one index per project
//!   prefixed   one index whose terms carry the project's number: `3_word`
//!
//! The project filter decides whether Block-WAND top-k pruning survives: a MUST clause on the
//! project turns the union of terms into an intersection the pruning does not cover. The global
//! index keeps the query a pure union and drops other projects' documents inside the pruning
//! callback, so a dropped document never raises the threshold. The per-project indexes put the
//! project in the index instead: one weight, scored with every project index's statistics summed,
//! runs over the readable projects' segments, which scores as the global index does. The prefixed
//! index is only timed.
//!
//! Block-WAND's bound for a block of postings is the best (length, frequency) pair of the block, a
//! pair chosen when the segment was written, by the segment's own average length. Scored with other
//! statistics, the pair may not be the best and the bound too low, so pruning can skip a document
//! that belongs in the top k. A segment of a large index has an average length close to the whole
//! index's; a project's index may not.
//!
//! The lexical query (words and morph) is also searched other ways, timed and checked against
//! tv-lexical's scores: on the per-project indexes, pruned and with every match scored; hybrid, the
//! own project on its index and the other projects on the global one; and on the global index with
//! every match scored.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::{BinaryHeap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

use lindera::dictionary::load_dictionary;
use lindera::mode::Mode;
use lindera::segmenter::Segmenter;
use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use tantivy::query::{
    Bm25StatisticsProvider, BooleanQuery, EnableScoring, Occur, PhraseQuery, Query, TermQuery,
    Weight,
};
use tantivy::schema::{
    Field, IndexRecordOption, NumericOptions, Schema, SchemaBuilder, TextFieldIndexing, TextOptions,
};
use tantivy::tokenizer::{
    LowerCaser, RemoveLongFilter, SimpleTokenizer, TextAnalyzer, Token, TokenStream, Tokenizer,
    WhitespaceTokenizer,
};
use tantivy::{
    DocId, Index, IndexWriter, ReloadPolicy, Score, Searcher, SegmentReader, TantivyDocument, Term,
};
use unicode_normalization::UnicodeNormalization;

type Error = Box<dyn std::error::Error>;
type Result<T> = std::result::Result<T, Error>;

/// Ids asked of every scope and kept per item, as the search set's pool does.
const DEPTH: usize = 40;
const KEPT: usize = 30;
/// Tokens longer than this many bytes are blobs (hashes, base64), not words.
const LONGEST_TOKEN: usize = 64;
const WRITER_THREADS: usize = 2;
const WRITER_HEAP: usize = 1 << 30;
const PROJECT_WRITER_HEAP: usize = 128 << 20;
/// The app's read budget for a whole search: searches over it are counted.
const APP_BUDGET_MS: f64 = 2000.0;
const NOT_SUPPRESSED: &str =
    "NOT EXISTS (SELECT 1 FROM memory_graph_suppressed_nodes s WHERE s.node_seq = n.seq)";

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

/// The prefixed index's text is already split, lowercased and prefixed.
fn split_analyzer() -> TextAnalyzer {
    TextAnalyzer::builder(WhitespaceTokenizer::default()).build()
}

fn tokens(analyzer: &mut TextAnalyzer, text: &str) -> Vec<String> {
    let mut stream = analyzer.token_stream(text);
    let mut out = Vec::new();
    while stream.advance() {
        out.push(stream.token().text.clone());
    }
    out
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

/// Search terms from Lindera's ko-dic morphemes by Kiwi's rules
/// (packages/memory-agent/src/memory/morph/kiwi-worker.ts), to see whether Lindera can stand in for
/// Kiwi: kept morphemes except the light stems, a run of nouns written without spaces also as one
/// term, and Latin words and numbers taken from the text itself, all lowercased after NFKC.
struct Lindera {
    segmenter: Segmenter,
    latin_or_number: Regex,
}

impl Lindera {
    fn new() -> Result<Self> {
        Ok(Lindera {
            segmenter: Segmenter::new(Mode::Normal, load_dictionary("embedded://ko-dic")?, None),
            latin_or_number: Regex::new(r"[\p{Script=Latin}\p{Nd}]+")?,
        })
    }

    /// An inflected, compound or pre-analyzed token lists its morphemes in its expression detail
    /// (`하/VV/*+았/EP/*`); any other token is one morpheme.
    fn morphemes(&self, text: &str) -> Result<Vec<Morpheme>> {
        let mut morphemes = Vec::new();
        let mut previous_end = None;
        for mut token in self.segmenter.segment(Cow::Borrowed(text))? {
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

    fn terms(&self, input: &str) -> Result<Vec<String>> {
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

fn dedupe(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

#[derive(Clone, Copy, PartialEq)]
enum Kind {
    Global,
    Project,
    Prefixed,
}

/// Every index has every field; only the global index fills `lindera`, and the prefixed index leaves
/// `ngram` empty.
#[derive(Clone, Copy)]
struct Fields {
    seq: Field,
    project: Field,
    words: Field,
    morph: Field,
    ngram: Field,
    lindera: Field,
}

fn text_field(
    builder: &mut SchemaBuilder,
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

fn schema(kind: Kind) -> (Schema, Fields) {
    let mut builder = Schema::builder();
    let numeric = NumericOptions::default().set_fast().set_indexed();
    let seq = builder.add_u64_field("seq", numeric.clone());
    let project = builder.add_u64_field("project", numeric);
    let words_tokenizer = if kind == Kind::Prefixed {
        "split"
    } else {
        "words"
    };
    let words = text_field(
        &mut builder,
        "words",
        words_tokenizer,
        IndexRecordOption::WithFreqs,
    );
    let morph = text_field(
        &mut builder,
        "morph",
        words_tokenizer,
        IndexRecordOption::WithFreqs,
    );
    let ngram = text_field(
        &mut builder,
        "ngram",
        "trigram",
        IndexRecordOption::WithFreqsAndPositions,
    );
    let lindera = text_field(
        &mut builder,
        "lindera",
        words_tokenizer,
        IndexRecordOption::WithFreqs,
    );
    (
        builder.build(),
        Fields {
            seq,
            project,
            words,
            morph,
            ngram,
            lindera,
        },
    )
}

fn register(index: &Index) {
    index.tokenizers().register("words", words_analyzer());
    index.tokenizers().register("trigram", trigram_analyzer());
    index.tokenizers().register("split", split_analyzer());
}

fn create(dir: &Path, kind: Kind) -> Result<(Index, Fields)> {
    if dir.exists() {
        fs::remove_dir_all(dir)?;
    }
    fs::create_dir_all(dir)?;
    let (schema, fields) = schema(kind);
    let index = Index::create_in_dir(dir, schema)?;
    register(&index);
    Ok((index, fields))
}

/// An index opened for searching, with its fields.
struct Opened {
    fields: Fields,
    searcher: Searcher,
}

fn open(dir: &Path, kind: Kind) -> Result<Opened> {
    let index = Index::open_in_dir(dir)?;
    register(&index);
    let reader = index
        .reader_builder()
        .reload_policy(ReloadPolicy::Manual)
        .try_into()?;
    Ok(Opened {
        fields: schema(kind).1,
        searcher: reader.searcher(),
    })
}

fn database(copy: &Path) -> Result<Connection> {
    let db = Connection::open_with_flags(
        copy.join("agent.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    db.execute_batch("PRAGMA query_only=ON;")?;
    Ok(db)
}

/// Every project by its number, in table order, and the numbers left out of cross-project reads.
fn projects(db: &Connection) -> Result<(HashMap<String, u64>, HashSet<u64>)> {
    let rows = db
        .prepare("SELECT id, cross_recall_excluded FROM projects ORDER BY rowid")?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let numbers = rows
        .iter()
        .zip(0u64..)
        .map(|((id, _), n)| (id.clone(), n))
        .collect();
    let excluded = rows
        .iter()
        .zip(0u64..)
        .filter(|((_, excluded), _)| *excluded != 0)
        .map(|(_, n)| n)
        .collect();
    Ok((numbers, excluded))
}

fn dir_size(dir: &Path) -> u64 {
    fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .map(|entry| match entry.path() {
                    path if path.is_dir() => dir_size(&path),
                    _ => entry.metadata().map(|m| m.len()).unwrap_or(0),
                })
                .sum()
        })
        .unwrap_or(0)
}

fn megabytes(dir: &Path) -> String {
    format!("{:.0} MB", dir_size(dir) as f64 / 1e6)
}

fn ms_since(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

/// One node as the indexes see it.
struct Node {
    seq: u64,
    project: u64,
    text: String,
    morph: String,
    /// Kiwi has analyzed the node.
    analyzed: bool,
}

/// Visits every node that is not suppressed, in `order`.
fn each_node(
    db: &Connection,
    order: &str,
    mut visit: impl FnMut(Node) -> Result<()>,
) -> Result<()> {
    let (numbers, _) = projects(db)?;
    let mut statement = db.prepare(&format!(
        "SELECT n.seq, n.project_id, n.text, coalesce(m.c0, ''), m.id IS NOT NULL FROM nodes n
         LEFT JOIN nodes_morph_content m ON m.id = n.seq WHERE {NOT_SUPPRESSED} ORDER BY {order}"
    ))?;
    let rows = statement.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, bool>(4)?,
        ))
    })?;
    for row in rows {
        let (seq, project, text, morph, analyzed) = row?;
        let project = *numbers
            .get(&project)
            .ok_or("a node of an unknown project")?;
        visit(Node {
            seq: seq as u64,
            project,
            text,
            morph,
            analyzed,
        })?;
    }
    Ok(())
}

fn document(
    kind: Kind,
    fields: Fields,
    node: &Node,
    lindera: &str,
    words: &mut TextAnalyzer,
) -> TantivyDocument {
    let mut doc = TantivyDocument::new();
    doc.add_u64(fields.seq, node.seq);
    doc.add_u64(fields.project, node.project);
    match kind {
        Kind::Global | Kind::Project => {
            doc.add_text(fields.words, &node.text);
            doc.add_text(fields.morph, &node.morph);
            doc.add_text(fields.ngram, &node.text);
            doc.add_text(fields.lindera, lindera);
        }
        Kind::Prefixed => {
            let mut prefixed = |text: &str| {
                tokens(words, text)
                    .iter()
                    .map(|token| format!("{}_{token}", node.project))
                    .collect::<Vec<_>>()
                    .join(" ")
            };
            doc.add_text(fields.words, prefixed(&node.text));
            doc.add_text(fields.morph, prefixed(&node.morph));
        }
    }
    doc
}

fn finish(writer: Option<(u64, IndexWriter, Fields)>) -> Result<()> {
    if let Some((_, mut writer, _)) = writer {
        writer.commit()?;
        writer.wait_merging_threads()?;
    }
    Ok(())
}

fn build(copy: &Path) -> Result<()> {
    let db = database(copy)?;
    let root = copy.join("tantivy");
    let mut words = words_analyzer();
    let lindera = Lindera::new()?;
    for (kind, dir) in [(Kind::Global, "global"), (Kind::Prefixed, "prefixed")] {
        let started = Instant::now();
        let (index, fields) = create(&root.join(dir), kind)?;
        let mut writer: IndexWriter = index.writer_with_num_threads(WRITER_THREADS, WRITER_HEAP)?;
        let mut count = 0u64;
        // Lindera's share of the build: the nodes it analyzed, their characters and its time.
        let (mut analyzed, mut characters, mut lindera_ms) = (0u64, 0u64, 0f64);
        each_node(&db, "n.seq", |node| {
            count += 1;
            let terms = if kind == Kind::Global && node.analyzed {
                let analyzing = Instant::now();
                let terms = lindera.terms(&node.text)?.join(" ");
                lindera_ms += ms_since(analyzing);
                analyzed += 1;
                characters += node.text.chars().count() as u64;
                terms
            } else {
                String::new()
            };
            writer.add_document(document(kind, fields, &node, &terms, &mut words))?;
            Ok(())
        })?;
        if analyzed > 0 {
            println!(
                "lindera: {analyzed} nodes, {characters} characters in {:.1} s",
                lindera_ms / 1000.0
            );
        }
        writer.commit()?;
        writer.wait_merging_threads()?;
        println!(
            "{dir}: {count} nodes in {:.1} s, {}, {} segments",
            ms_since(started) / 1000.0,
            megabytes(&root.join(dir)),
            index.searchable_segment_ids()?.len()
        );
    }

    // One index per project, built one at a time in project order.
    let started = Instant::now();
    let project_root = root.join("project");
    let mut current: Option<(u64, IndexWriter, Fields)> = None;
    each_node(&db, "n.project_id, n.seq", |node| {
        if current.as_ref().map(|(project, _, _)| *project) != Some(node.project) {
            finish(current.take())?;
            let (index, fields) =
                create(&project_root.join(node.project.to_string()), Kind::Project)?;
            current = Some((
                node.project,
                index.writer_with_num_threads(WRITER_THREADS, PROJECT_WRITER_HEAP)?,
                fields,
            ));
        }
        if let Some((_, writer, fields)) = current.as_mut() {
            writer.add_document(document(Kind::Project, *fields, &node, "", &mut words))?;
        }
        Ok(())
    })?;
    finish(current.take())?;
    println!(
        "project: {} indexes in {:.1} s, {}",
        fs::read_dir(&project_root)?.count(),
        ms_since(started) / 1000.0,
        megabytes(&project_root)
    );
    Ok(())
}

#[derive(Deserialize)]
struct Item {
    item: String,
    need: String,
    query: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Need {
    need: String,
    project_id: String,
    cross_project: bool,
    before_seq: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct QueryTerms {
    item: String,
    trigram: Vec<String>,
    morph: Vec<String>,
    morph_all: Vec<String>,
}

#[derive(Serialize)]
struct RunRow<'a> {
    item: &'a str,
    ids: Vec<&'a str>,
}

fn read_rows<T: serde::de::DeserializeOwned>(file: &Path) -> Result<Vec<T>> {
    let lines = BufReader::new(fs::File::open(file)?)
        .lines()
        .collect::<std::io::Result<Vec<_>>>()?;
    // A torn last line from a stopped append is skipped, as the set's own reader does.
    Ok(lines
        .iter()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect())
}

fn write_row(mut file: &fs::File, item: &str, ids: Vec<&str>) -> Result<()> {
    writeln!(file, "{}", serde_json::to_string(&RunRow { item, ids })?)?;
    Ok(())
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

/// What one top-k search found, best first, and how many documents the search offered to it.
struct TopK {
    hits: Vec<Hit>,
    offered: u64,
}

/// The best `DEPTH` documents a search offers whose project is `allowed` and whose seq is below
/// `before`.
struct Best<'a> {
    allowed: &'a dyn Fn(u64) -> bool,
    before: Option<u64>,
    heap: BinaryHeap<Hit>,
    offered: u64,
}

impl<'a> Best<'a> {
    fn new(allowed: &'a dyn Fn(u64) -> bool, before: Option<u64>) -> Self {
        Best {
            allowed,
            before,
            heap: BinaryHeap::new(),
            offered: 0,
        }
    }

    /// The score a document has to beat to be kept: the worst kept one's once `DEPTH` are kept.
    fn threshold(&self) -> Score {
        match self.heap.peek() {
            Some(worst) if self.heap.len() == DEPTH => worst.score,
            _ => Score::MIN,
        }
    }

    /// Keeps the document if it is allowed and good enough, and returns the score to beat. A
    /// rejected document leaves it unchanged, so Block-WAND keeps pruning by the kept documents
    /// alone.
    fn offer(&mut self, project: u64, seq: u64, score: Score) -> Score {
        self.offered += 1;
        if (self.allowed)(project) && self.before.is_none_or(|before| seq < before) {
            self.heap.push(Hit { score, seq });
            if self.heap.len() > DEPTH {
                self.heap.pop();
            }
        }
        self.threshold()
    }

    fn found(self) -> TopK {
        TopK {
            hits: self.heap.into_sorted_vec(),
            offered: self.offered,
        }
    }
}

/// How a search goes through a segment's matches.
#[derive(Clone, Copy)]
enum Visit {
    /// Block-WAND: documents that cannot beat the score to beat are skipped unscored.
    Pruned,
    /// Every matching document scored.
    Every,
}

/// The best documents of the query over `segments`, which may come from several indexes of the
/// same schema. The score to beat carries from one segment to the next.
fn top_k<'a>(
    segments: impl IntoIterator<Item = &'a SegmentReader>,
    weight: &dyn Weight,
    visit: Visit,
    mut best: Best,
) -> Result<TopK> {
    for segment in segments {
        let seqs = segment.fast_fields().u64("seq")?;
        let projects = segment.fast_fields().u64("project")?;
        let start = best.threshold();
        let mut offer = |doc: DocId, score: Score| {
            best.offer(
                projects.first(doc).unwrap_or(u64::MAX),
                seqs.first(doc).unwrap_or(u64::MAX),
                score,
            )
        };
        match visit {
            Visit::Pruned => weight.for_each_pruning(start, segment, &mut offer)?,
            Visit::Every => weight.for_each(segment, &mut |doc, score| {
                offer(doc, score);
            })?,
        }
    }
    Ok(best.found())
}

/// Documents any clause matches, unfiltered: what a search without pruning would visit.
fn matched(searcher: &Searcher, weight: &dyn Weight) -> Result<u64> {
    Ok(searcher
        .segment_readers()
        .iter()
        .map(|segment| weight.count(segment).map(u64::from))
        .sum::<tantivy::Result<u64>>()?)
}

/// Every project index's statistics summed: what one index of all the projects counts. A weight
/// scored with them ranks a project's documents against other projects' as the global index does.
struct Summed<'a>(Vec<&'a Searcher>);

impl Bm25StatisticsProvider for Summed<'_> {
    fn total_num_tokens(&self, field: Field) -> tantivy::Result<u64> {
        self.0
            .iter()
            .map(|searcher| Bm25StatisticsProvider::total_num_tokens(*searcher, field))
            .sum()
    }
    fn total_num_docs(&self) -> tantivy::Result<u64> {
        self.0
            .iter()
            .map(|searcher| Bm25StatisticsProvider::total_num_docs(*searcher))
            .sum()
    }
    fn doc_freq(&self, term: &Term) -> tantivy::Result<u64> {
        self.0
            .iter()
            .map(|searcher| Bm25StatisticsProvider::doc_freq(*searcher, term))
            .sum()
    }
}

fn term_queries(field: Field, values: &[String]) -> Vec<Box<dyn Query>> {
    values
        .iter()
        .map(|value| {
            Box::new(TermQuery::new(
                Term::from_field_text(field, value),
                IndexRecordOption::WithFreqs,
            )) as Box<dyn Query>
        })
        .collect()
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

/// The words clauses and then the morph clauses of one query.
fn joined(words: Vec<Box<dyn Query>>, morph: Vec<Box<dyn Query>>) -> Vec<Box<dyn Query>> {
    words.into_iter().chain(morph).collect()
}

fn should(clauses: Vec<Box<dyn Query>>) -> BooleanQuery {
    BooleanQuery::new(
        clauses
            .into_iter()
            .map(|clause| (Occur::Should, clause))
            .collect(),
    )
}

/// The scopes' hits in turns, own project first, cut to the kept depth: the app's merge of ranks.
fn ranked(found: &[TopK]) -> Vec<u64> {
    let lists: Vec<Vec<u64>> = found
        .iter()
        .map(|found| found.hits.iter().map(|hit| hit.seq).collect())
        .collect();
    let longest = lists.iter().map(Vec::len).max().unwrap_or(0);
    (0..longest)
        .flat_map(|rank| lists.iter().filter_map(move |list| list.get(rank).copied()))
        .take(KEPT)
        .collect()
}

fn ranked_ids<'a>(seqs: &[u64], id_of: &'a HashMap<u64, String>) -> Vec<&'a str> {
    seqs.iter()
        .filter_map(|seq| id_of.get(seq).map(String::as_str))
        .collect()
}

/// Runs `search` `repeat` times and keeps the last run's time in milliseconds and result.
fn timed<T>(repeat: usize, mut search: impl FnMut() -> Result<T>) -> Result<(f64, T)> {
    let mut once = || -> Result<(f64, T)> {
        let started = Instant::now();
        let value = search()?;
        Ok((ms_since(started), value))
    };
    let first = once()?;
    (1..repeat).try_fold(first, |_, _| once())
}

/// Timings and pruning of one way of searching, over all items.
#[derive(Default)]
struct Timing {
    ms: Vec<f64>,
    offered: u64,
    matched: u64,
    /// Items whose ranks were checked against tv-lexical's; those that kept other documents of the
    /// same scores, as ties at the last kept score; and those whose scores differ.
    compared: u64,
    ties: u64,
    differs: u64,
    /// Where each item with other scores first differs: its id, scope and rank, and both scores.
    first_differences: Vec<String>,
}

impl Timing {
    fn add(&mut self, ms: f64, found: &[TopK]) {
        self.ms.push(ms);
        self.offered += found.iter().map(|found| found.offered).sum::<u64>();
    }

    /// Adds a search of the lexical query of `terms` terms and checks it against `expected`,
    /// tv-lexical's. Block-WAND keeps a document only if it beats the last kept score, so of equal
    /// scores at the end it keeps the first visited; the others keep the lowest seq. Scores summed
    /// in another order may differ in their last bits, so they are equal within `terms` f32 ulps.
    fn compare(&mut self, item: &str, ms: f64, found: Vec<TopK>, expected: &[TopK], terms: usize) {
        self.add(ms, &found);
        self.compared += 1;
        let close = |a: Score, b: Score| {
            (a - b).abs() <= terms as Score * Score::EPSILON * a.abs().max(b.abs())
        };
        let score = |hit: Option<&Hit>| {
            hit.map_or("none".to_string(), |hit| {
                format!("{} (seq {})", hit.score, hit.seq)
            })
        };
        let first_difference =
            found
                .iter()
                .zip(expected)
                .enumerate()
                .find_map(|(scope, (found, expected))| {
                    (0..found.hits.len().max(expected.hits.len()))
                        .find(
                            |&rank| match (found.hits.get(rank), expected.hits.get(rank)) {
                                (Some(found), Some(expected)) => {
                                    !close(found.score, expected.score)
                                }
                                _ => true,
                            },
                        )
                        .map(|rank| {
                            format!(
                                "{item} scope {scope} rank {rank}: {} vs {}",
                                score(found.hits.get(rank)),
                                score(expected.hits.get(rank))
                            )
                        })
                });
        match (first_difference, ranked(&found) == ranked(expected)) {
            (Some(difference), _) => {
                self.differs += 1;
                self.first_differences.push(difference);
            }
            (None, false) => self.ties += 1,
            (None, true) => {}
        }
    }
}

fn percentile(values: &[f64], p: f64) -> f64 {
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    sorted
        .get(((sorted.len().max(1) - 1) as f64 * p).round() as usize)
        .copied()
        .unwrap_or(0.0)
}

fn query(copy: &Path, repeat: usize) -> Result<()> {
    let set = copy.join("search-set");
    let root = copy.join("tantivy");
    let db = database(copy)?;
    let (numbers, excluded) = projects(&db)?;
    let id_of: HashMap<u64, String> = db
        .prepare("SELECT seq, id FROM nodes")?
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)? as u64, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let items: Vec<Item> = read_rows(&set.join("items.jsonl"))?;
    let needs: HashMap<String, Need> = read_rows::<Need>(&set.join("needs.jsonl"))?
        .into_iter()
        .map(|need| (need.need.clone(), need))
        .collect();
    let terms: HashMap<String, QueryTerms> =
        read_rows::<QueryTerms>(&set.join("query-terms.jsonl"))?
            .into_iter()
            .map(|terms| (terms.item.clone(), terms))
            .collect();

    let global = open(&root.join("global"), Kind::Global)?;
    let prefixed = open(&root.join("prefixed"), Kind::Prefixed)?;
    let per_project: HashMap<u64, Opened> = fs::read_dir(root.join("project"))?
        .map(|entry| -> Result<(u64, Opened)> {
            let path = entry?.path();
            let number = path
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or("an unreadable index name")?
                .parse()?;
            Ok((number, open(&path, Kind::Project)?))
        })
        .collect::<Result<_>>()?;
    let summed = Summed(per_project.values().map(|index| &index.searcher).collect());
    // Scoring reads only the schema from the searcher it is given, and every project index has the same.
    let any_project = &per_project
        .values()
        .next()
        .ok_or("no project indexes")?
        .searcher;
    println!(
        "items {}; global {} segments; prefixed {} segments; project indexes {}",
        items.len(),
        global.searcher.segment_readers().len(),
        prefixed.searcher.segment_readers().len(),
        per_project.len()
    );

    let mut words = words_analyzer();
    let mut trigrams = trigram_analyzer();
    let lindera = Lindera::new()?;
    let runs: HashMap<&str, fs::File> = [
        "tv-words",
        "tv-morph",
        "tv-morph-all",
        "tv-lindera",
        "tv-lexical",
        "tv-ngram",
    ]
    .into_iter()
    .map(|name| {
        Ok((
            name,
            fs::File::create(set.join("runs").join(format!("{name}.jsonl")))?,
        ))
    })
    .collect::<Result<_>>()?;
    let mut timings: HashMap<&str, Timing> = HashMap::new();
    let all_projects: Vec<u64> = (0..numbers.len() as u64).collect();
    let everyone = |_: u64| true;

    let started = Instant::now();
    for (done, item) in items.iter().enumerate() {
        if done % 100 == 0 {
            eprintln!("{done} items in {:.0} s", ms_since(started) / 1000.0);
        }
        let (Some(need), Some(item_terms)) = (needs.get(&item.need), terms.get(&item.item)) else {
            continue;
        };
        let Some(&own) = numbers.get(&need.project_id) else {
            continue;
        };
        let before = need.before_seq.map(|before| before as u64);
        let own_scope = |project: u64| project == own;
        let other_scope = |project: u64| project != own && !excluded.contains(&project);
        let scopes: Vec<&dyn Fn(u64) -> bool> = if need.cross_project {
            vec![&own_scope, &other_scope]
        } else {
            vec![&own_scope]
        };
        let readable: Vec<Vec<u64>> = scopes
            .iter()
            .map(|allowed| {
                all_projects
                    .iter()
                    .copied()
                    .filter(|project| allowed(*project))
                    .collect()
            })
            .collect();

        let word_terms = dedupe(tokens(&mut words, &item.query));
        let capped_morph = dedupe(
            item_terms
                .morph
                .iter()
                .flat_map(|term| tokens(&mut words, term)),
        );
        let all_morph = dedupe(
            item_terms
                .morph_all
                .iter()
                .flat_map(|term| tokens(&mut words, term)),
        );
        // Lindera's terms of the question, as Kiwi's are made in the app (terms.ts) and timed alike.
        let analyzing = Instant::now();
        let lindera_terms = dedupe(
            lindera
                .terms(&item.query)?
                .iter()
                .flat_map(|term| tokens(&mut words, term)),
        );
        timings
            .entry("lindera question terms")
            .or_default()
            .ms
            .push(ms_since(analyzing));
        let grams: Vec<Vec<String>> = item_terms
            .trigram
            .iter()
            .map(|term| tokens(&mut trigrams, term))
            .filter(|grams| !grams.is_empty())
            .collect();
        // Every index has the same fields, so the global index's serve them all.
        let fields = global.fields;
        let lexical = || {
            joined(
                term_queries(fields.words, &word_terms),
                term_queries(fields.morph, &all_morph),
            )
        };

        // The global index, the project filtered while collecting: the runs the set scores.
        let searches: [(&str, Vec<Box<dyn Query>>); 6] = [
            ("tv-words", term_queries(fields.words, &word_terms)),
            ("tv-morph", term_queries(fields.morph, &capped_morph)),
            // Kiwi's and Lindera's terms, each uncapped, on their own fields.
            ("tv-morph-all", term_queries(fields.morph, &all_morph)),
            ("tv-lindera", term_queries(fields.lindera, &lindera_terms)),
            ("tv-lexical", lexical()),
            (
                "tv-ngram",
                grams
                    .iter()
                    .map(|grams| gram_phrase(fields.ngram, grams))
                    .collect(),
            ),
        ];
        let ranks: HashMap<&str, Vec<TopK>> = searches
            .into_iter()
            .map(|(name, clauses)| -> Result<(&str, Vec<TopK>)> {
                if clauses.is_empty() {
                    return Ok((name, vec![]));
                }
                let query = should(clauses);
                let (ms, (weight, found)) = timed(repeat, || {
                    let weight =
                        query.weight(EnableScoring::enabled_from_searcher(&global.searcher))?;
                    let found = scopes
                        .iter()
                        .map(|allowed| {
                            top_k(
                                global.searcher.segment_readers(),
                                weight.as_ref(),
                                Visit::Pruned,
                                Best::new(*allowed, before),
                            )
                        })
                        .collect::<Result<Vec<_>>>()?;
                    Ok((weight, found))
                })?;
                let timing = timings.entry(name).or_default();
                timing.add(ms, &found);
                timing.matched += scopes.len() as u64 * matched(&global.searcher, weight.as_ref())?;
                Ok((name, found))
            })
            .collect::<Result<_>>()?;
        for (name, found) in &ranks {
            write_row(&runs[name], &item.item, ranked_ids(&ranked(found), &id_of))?;
        }

        // The lexical query searched the other ways, timed, its ranks checked against tv-lexical's.
        let expected = &ranks["tv-lexical"];
        if word_terms.is_empty() && all_morph.is_empty() {
            continue;
        }
        let query = should(lexical());
        let lexical_terms = word_terms.len() + all_morph.len();

        // One index per project, scored with the summed statistics, pruned and with every match scored.
        for (name, visit) in [
            ("tv-lexical per-project", Visit::Pruned),
            ("tv-lexical per-project exhaustive", Visit::Every),
        ] {
            let (ms, found) = timed(repeat, || {
                let weight = query.weight(EnableScoring::enabled_from_statistics_provider(
                    &summed,
                    any_project,
                ))?;
                readable
                    .iter()
                    .map(|scope| {
                        let segments = scope
                            .iter()
                            .filter_map(|project| per_project.get(project))
                            .flat_map(|index| index.searcher.segment_readers());
                        top_k(
                            segments,
                            weight.as_ref(),
                            visit,
                            Best::new(&everyone, before),
                        )
                    })
                    .collect::<Result<Vec<_>>>()
            })?;
            timings.entry(name).or_default().compare(
                &item.item,
                ms,
                found,
                expected,
                lexical_terms,
            );
        }

        // The own project on its index, nothing filtered; the other projects on the global index.
        let own_segments = per_project
            .get(&own)
            .map_or(&[][..], |index| index.searcher.segment_readers());
        let (ms, found) = timed(repeat, || {
            let weight = query.weight(EnableScoring::enabled_from_searcher(&global.searcher))?;
            let own_found = top_k(
                own_segments,
                weight.as_ref(),
                Visit::Pruned,
                Best::new(&everyone, before),
            )?;
            let others = need
                .cross_project
                .then(|| {
                    top_k(
                        global.searcher.segment_readers(),
                        weight.as_ref(),
                        Visit::Pruned,
                        Best::new(&other_scope, before),
                    )
                })
                .transpose()?;
            Ok([Some(own_found), others]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>())
        })?;
        timings.entry("tv-lexical hybrid").or_default().compare(
            &item.item,
            ms,
            found,
            expected,
            lexical_terms,
        );

        // The global index with every match scored.
        let (ms, found) = timed(repeat, || {
            let weight = query.weight(EnableScoring::enabled_from_searcher(&global.searcher))?;
            scopes
                .iter()
                .map(|allowed| {
                    top_k(
                        global.searcher.segment_readers(),
                        weight.as_ref(),
                        Visit::Every,
                        Best::new(*allowed, before),
                    )
                })
                .collect::<Result<Vec<_>>>()
        })?;
        timings.entry("tv-lexical exhaustive").or_default().compare(
            &item.item,
            ms,
            found,
            expected,
            lexical_terms,
        );

        // One index of prefixed terms, a term per project in the scope. Timed only: each project's
        // term has its own statistics, so it does not rank as tv-lexical does.
        let prefixed_fields = prefixed.fields;
        let (ms, found) = timed(repeat, || {
            readable
                .iter()
                .map(|scope| {
                    let named = |values: &[String]| -> Vec<String> {
                        scope
                            .iter()
                            .flat_map(|project| {
                                values.iter().map(move |value| format!("{project}_{value}"))
                            })
                            .collect()
                    };
                    let clauses = joined(
                        term_queries(prefixed_fields.words, &named(&word_terms)),
                        term_queries(prefixed_fields.morph, &named(&all_morph)),
                    );
                    let weight = should(clauses)
                        .weight(EnableScoring::enabled_from_searcher(&prefixed.searcher))?;
                    top_k(
                        prefixed.searcher.segment_readers(),
                        weight.as_ref(),
                        Visit::Pruned,
                        Best::new(&everyone, before),
                    )
                })
                .collect::<Result<Vec<_>>>()
        })?;
        timings
            .entry("tv-lexical prefixed")
            .or_default()
            .add(ms, &found);
    }

    println!(
        "| search | items | p50 ms | p95 ms | max ms | mean ms | over {APP_BUDGET_MS} ms | offered / item | matched / item | vs tv-lexical: ties, other scores |"
    );
    println!("|---|---|---|---|---|---|---|---|---|---|");
    let mut names: Vec<&str> = timings.keys().copied().collect();
    names.sort();
    for name in names {
        let timing = &timings[name];
        let count = timing.ms.len().max(1) as f64;
        let per_item = |total: u64| {
            if total == 0 {
                "-".to_string()
            } else {
                format!("{:.0}", total as f64 / count)
            }
        };
        let differs = if timing.compared == 0 {
            "-".to_string()
        } else {
            format!("{}, {} of {}", timing.ties, timing.differs, timing.compared)
        };
        println!(
            "| {name} | {} | {:.1} | {:.1} | {:.1} | {:.1} | {} | {} | {} | {differs} |",
            timing.ms.len(),
            percentile(&timing.ms, 0.5),
            percentile(&timing.ms, 0.95),
            percentile(&timing.ms, 1.0),
            timing.ms.iter().sum::<f64>() / count,
            timing.ms.iter().filter(|ms| **ms > APP_BUDGET_MS).count(),
            per_item(timing.offered),
            per_item(timing.matched),
        );
    }
    for (name, timing) in &timings {
        for difference in &timing.first_differences {
            println!("{name}: {difference}");
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let repeat = match args.iter().position(|arg| arg == "--repeat") {
        Some(at) => args.get(at + 1).ok_or("--repeat needs a count")?.parse()?,
        None => 1,
    };
    match (args.first().map(String::as_str), args.get(1)) {
        (Some("build"), Some(copy)) => build(&PathBuf::from(copy)),
        (Some("query"), Some(copy)) => query(&PathBuf::from(copy), repeat),
        _ => Err("usage: tantivy-bench build|query <copy> [--repeat N]".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::Lindera;

    #[test]
    fn lindera_terms_follow_kiwi_rules() {
        let lindera = Lindera::new().unwrap();
        let terms = lindera
            .terms("메모리 검색엔진을 Tantivy로 바꿨고 drizzle-kit도 있었다")
            .unwrap();
        println!("{terms:?}");
        for expected in [
            "메모리",
            "검색",
            "엔진",
            "검색엔진",
            "바꾸",
            "tantivy",
            "drizzle",
            "kit",
        ] {
            assert!(
                terms.contains(&expected.to_string()),
                "{expected} in {terms:?}"
            );
        }
        assert!(!terms.contains(&"있".to_string()));
    }
}
