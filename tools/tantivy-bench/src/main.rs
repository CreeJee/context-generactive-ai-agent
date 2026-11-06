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
//! One index of every node but the suppressed ones, with fields `morph` (the Kiwi terms FTS5's
//! nodes_morph holds, split into letters and digits and lowercased), `ngram` (lowercased
//! three-character grams with positions, as FTS5's trigram, so a term is searched as the phrase of
//! its grams), `lindera` (terms made by Kiwi's rules from Lindera's ko-dic morphemes) and
//! `lindera_stop` (the same morphemes less Lucene Nori's default stop tags), the two Lindera fields
//! for the nodes Kiwi analyzed. The project and seq are fast fields, filtered while collecting.
//!
//! Every matching document is scored. The queries are unions of many terms, which Block-WAND top-k
//! pruning barely cuts: measured, it scored about half the matches and was slower for its cost per
//! document. Scoring every match is also exact whatever the filter drops. Per-project and
//! project-prefixed indexes were measured too and left out (docs/memory-search-measurements.md).

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
use tantivy::query::{BooleanQuery, EnableScoring, Occur, PhraseQuery, Query, TermQuery, Weight};
use tantivy::schema::{
    Field, IndexRecordOption, NumericOptions, Schema, SchemaBuilder, TextFieldIndexing, TextOptions,
};
use tantivy::tokenizer::{
    LowerCaser, RemoveLongFilter, SimpleTokenizer, TextAnalyzer, Token, TokenStream, Tokenizer,
};
use tantivy::{DocId, Index, IndexWriter, ReloadPolicy, Score, Searcher, TantivyDocument, Term};
use unicode_normalization::UnicodeNormalization;

type Error = Box<dyn std::error::Error>;
type Result<T> = std::result::Result<T, Error>;

/// Ids asked of every scope and kept per item, as the search set's pool does.
const DEPTH: usize = 40;
const KEPT: usize = 30;
/// The runs `query` writes to the search set.
const RUNS: [&str; 4] = ["tv-morph-all", "tv-lindera", "tv-lindera-stop", "tv-ngram"];
/// Tokens longer than this many bytes are blobs (hashes, base64), not words.
const LONGEST_TOKEN: usize = 64;
const WRITER_THREADS: usize = 2;
const WRITER_HEAP: usize = 1 << 30;
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

/// Lucene Nori's default stop tags (KoreanPartOfSpeechStopFilter.DEFAULT_STOP_TAGS), as ko-dic
/// writes them: interjections, adverbs, determiners, affixes, spaces and unknowns. Nori also stops
/// every ending (E*) and particle (J*), and its tokenizer drops punctuation, here the symbol tags.
const STOP_TAGS: [&str; 13] = [
    "IC", "MAG", "MAJ", "MM", "SP", "XPN", "XSA", "XSN", "XSV", "UNA", "NA", "VSV", "UNKNOWN",
];
const STOP_TAG_PREFIXES: [&str; 2] = ["E", "J"];
const PUNCTUATION_TAGS: [&str; 6] = ["SF", "SE", "SSO", "SSC", "SC", "SY"];

/// A text after NFKC, and its ko-dic morphemes.
struct Analyzed {
    text: String,
    morphemes: Vec<Morpheme>,
}

/// One ko-dic morpheme, and whether it follows the one before with no space between.
struct Morpheme {
    surface: String,
    tag: String,
    joined: bool,
}

/// Search terms from Lindera's ko-dic morphemes, to see whether Lindera can stand in for Kiwi. The
/// text is NFKC-normalized first and every term lowercased. An inflected, compound or pre-analyzed
/// token is split into its morphemes first: ko-dic gives it one fused tag (`VV+EP`), which a tag
/// filter cannot sort into stem and ending.
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

    fn analyze(&self, input: &str) -> Result<Analyzed> {
        let text: String = input.nfkc().collect();
        let morphemes = self.morphemes(&text)?;
        Ok(Analyzed { text, morphemes })
    }

    /// By Kiwi's rules (packages/memory-agent/src/memory/morph/kiwi-worker.ts): its kept tags
    /// except the light stems, a run of nouns written without spaces also as one term, and Latin
    /// words and numbers taken from the text itself.
    fn terms(&self, analyzed: &Analyzed) -> Vec<String> {
        let mut terms = Vec::new();
        let mut run: Vec<String> = Vec::new();
        for morpheme in &analyzed.morphemes {
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
                run.push(morpheme.surface.clone());
            }
        }
        if run.len() > 1 {
            terms.push(run.concat());
        }
        terms.extend(
            self.latin_or_number
                .find_iter(&analyzed.text)
                .map(|found| found.as_str().to_string()),
        );
        terms.into_iter().map(|term| term.to_lowercase()).collect()
    }

    /// Every morpheme but those of Nori's default stop tags and punctuation, compounds as their
    /// parts (Nori's default `discard` decompounding).
    fn stop_tag_terms(analyzed: &Analyzed) -> Vec<String> {
        analyzed
            .morphemes
            .iter()
            .filter(|morpheme| {
                let tag = morpheme.tag.as_str();
                !STOP_TAGS.contains(&tag)
                    && !PUNCTUATION_TAGS.contains(&tag)
                    && !STOP_TAG_PREFIXES
                        .iter()
                        .any(|prefix| tag.starts_with(prefix))
            })
            .map(|morpheme| morpheme.surface.to_lowercase())
            .collect()
    }
}

fn dedupe(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.clone()))
        .collect()
}

#[derive(Clone, Copy)]
struct Fields {
    seq: Field,
    project: Field,
    morph: Field,
    ngram: Field,
    lindera: Field,
    lindera_stop: Field,
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

fn schema() -> (Schema, Fields) {
    let mut builder = Schema::builder();
    let numeric = NumericOptions::default().set_fast().set_indexed();
    let seq = builder.add_u64_field("seq", numeric.clone());
    let project = builder.add_u64_field("project", numeric);
    let morph = text_field(&mut builder, "morph", "words", IndexRecordOption::WithFreqs);
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
    let lindera_stop = text_field(
        &mut builder,
        "lindera_stop",
        "words",
        IndexRecordOption::WithFreqs,
    );
    (
        builder.build(),
        Fields {
            seq,
            project,
            morph,
            ngram,
            lindera,
            lindera_stop,
        },
    )
}

fn register(index: &Index) {
    index.tokenizers().register("words", words_analyzer());
    index.tokenizers().register("trigram", trigram_analyzer());
}

fn create(dir: &Path) -> Result<(Index, Fields)> {
    if dir.exists() {
        fs::remove_dir_all(dir)?;
    }
    fs::create_dir_all(dir)?;
    let (schema, fields) = schema();
    let index = Index::create_in_dir(dir, schema)?;
    register(&index);
    Ok((index, fields))
}

/// An index opened for searching, with its fields.
struct Opened {
    fields: Fields,
    searcher: Searcher,
}

fn open(dir: &Path) -> Result<Opened> {
    let index = Index::open_in_dir(dir)?;
    register(&index);
    let reader = index
        .reader_builder()
        .reload_policy(ReloadPolicy::Manual)
        .try_into()?;
    Ok(Opened {
        fields: schema().1,
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

/// Visits every node that is not suppressed, in seq order.
fn each_node(db: &Connection, mut visit: impl FnMut(Node) -> Result<()>) -> Result<()> {
    let (numbers, _) = projects(db)?;
    let mut statement = db.prepare(&format!(
        "SELECT n.seq, n.project_id, n.text, coalesce(m.c0, ''), m.id IS NOT NULL FROM nodes n
         LEFT JOIN nodes_morph_content m ON m.id = n.seq WHERE {NOT_SUPPRESSED} ORDER BY n.seq"
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

/// A node's Lindera terms, each list joined by spaces.
#[derive(Default)]
struct LinderaText {
    kiwi_rules: String,
    stop_tags: String,
}

fn document(fields: Fields, node: &Node, lindera: &LinderaText) -> TantivyDocument {
    let mut doc = TantivyDocument::new();
    doc.add_u64(fields.seq, node.seq);
    doc.add_u64(fields.project, node.project);
    doc.add_text(fields.morph, &node.morph);
    doc.add_text(fields.ngram, &node.text);
    doc.add_text(fields.lindera, &lindera.kiwi_rules);
    doc.add_text(fields.lindera_stop, &lindera.stop_tags);
    doc
}

fn build(copy: &Path) -> Result<()> {
    let db = database(copy)?;
    let dir = copy.join("tantivy");
    let lindera = Lindera::new()?;
    let started = Instant::now();
    let (index, fields) = create(&dir)?;
    let mut writer: IndexWriter = index.writer_with_num_threads(WRITER_THREADS, WRITER_HEAP)?;
    let mut count = 0u64;
    // Lindera's share of the build: the nodes it analyzed, their characters and its time.
    let (mut analyzed_nodes, mut characters, mut lindera_ms) = (0u64, 0u64, 0f64);
    each_node(&db, |node| {
        count += 1;
        let terms = if node.analyzed {
            let analyzing = Instant::now();
            let analyzed = lindera.analyze(&node.text)?;
            let terms = LinderaText {
                kiwi_rules: lindera.terms(&analyzed).join(" "),
                stop_tags: Lindera::stop_tag_terms(&analyzed).join(" "),
            };
            lindera_ms += ms_since(analyzing);
            analyzed_nodes += 1;
            characters += node.text.chars().count() as u64;
            terms
        } else {
            LinderaText::default()
        };
        writer.add_document(document(fields, &node, &terms))?;
        Ok(())
    })?;
    println!(
        "lindera: {analyzed_nodes} nodes, {characters} characters in {:.1} s",
        lindera_ms / 1000.0
    );
    writer.commit()?;
    writer.wait_merging_threads()?;
    println!(
        "index: {count} nodes in {:.1} s, {}, {} segments",
        ms_since(started) / 1000.0,
        megabytes(&dir),
        index.searchable_segment_ids()?.len()
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

/// What one top-k search found, best first, and how many matching documents it scored.
struct TopK {
    hits: Vec<Hit>,
    scored: u64,
}

/// The best `DEPTH` documents a search scores whose project is `allowed` and whose seq is below
/// `before`.
struct Best<'a> {
    allowed: &'a dyn Fn(u64) -> bool,
    before: Option<u64>,
    heap: BinaryHeap<Hit>,
    scored: u64,
}

impl<'a> Best<'a> {
    fn new(allowed: &'a dyn Fn(u64) -> bool, before: Option<u64>) -> Self {
        Best {
            allowed,
            before,
            heap: BinaryHeap::new(),
            scored: 0,
        }
    }

    /// Keeps the document if it is allowed and among the best `DEPTH`; of equal scores at the end,
    /// the lower seqs are kept.
    fn offer(&mut self, project: u64, seq: u64, score: Score) {
        self.scored += 1;
        if (self.allowed)(project) && self.before.is_none_or(|before| seq < before) {
            self.heap.push(Hit { score, seq });
            if self.heap.len() > DEPTH {
                self.heap.pop();
            }
        }
    }

    fn found(self) -> TopK {
        TopK {
            hits: self.heap.into_sorted_vec(),
            scored: self.scored,
        }
    }
}

/// The best documents of the query, every matching document scored.
fn top_k(searcher: &Searcher, weight: &dyn Weight, mut best: Best) -> Result<TopK> {
    for segment in searcher.segment_readers() {
        let seqs = segment.fast_fields().u64("seq")?;
        let projects = segment.fast_fields().u64("project")?;
        weight.for_each(segment, &mut |doc: DocId, score: Score| {
            best.offer(
                projects.first(doc).unwrap_or(u64::MAX),
                seqs.first(doc).unwrap_or(u64::MAX),
                score,
            )
        })?;
    }
    Ok(best.found())
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

/// Timings of one search over all items, and the matching documents it scored.
#[derive(Default)]
struct Timing {
    ms: Vec<f64>,
    scored: u64,
}

impl Timing {
    fn add(&mut self, ms: f64, found: &[TopK]) {
        self.ms.push(ms);
        self.scored += found.iter().map(|found| found.scored).sum::<u64>();
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

    let index = open(&copy.join("tantivy"))?;
    println!(
        "items {}; {} segments",
        items.len(),
        index.searcher.segment_readers().len()
    );

    let mut words = words_analyzer();
    let mut trigrams = trigram_analyzer();
    let lindera = Lindera::new()?;
    let runs: HashMap<&str, fs::File> = RUNS
        .into_iter()
        .map(|name| {
            Ok((
                name,
                fs::File::create(set.join("runs").join(format!("{name}.jsonl")))?,
            ))
        })
        .collect::<Result<_>>()?;
    let mut timings: HashMap<&str, Timing> = HashMap::new();

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

        let mut split = |terms: &[String]| {
            dedupe(
                terms
                    .iter()
                    .flat_map(|term| tokens(&mut words, term))
                    .collect::<Vec<_>>(),
            )
        };
        let kiwi_terms = split(&item_terms.morph_all);
        // Lindera's terms of the question, both ways, timed together.
        let analyzing = Instant::now();
        let analyzed = lindera.analyze(&item.query)?;
        let lindera_terms = split(&lindera.terms(&analyzed));
        let stop_tag_terms = split(&Lindera::stop_tag_terms(&analyzed));
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
        let fields = index.fields;

        // Kiwi's and Lindera's terms, each uncapped, on their own fields, and the trigram phrases.
        let searches: [(&str, Vec<Box<dyn Query>>); RUNS.len()] = [
            ("tv-morph-all", term_queries(fields.morph, &kiwi_terms)),
            ("tv-lindera", term_queries(fields.lindera, &lindera_terms)),
            (
                "tv-lindera-stop",
                term_queries(fields.lindera_stop, &stop_tag_terms),
            ),
            (
                "tv-ngram",
                grams
                    .iter()
                    .map(|grams| gram_phrase(fields.ngram, grams))
                    .collect(),
            ),
        ];
        for (name, clauses) in searches {
            if clauses.is_empty() {
                write_row(&runs[name], &item.item, vec![])?;
                continue;
            }
            let query = should(clauses);
            let (ms, found) = timed(repeat, || {
                let weight = query.weight(EnableScoring::enabled_from_searcher(&index.searcher))?;
                scopes
                    .iter()
                    .map(|allowed| {
                        top_k(
                            &index.searcher,
                            weight.as_ref(),
                            Best::new(*allowed, before),
                        )
                    })
                    .collect::<Result<Vec<_>>>()
            })?;
            timings.entry(name).or_default().add(ms, &found);
            write_row(&runs[name], &item.item, ranked_ids(&ranked(&found), &id_of))?;
        }
    }

    println!(
        "| search | items | p50 ms | p95 ms | max ms | mean ms | over {APP_BUDGET_MS} ms | scored / item |"
    );
    println!("|---|---|---|---|---|---|---|---|");
    let mut names: Vec<&str> = timings.keys().copied().collect();
    names.sort();
    for name in names {
        let timing = &timings[name];
        let count = timing.ms.len().max(1) as f64;
        let scored = match timing.scored {
            0 => "-".to_string(),
            total => format!("{:.0}", total as f64 / count),
        };
        println!(
            "| {name} | {} | {:.1} | {:.1} | {:.1} | {:.1} | {} | {scored} |",
            timing.ms.len(),
            percentile(&timing.ms, 0.5),
            percentile(&timing.ms, 0.95),
            percentile(&timing.ms, 1.0),
            timing.ms.iter().sum::<f64>() / count,
            timing.ms.iter().filter(|ms| **ms > APP_BUDGET_MS).count(),
        );
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
    use std::borrow::Cow;

    use super::Lindera;

    /// ko-dic gives an inflected word as one token whose tag is fused (`VV+EC`), so a filter that
    /// compares the first tag, as lindera's korean_stop_tags does, neither keeps its stem nor drops
    /// its ending; the morphemes are in the expression detail.
    #[test]
    fn inflected_words_are_one_token_with_a_fused_tag() {
        let lindera = Lindera::new().unwrap();
        let mut tokens = lindera
            .segmenter
            .segment(Cow::Borrowed("바꿨고 있었다"))
            .unwrap();
        let details: Vec<(String, String, String)> = tokens
            .iter_mut()
            .map(|token| {
                let surface = token.surface.to_string();
                let details = token.details();
                (surface, details[0].to_string(), details[7].to_string())
            })
            .collect();
        println!("{details:?}");
        assert!(
            details.iter().any(|(_, tag, _)| tag.contains('+')),
            "{details:?}"
        );
    }

    #[test]
    fn lindera_terms_follow_kiwi_rules() {
        let lindera = Lindera::new().unwrap();
        let analyzed = lindera
            .analyze("메모리 검색엔진을 Tantivy로 바꿨고 drizzle-kit도 있었다")
            .unwrap();
        let terms = lindera.terms(&analyzed);
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

    #[test]
    fn stop_tag_terms_drop_particles_endings_and_punctuation() {
        let lindera = Lindera::new().unwrap();
        let analyzed = lindera
            .analyze("메모리 검색엔진을 Tantivy로 바꿨고 drizzle-kit도 있었다")
            .unwrap();
        let terms = Lindera::stop_tag_terms(&analyzed);
        println!("{terms:?}");
        for expected in [
            "메모리",
            "검색",
            "엔진",
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
        for stopped in ["을", "로", "고", "도", "었", "다", "-"] {
            assert!(
                !terms.contains(&stopped.to_string()),
                "{stopped} in {terms:?}"
            );
        }
    }
}
