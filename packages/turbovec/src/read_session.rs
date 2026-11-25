//! Read-only seed ranking. Host owns authorization and index publication serialization.
use crate::{
    lexical::{LexicalIndex, Scope},
    owners::Holder,
    search_control::{admitted, claim, Outcome},
    VectorIndex,
};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use rusqlite::{params_from_iter, types::Value, Connection, OpenFlags};
use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
const MAX_BYTES: usize = 1_048_576;
/// What the text stage leaves of the read's budget for the morph stage. Past that point the
/// text matches are dropped (`text_unavailable`) and the read goes on, instead of the whole read
/// failing on a slow text query (docs/decisions.md, 2026-10-30).
const TEXT_RESERVE: Duration = Duration::from_millis(600);
// The lexical index holds a node as it was when its last journaled change was applied; a change
// still pending means the index may hold text, a project or a node this snapshot no longer has.
// Blank and suppressed nodes need no check here: the indexer leaves them out, and suppressing or
// restoring a node is journaled like any change.
const LEXICAL_CURRENT: &str =
    "NOT EXISTS (SELECT 1 FROM lexical_changes c WHERE c.node_seq = n.seq)";
/// How many lexical hits a channel asks for, per hit it keeps: hits the snapshot drops (a change
/// not yet applied, a suppressed node) leave room for the next ones.
const LEXICAL_DEPTH: usize = 2;
/// The first chunk vector id (`node_vector_chunks`' CHECK); a vector id below it is its node's seq.
const CHUNK_VECTOR_ID_FLOOR: u64 = 1 << 52;
/// Ids per statement when reading owners: well below SQLite's bound on variables.
const OWNER_IDS_PER_STATEMENT: usize = 1000;
#[napi(object)]
pub struct NativeReadInput {
    pub allowed_projects: Vec<String>,
    pub embedder: String,
    pub query: Option<Float32Array>,
    pub trigram_terms: Vec<String>,
    pub short_terms: Vec<String>,
    /// The question, split into morph terms by the lexical index's own analysis.
    pub morph_query: String,
    /// Only nodes stored before this seq are read: what memory held when that node was stored.
    pub before_seq: Option<i64>,
    pub vector_k: u32,
    pub text_k: u32,
    pub morph_k: u32,
    pub text_enabled: bool,
    pub morph_enabled: bool,
    pub remaining_ms: f64,
    pub input_budget_bytes: u32,
    pub output_budget_bytes: u32,
}
#[napi(object)]
pub struct NativeReadOutput {
    pub kind: String,
    pub vector_ids: Vec<String>,
    pub vector_seqs: Vec<String>,
    pub vector_scores: Vec<f64>,
    /// Only vector engine failure degrades this channel; control/SQLite failures remain atomic.
    pub vector_unavailable: bool,
    /// The text stage ran past its share of the budget; its matches were dropped and the read
    /// went on. `text_ms` is how long it ran.
    pub text_unavailable: bool,
    pub text_ids: Vec<String>,
    pub morph_ids: Vec<String>,
    pub candidate_count: u32,
    pub sqlite_executions: u32,
    pub candidate_ms: f64,
    pub vector_ms: f64,
    pub text_ms: f64,
    pub morph_ms: f64,
    pub mapping_ms: f64,
    /// From the host registering the request (which starts its deadline) to this worker claiming it.
    pub queue_ms: f64,
    /// The trigram query inside the text stage; none when it did not run or did not finish.
    pub trigram_ms: Option<f64>,
    /// The finished short-term queries inside the text stage: their total, slowest and count.
    /// On a failure in the text stage, the query that was running is the rest of `text_ms`.
    pub short_term_ms: f64,
    pub short_term_max_ms: f64,
    pub short_terms_done: u32,
    /// The stage a failed read stopped in; none when it succeeded or failed before reading.
    pub failed_stage: Option<String>,
    pub input_logical_bytes: u32,
    pub output_logical_bytes: u32,
}
/// The stage a read is in, so a failed read still says where its time went.
#[derive(Clone, Copy)]
enum Stage {
    Candidate,
    Vector,
    Mapping,
    Text,
    Morph,
}
impl Stage {
    fn name(self) -> &'static str {
        match self {
            Stage::Candidate => "candidate",
            Stage::Vector => "vector",
            Stage::Mapping => "mapping",
            Stage::Text => "text",
            Stage::Morph => "morph",
        }
    }
}
impl NativeReadOutput {
    fn empty() -> Self {
        Self {
            kind: Outcome::Success.tag().into(),
            vector_ids: vec![],
            vector_seqs: vec![],
            vector_scores: vec![],
            vector_unavailable: false,
            text_unavailable: false,
            text_ids: vec![],
            morph_ids: vec![],
            candidate_count: 0,
            sqlite_executions: 0,
            candidate_ms: 0.,
            vector_ms: 0.,
            text_ms: 0.,
            morph_ms: 0.,
            mapping_ms: 0.,
            queue_ms: 0.,
            trigram_ms: None,
            short_term_ms: 0.,
            short_term_max_ms: 0.,
            short_terms_done: 0,
            failed_stage: None,
            input_logical_bytes: 0,
            output_logical_bytes: 0,
        }
    }
    fn stage_ms(&mut self, stage: Stage) -> &mut f64 {
        match stage {
            Stage::Candidate => &mut self.candidate_ms,
            Stage::Vector => &mut self.vector_ms,
            Stage::Mapping => &mut self.mapping_ms,
            Stage::Text => &mut self.text_ms,
            Stage::Morph => &mut self.morph_ms,
        }
    }
    /// A failed read carries no hits, only the work it did: the stages that finished
    /// and the one it stopped in, timed up to now.
    fn failure(&self, reason: Outcome, running: (Stage, Instant)) -> Self {
        let mut out = Self {
            kind: reason.tag().into(),
            candidate_count: self.candidate_count,
            sqlite_executions: self.sqlite_executions,
            candidate_ms: self.candidate_ms,
            vector_ms: self.vector_ms,
            text_ms: self.text_ms,
            morph_ms: self.morph_ms,
            mapping_ms: self.mapping_ms,
            queue_ms: self.queue_ms,
            trigram_ms: self.trigram_ms,
            short_term_ms: self.short_term_ms,
            short_term_max_ms: self.short_term_max_ms,
            short_terms_done: self.short_terms_done,
            failed_stage: Some(running.0.name().into()),
            ..Self::empty()
        };
        *out.stage_ms(running.0) = ms(running.1);
        out
    }
    fn bytes(&self) -> usize {
        97 + self.kind.len()
            + self.vector_scores.len() * 8
            + self
                .vector_ids
                .iter()
                .chain(&self.vector_seqs)
                .chain(&self.text_ids)
                .chain(&self.morph_ids)
                .map(String::len)
                .sum::<usize>()
    }
}
// Channel policy boundary: caller checks control first; only engine failure is degraded.
fn record_vector_channel<T, E>(
    out: &mut NativeReadOutput,
    result: std::result::Result<T, E>,
    record: impl FnOnce(T, &mut NativeReadOutput),
) {
    match result {
        Ok(hits) => record(hits, out),
        Err(_) => out.vector_unavailable = true,
    }
}
fn ms(start: Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.
}
fn scope(projects: &[String]) -> String {
    if projects.is_empty() {
        "NULL".into()
    } else {
        vec!["?"; projects.len()].join(",")
    }
}
/// The ids of the `seqs` this snapshot searches as the lexical index holds them: nodes of the
/// allowed projects with no journaled change pending.
fn lexical_ids(
    connection: &Connection,
    seqs: &[u64],
    projects: &[String],
    id_budget: usize,
    check: &dyn Fn() -> std::result::Result<(), Outcome>,
) -> std::result::Result<HashMap<u64, String>, Outcome> {
    let mut ids = HashMap::new();
    if seqs.is_empty() {
        return Ok(ids);
    }
    let sql = format!(
        "SELECT n.seq, n.id FROM nodes n WHERE n.seq IN ({}) AND n.project_id IN ({}) AND {LEXICAL_CURRENT}",
        vec!["?"; seqs.len()].join(","),
        scope(projects)
    );
    let values = seqs
        .iter()
        .map(|seq| Value::Integer(*seq as i64))
        .chain(projects.iter().cloned().map(Value::Text));
    let mut statement = connection.prepare(&sql).map_err(|_| Outcome::ReadFailed)?;
    let mut rows = statement
        .query(params_from_iter(values))
        .map_err(|_| Outcome::ReadFailed)?;
    let mut bytes = 0usize;
    while let Some(row) = rows.next().map_err(|_| Outcome::ReadFailed)? {
        check()?;
        let id = row
            .get_ref(1)
            .map_err(|_| Outcome::ReadFailed)?
            .as_str()
            .map_err(|_| Outcome::ReadFailed)?;
        bytes = bytes.saturating_add(id.len());
        if bytes > id_budget {
            return Err(Outcome::BudgetExceeded);
        }
        let seq: i64 = row.get(0).map_err(|_| Outcome::ReadFailed)?;
        ids.insert(seq as u64, id.to_owned());
    }
    Ok(ids)
}
/// What a read's hits are checked against: its embedder, projects and `before_seq`.
struct Checked<'a> {
    embedder: &'a str,
    projects: &'a [String],
    before_seq: Option<i64>,
}
/// The node ids of the `hits` (vector id, parent seq, score) this snapshot still searches: the
/// vector is the embedder's current one for its parent (a chunk still mapped to it, or a one-vector
/// node's own seq), the parent is in an allowed project and before `before_seq`, and it is not
/// waiting to leave the index. A hit the index holds but the snapshot does not is left out.
fn checked(
    connection: &Connection,
    snapshot: &Checked<'_>,
    hits: &[(u64, u64, f32)],
    check: &dyn Fn() -> std::result::Result<(), Outcome>,
) -> std::result::Result<HashMap<u64, String>, Outcome> {
    let marks = |count: usize| vec!["?"; count].join(",");
    let bounded = if snapshot.before_seq.is_some() {
        " AND n.seq<?"
    } else {
        ""
    };
    let sql = format!(
        "SELECT COALESCE(c.vector_id,n.seq),n.id FROM nodes n JOIN node_vectors v ON v.node_seq=n.seq AND v.embedder=? LEFT JOIN node_vector_chunks c ON c.node_seq=n.seq AND c.embedder=v.embedder AND c.vector_id IN ({}) WHERE n.seq IN ({}) AND n.project_id IN ({}){bounded} AND NOT EXISTS (SELECT 1 FROM memory_graph_vector_removals r WHERE r.node_seq=v.node_seq AND r.embedder=v.embedder)",
        marks(hits.len()),
        marks(hits.len()),
        scope(snapshot.projects)
    );
    let values = std::iter::once(Value::Text(snapshot.embedder.to_owned()))
        .chain(hits.iter().map(|(id, _, _)| Value::Integer(*id as i64)))
        .chain(
            hits.iter()
                .map(|(_, parent, _)| Value::Integer(*parent as i64)),
        )
        .chain(snapshot.projects.iter().cloned().map(Value::Text))
        .chain(snapshot.before_seq.map(Value::Integer));
    let mut statement = connection.prepare(&sql).map_err(|_| Outcome::ReadFailed)?;
    let mut rows = statement
        .query(params_from_iter(values))
        .map_err(|_| Outcome::ReadFailed)?;
    let mut current = HashMap::new();
    while let Some(row) = rows.next().map_err(|_| Outcome::ReadFailed)? {
        check()?;
        let id: i64 = row.get(0).map_err(|_| Outcome::ReadFailed)?;
        let node: String = row.get(1).map_err(|_| Outcome::ReadFailed)?;
        current.insert(id as u64, node);
    }
    Ok(current)
}
/// The first `k` of `seqs` the snapshot kept, as ids.
fn kept(seqs: &[u64], ids: &HashMap<u64, String>, k: usize) -> Vec<String> {
    seqs.iter()
        .filter_map(|seq| ids.get(seq).cloned())
        .take(k)
        .collect()
}
// Explicit completion is required; Drop is only an unwinding fallback.
struct ReadGuard<'a> {
    connection: &'a Connection,
    unusable: &'a std::cell::Cell<bool>,
    finished: bool,
}
impl ReadGuard<'_> {
    fn finish(&mut self) -> bool {
        self.connection.progress_handler(0, None::<fn() -> bool>);
        let clean = (self.connection.is_autocommit()
            || self.connection.execute_batch("ROLLBACK").is_ok())
            && self.connection.is_autocommit();
        if !clean {
            self.unusable.set(true);
        }
        self.finished = true;
        clean
    }
}
impl Drop for ReadGuard<'_> {
    fn drop(&mut self) {
        if !self.finished {
            self.finish();
        }
    }
}
#[napi]
pub struct MemoryReadSession {
    connection: Option<Connection>,
    unusable: std::cell::Cell<bool>,
}
#[napi]
impl MemoryReadSession {
    #[napi(constructor)]
    pub fn new(database_path: String) -> Result<Self> {
        crate::sqlite_bridge::ensure_initialized()?;
        if database_path.is_empty()
            || database_path == ":memory:"
            || database_path.starts_with("file:")
        {
            return Err(Error::from_reason("Invalid read database path"));
        }
        let connection = Connection::open_with_flags(
            database_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| Error::from_reason("Read session unavailable"))?;
        connection
            .execute_batch("PRAGMA query_only=ON")
            .map_err(|_| Error::from_reason("Read session unavailable"))?;
        // The default page cache is ~2MB; reads sweep GB-scale databases, so a larger cache keeps
        // repeated cold reads off disk. mmap avoids page copies for the text scans. Bounded so a
        // shared worker's resident set stays known.
        connection
            .execute_batch("PRAGMA cache_size=-262144; PRAGMA mmap_size=1073741824;")
            .map_err(|_| Error::from_reason("Read session unavailable"))?;
        Ok(Self {
            connection: Some(connection),
            unusable: std::cell::Cell::new(false),
        })
    }
    /// The parent node seq and holder of each of `ids` the database has: a chunk through its
    /// mapping row, a one-vector node through its seq.
    pub(crate) fn owners_of(
        &self,
        ids: &[u64],
    ) -> std::result::Result<Vec<(u64, u64, Holder)>, String> {
        let connection = self
            .connection
            .as_ref()
            .ok_or_else(|| "Read session is closed".to_string())?;
        if self.unusable.get() {
            return Err("Read session is unusable".into());
        }
        let (chunks, seqs): (Vec<u64>, Vec<u64>) =
            ids.iter().partition(|id| **id >= CHUNK_VECTOR_ID_FLOOR);
        let mut found = Vec::with_capacity(ids.len());
        let mut read = |sql: &str, batch: &[u64]| -> std::result::Result<(), String> {
            let sql = sql.replace("{ids}", &vec!["?"; batch.len()].join(","));
            let mut statement = connection.prepare(&sql).map_err(|e| e.to_string())?;
            let mut rows = statement
                .query(params_from_iter(batch.iter().map(|id| *id as i64)))
                .map_err(|e| e.to_string())?;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let id: i64 = row.get(0).map_err(|e| e.to_string())?;
                let parent: i64 = row.get(1).map_err(|e| e.to_string())?;
                let session: Option<String> = row.get(2).map_err(|e| e.to_string())?;
                let project: String = row.get(3).map_err(|e| e.to_string())?;
                let holder = match session {
                    Some(session) => Holder::Session(session),
                    None => Holder::Project(project),
                };
                found.push((id as u64, parent as u64, holder));
            }
            Ok(())
        };
        for batch in chunks.chunks(OWNER_IDS_PER_STATEMENT) {
            read("SELECT c.vector_id, c.node_seq, n.session_id, n.project_id FROM node_vector_chunks c JOIN nodes n ON n.seq=c.node_seq WHERE c.vector_id IN ({ids})", batch)?;
        }
        for batch in seqs.chunks(OWNER_IDS_PER_STATEMENT) {
            read("SELECT n.seq, n.seq, n.session_id, n.project_id FROM nodes n WHERE n.seq IN ({ids})", batch)?;
        }
        Ok(found)
    }
    /// Close SQLite before worker teardown; a later N-API GC must not retain WAL mappings.
    #[napi]
    pub fn close(&mut self) {
        self.connection.take();
    }
    #[napi]
    pub fn search(
        &mut self,
        index: ClassInstance<'_, VectorIndex>,
        lexical: Option<ClassInstance<'_, LexicalIndex>>,
        input: NativeReadInput,
        token: String,
        owner_key: String,
        epoch: String,
        request_id: String,
    ) -> NativeReadOutput {
        let mut out = NativeReadOutput::empty();
        let cell = match claim(&token, &owner_key, &epoch, &request_id) {
            Some(c) => c,
            None => {
                out.kind = Outcome::InvalidInput.tag().into();
                return out;
            }
        };
        out.queue_ms = cell.since_registered().as_secs_f64() * 1000.;
        let Ok(inner) = index.index() else {
            out.kind = Outcome::IndexFailed.tag().into();
            return out;
        };
        let bytes = 40usize
            .saturating_add(input.embedder.len())
            .saturating_add(input.morph_query.len())
            .saturating_add(
                input
                    .query
                    .as_ref()
                    .map_or(0, |q| q.len().saturating_mul(4)),
            )
            .saturating_add(
                input
                    .allowed_projects
                    .iter()
                    .chain(&input.trigram_terms)
                    .chain(&input.short_terms)
                    .map(String::len)
                    .sum::<usize>(),
            );
        out.input_logical_bytes = bytes.min(u32::MAX as usize) as u32;
        if input.input_budget_bytes == 0
            || input.output_budget_bytes == 0
            || input.input_budget_bytes as usize > MAX_BYTES
            || input.output_budget_bytes as usize > MAX_BYTES
            || input.query.as_ref().is_some_and(|q| {
                Some(q.len()) != inner.dim_opt()
                    || q.iter().any(|x| !x.is_finite() || x.abs() >= 1e16)
                    || input.vector_k == 0
            })
            || (input.text_enabled && input.text_k == 0)
            || (input.morph_enabled && (input.morph_k == 0 || input.morph_query.is_empty()))
            || input.before_seq.is_some_and(|seq| seq < 0)
            || ((input.text_enabled || input.morph_enabled) && lexical.is_none())
            || input.morph_query.len() > 65536
            || input
                .allowed_projects
                .iter()
                .chain(&input.trigram_terms)
                .chain(&input.short_terms)
                .any(|s| s.is_empty() || s.len() > 65536)
            || input.embedder.is_empty()
            || input.embedder.len() > 65536
        {
            out.kind = Outcome::InvalidInput.tag().into();
            return out;
        }
        if cell.cancelled() {
            out.kind = Outcome::Cancelled.tag().into();
            return out;
        }
        if bytes > input.input_budget_bytes as usize || input.allowed_projects.len() > 1000 {
            out.kind = Outcome::BudgetExceeded.tag().into();
            return out;
        }
        if self.unusable.get() {
            out.kind = Outcome::ReadFailed.tag().into();
            return out;
        }
        let check = || cell.check();
        let Some(connection) = self.connection.as_ref() else {
            out.kind = Outcome::ReadFailed.tag().into();
            return out;
        };
        let mut guard = ReadGuard {
            connection,
            unusable: &self.unusable,
            finished: false,
        };
        let progress_state = cell.clone();
        // Set only while the text stage runs: interrupting its slow statement at its own deadline.
        let text_until: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
        let progress_text = text_until.clone();
        connection.progress_handler(
            1000,
            Some(move || {
                progress_state.check().is_err()
                    || progress_text
                        .lock()
                        .ok()
                        .and_then(|until| *until)
                        .is_some_and(|until| Instant::now() >= until)
            }),
        );
        let mut running = (Stage::Candidate, Instant::now());
        let result = (|| -> std::result::Result<(), Outcome> {
            check()?;
            connection
                .busy_timeout(cell.remaining().min(Duration::from_millis(10)))
                .map_err(|_| Outcome::ReadFailed)?;
            connection
                .execute_batch("BEGIN DEFERRED")
                .map_err(|_| Outcome::ReadFailed)?;
            out.sqlite_executions += 1;
            // Establish snapshot with a real table read before candidate enumeration.
            connection
                .query_row("SELECT count(*) FROM sqlite_schema", [], |r| {
                    r.get::<_, i64>(0)
                })
                .map_err(|_| Outcome::ReadFailed)?;
            out.sqlite_executions += 1;
            // Publish only after BEGIN and a successful real read pinned SQLite's snapshot.
            // The owning worker still runs this call synchronously: queued index writes
            // cannot overtake the read. Host must track completion separately.
            cell.mark_snapshot_pinned();
            // The lexical searcher is fixed here too. Its hits are checked against the snapshot.
            let lexical = lexical
                .as_ref()
                .map(|lexical| lexical.search())
                .transpose()
                .map_err(|_| Outcome::ReadFailed)?;
            let projects = scope(&input.allowed_projects);
            let lexical_scope = Scope {
                projects: &input.allowed_projects,
                before: input.before_seq.map(|seq| seq as u64),
            };
            let project_values = || {
                input
                    .allowed_projects
                    .iter()
                    .cloned()
                    .map(Value::Text)
                    .collect::<Vec<_>>()
            };
            // The allowlist comes from the index's own owners: the vectors of the allowed
            // projects' conversations and of their nodes outside a conversation, before
            // `before_seq`. What is stale there (a vector not committed yet, waiting to be
            // removed, or left by a re-embedded node) is dropped when its hit is checked against
            // this snapshot below, so the cost here follows the allowed vectors, not every node.
            let mut allowed = Vec::new();
            let mut parents: HashMap<u64, u64> = HashMap::new();
            if input.query.is_some() && !input.allowed_projects.is_empty() && index.owners.len() > 0
            {
                let mut holders: Vec<Holder> = input
                    .allowed_projects
                    .iter()
                    .cloned()
                    .map(Holder::Project)
                    .collect();
                let sql = format!("SELECT id FROM sessions WHERE project_id IN ({projects})");
                let mut statement = connection.prepare(&sql).map_err(|_| Outcome::ReadFailed)?;
                let mut rows = statement
                    .query(params_from_iter(project_values()))
                    .map_err(|_| Outcome::ReadFailed)?;
                out.sqlite_executions += 1;
                while let Some(row) = rows.next().map_err(|_| Outcome::ReadFailed)? {
                    check()?;
                    holders.push(Holder::Session(
                        row.get(0).map_err(|_| Outcome::ReadFailed)?,
                    ));
                }
                let before = input.before_seq.map(|seq| seq as u64);
                for holder in &holders {
                    let Some(group) = index.owners.group(holder) else {
                        continue;
                    };
                    check()?;
                    for (id, parent) in group {
                        if before.is_none_or(|before| *parent < before) {
                            allowed.push(*id);
                            parents.insert(*id, *parent);
                        }
                    }
                }
            }
            out.candidate_count = allowed.len() as u32;
            out.candidate_ms = ms(running.1);
            running = (Stage::Vector, Instant::now());
            let vector_started = running.1;
            let mut checking_ms = 0.;
            if let Some(query) = &input.query {
                check()?;
                let k = input.vector_k as usize;
                let mut remaining = allowed;
                // Parents with a checked hit, and those hits: score, vector id, node id.
                let mut accepted = HashSet::new();
                let mut found: Vec<(f32, u64, String)> = Vec::new();
                let mut found_bytes = 0usize;
                let mut last_call = Duration::ZERO;
                while found.len() < k && !remaining.is_empty() && !inner.is_empty() {
                    let take = (k - found.len()).min(remaining.len());
                    // Each round rescans the whole allowlist; admit it only while the budget
                    // still covers the round before it.
                    if !admitted(
                        query.len(),
                        inner.bit_width(),
                        input.vector_k,
                        cell.remaining(),
                        last_call,
                    ) {
                        return Err(Outcome::BudgetExceeded);
                    }
                    let call = Instant::now();
                    let result = inner.try_search_with_allowlist(query, take, Some(&remaining));
                    last_call = call.elapsed();
                    // Never convert cancellation/deadline into a degraded success.
                    check()?;
                    let mut hits = None;
                    record_vector_channel(&mut out, result, |found, _| hits = Some(found));
                    let Some(hits) = hits else {
                        break;
                    };
                    // Hits are score ordered: the first chunk is the parent's maximum score.
                    let mut round = HashSet::new();
                    let fresh: Vec<(u64, u64, f32)> = hits
                        .ids
                        .iter()
                        .zip(&hits.scores)
                        .filter_map(|(id, score)| {
                            let parent = *parents.get(id)?;
                            round.insert(parent).then_some((*id, parent, *score))
                        })
                        .collect();
                    if fresh.is_empty() {
                        break;
                    }
                    running = (Stage::Mapping, Instant::now());
                    let current = checked(
                        connection,
                        &Checked {
                            embedder: &input.embedder,
                            projects: &input.allowed_projects,
                            before_seq: input.before_seq,
                        },
                        &fresh,
                        &check,
                    )?;
                    out.sqlite_executions += 1;
                    checking_ms += ms(running.1);
                    running = (Stage::Vector, vector_started);
                    let mut rejected = HashSet::new();
                    for (id, parent, score) in fresh {
                        if found.len() >= k {
                            break;
                        }
                        match current.get(&id) {
                            Some(node) => {
                                found_bytes = found_bytes.saturating_add(node.len());
                                if found_bytes > input.output_budget_bytes as usize {
                                    return Err(Outcome::BudgetExceeded);
                                }
                                accepted.insert(parent);
                                found.push((score, id, node.clone()));
                            }
                            None => {
                                rejected.insert(id);
                            }
                        }
                    }
                    // Every hit of this round was taken or dropped, so each round narrows the
                    // allowlist. Keep each call inside the k <= 48 admission bound.
                    remaining.retain(|id| {
                        !rejected.contains(id)
                            && parents.get(id).is_some_and(|p| !accepted.contains(p))
                    });
                }
                if !out.vector_unavailable {
                    // A later round can hold a parent's second chunk above an earlier round's hit.
                    found.sort_by(|left, right| right.0.total_cmp(&left.0));
                    for (score, id, node) in found {
                        out.vector_seqs.push(id.to_string());
                        out.vector_scores.push(score as f64);
                        out.vector_ids.push(node);
                    }
                }
            }
            out.vector_ms = ms(vector_started) - checking_ms;
            out.mapping_ms = checking_ms;
            running = (Stage::Text, Instant::now());
            let text_deadline = Instant::now() + cell.remaining().saturating_sub(TEXT_RESERVE);
            if let Ok(mut until) = text_until.lock() {
                *until = Some(text_deadline);
            }
            let text_over = || Instant::now() >= text_deadline;
            let text_check = || {
                check()?;
                if text_over() {
                    Err(Outcome::BudgetExceeded)
                } else {
                    Ok(())
                }
            };
            let budget = input.output_budget_bytes as usize;
            let mut text_ids: Vec<String> = Vec::new();
            let mut trigram_ms: Option<f64> = None;
            let (mut short_term_ms, mut short_terms_done) = (0., 0u32);
            let mut text_executions = 0u32;
            let text = (|| -> std::result::Result<(), Outcome> {
                let Some(search) = lexical.as_ref() else {
                    return Ok(());
                };
                if !input.text_enabled || input.allowed_projects.is_empty() {
                    return Ok(());
                }
                let k = input.text_k as usize;
                let started = Instant::now();
                let ranked = search.phrases(
                    &input.trigram_terms,
                    k * LEXICAL_DEPTH,
                    &lexical_scope,
                    &text_check,
                )?;
                if !input.trigram_terms.is_empty() {
                    trigram_ms = Some(ms(started));
                }
                // Each two-character term keeps its newest matches, appended in term order.
                let started = Instant::now();
                let newest = search.short_terms(
                    &input.short_terms,
                    k * LEXICAL_DEPTH,
                    &lexical_scope,
                    &text_check,
                )?;
                short_term_ms = ms(started);
                short_terms_done = input.short_terms.len() as u32;
                let seqs: Vec<u64> = ranked
                    .iter()
                    .chain(newest.iter().flatten())
                    .copied()
                    .collect::<HashSet<_>>()
                    .into_iter()
                    .collect();
                if !seqs.is_empty() {
                    text_executions += 1;
                }
                let ids = lexical_ids(
                    connection,
                    &seqs,
                    &input.allowed_projects,
                    budget,
                    &text_check,
                )?;
                let mut seen = HashSet::new();
                for id in std::iter::once(kept(&ranked, &ids, k))
                    .chain(newest.iter().map(|seqs| kept(seqs, &ids, k)))
                    .flatten()
                {
                    if seen.insert(id.clone()) {
                        text_ids.push(id);
                    }
                }
                if text_ids.iter().map(String::len).sum::<usize>() > budget {
                    return Err(Outcome::BudgetExceeded);
                }
                Ok(())
            })();
            if let Ok(mut until) = text_until.lock() {
                *until = None;
            }
            out.sqlite_executions += text_executions;
            out.trigram_ms = trigram_ms;
            out.short_term_ms = short_term_ms;
            out.short_term_max_ms = short_term_ms;
            out.short_terms_done = short_terms_done;
            match text {
                Ok(()) => out.text_ids = text_ids,
                // Past the text deadline any error is the interrupt or the deadline check; the
                // read itself still has its reserve, so the other channels go on without text.
                Err(_) if text_over() && check().is_ok() => out.text_unavailable = true,
                Err(reason) => return Err(reason),
            }
            out.text_ms = ms(running.1);
            running = (Stage::Morph, Instant::now());
            if let Some(search) = lexical.as_ref() {
                if input.morph_enabled && !input.allowed_projects.is_empty() {
                    let k = input.morph_k as usize;
                    let ranked = search.morphs(
                        &input.morph_query,
                        k * LEXICAL_DEPTH,
                        &lexical_scope,
                        &check,
                    )?;
                    if !ranked.is_empty() {
                        out.sqlite_executions += 1;
                    }
                    let ids =
                        lexical_ids(connection, &ranked, &input.allowed_projects, budget, &check)?;
                    out.morph_ids = kept(&ranked, &ids, k);
                }
            }
            out.morph_ms = ms(running.1);
            check()?;
            if out.bytes() > input.output_budget_bytes as usize {
                return Err(Outcome::BudgetExceeded);
            }
            Ok(())
        })();
        let clean = guard.finish();
        let result = if clean {
            result.and_then(|()| check())
        } else {
            Err(Outcome::ReadFailed)
        };
        if let Err(reason) = result {
            let reason = if clean {
                check().err().unwrap_or(reason)
            } else {
                Outcome::ReadFailed
            };
            out = out.failure(reason, running);
            out.input_logical_bytes = bytes as u32;
        }
        out.output_logical_bytes = out.bytes() as u32;
        out
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn engine_failure_only_degrades_vector_channel() {
        let mut out = NativeReadOutput::empty();
        out.text_ids.push("text-hit".into());
        out.morph_ids.push("morph-hit".into());
        record_vector_channel(&mut out, Err::<(), _>(()), |_, _| {
            panic!("failed engine must not record hits")
        });
        assert_eq!(out.kind, Outcome::Success.tag());
        assert!(out.vector_unavailable);
        assert!(out.vector_ids.is_empty());
        assert_eq!(out.text_ids, ["text-hit"]);
        assert_eq!(out.morph_ids, ["morph-hit"]);
        let mut successful = NativeReadOutput::empty();
        record_vector_channel(&mut successful, Ok::<_, ()>(3), |value, out| {
            out.vector_scores.push(value as f64)
        });
        assert!(!successful.vector_unavailable);
        assert_eq!(successful.vector_scores, [3.]);
    }
    #[test]
    fn failure_keeps_stage_times_and_times_the_running_stage() {
        let mut out = NativeReadOutput::empty();
        out.text_ids.push("text-hit".into());
        out.candidate_count = 3;
        out.candidate_ms = 5.;
        out.vector_ms = 6.;
        out.queue_ms = 2.;
        out.trigram_ms = Some(3.);
        out.short_term_ms = 4.;
        out.short_terms_done = 1;
        let started = Instant::now() - Duration::from_millis(40);
        let failed = out.failure(Outcome::BudgetExceeded, (Stage::Mapping, started));
        assert_eq!(failed.kind, Outcome::BudgetExceeded.tag());
        assert!(failed.text_ids.is_empty());
        assert_eq!(failed.candidate_count, 3);
        assert_eq!((failed.candidate_ms, failed.vector_ms), (5., 6.));
        assert_eq!(
            (
                failed.queue_ms,
                failed.trigram_ms,
                failed.short_term_ms,
                failed.short_terms_done
            ),
            (2., Some(3.), 4., 1)
        );
        assert!(failed.mapping_ms >= 40.);
        assert_eq!(failed.text_ms, 0.);
        assert_eq!(failed.failed_stage.as_deref(), Some("mapping"));
    }
    #[cfg(feature = "test-sqlite")]
    fn hit_fixture() -> MemoryReadSession {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE nodes(seq INTEGER PRIMARY KEY, id TEXT, project_id TEXT, session_id TEXT);
                CREATE TABLE node_vectors(node_seq INTEGER, embedder TEXT);
                CREATE TABLE node_vector_chunks(vector_id INTEGER PRIMARY KEY, node_seq INTEGER, embedder TEXT);
                CREATE TABLE memory_graph_vector_removals(node_seq INTEGER, embedder TEXT);
                INSERT INTO nodes VALUES (1,'whole','p','s'),(2,'chunked','p','s'),(3,'removing','p','s'),
                  (4,'elsewhere','q','t'),(5,'later','p','s'),(6,'unpublished','p','s'),(7,'topic','p',NULL);
                INSERT INTO node_vectors VALUES (1,'e'),(2,'e'),(3,'e'),(4,'e'),(5,'e');
                INSERT INTO node_vector_chunks VALUES (4503599627370496,2,'e'),(4503599627370498,3,'e'),
                  (4503599627370499,4,'e'),(4503599627370500,5,'e');
                INSERT INTO memory_graph_vector_removals VALUES (3,'e');",
            )
            .unwrap();
        MemoryReadSession {
            connection: Some(connection),
            unusable: std::cell::Cell::new(false),
        }
    }
    #[test]
    #[cfg(feature = "test-sqlite")]
    fn owners_are_read_by_chunk_mapping_or_node_seq() {
        let reader = hit_fixture();
        let owners = reader
            .owners_of(&[1, 7, 4503599627370496, 4503599627370497])
            .unwrap();
        assert_eq!(
            owners,
            [
                (4503599627370496, 2, Holder::Session("s".into())),
                (1, 1, Holder::Session("s".into())),
                (7, 7, Holder::Project("p".into())),
            ]
        );
    }
    #[test]
    #[cfg(feature = "test-sqlite")]
    fn checked_keeps_only_hits_the_snapshot_still_searches() {
        let reader = hit_fixture();
        let projects = ["p".to_string()];
        let snapshot = Checked {
            embedder: "e",
            projects: &projects,
            before_seq: Some(5),
        };
        // Current: the one-vector node 1 and node 2's mapped chunk. Dropped: node 2's unmapped
        // chunk, node 3 waiting to leave, node 4 of another project, node 5 after `before_seq`,
        // node 6 with no vector row.
        let hits = [
            (1, 1, 0.9),
            (4503599627370496, 2, 0.8),
            (4503599627370497, 2, 0.7),
            (4503599627370498, 3, 0.6),
            (4503599627370499, 4, 0.5),
            (4503599627370500, 5, 0.4),
            (6, 6, 0.3),
        ];
        let current = checked(
            reader.connection.as_ref().unwrap(),
            &snapshot,
            &hits,
            &|| Ok(()),
        )
        .unwrap();
        assert_eq!(
            current,
            HashMap::from([
                (1, "whole".to_string()),
                (4503599627370496, "chunked".to_string())
            ])
        );
    }
    #[test]
    #[cfg(feature = "test-sqlite")]
    fn failed_explicit_cleanup_is_sticky() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("BEGIN DEFERRED").unwrap();
        let unusable = std::cell::Cell::new(false);
        connection.authorizer(Some(|_: rusqlite::hooks::AuthContext<'_>| {
            rusqlite::hooks::Authorization::Deny
        }));
        let mut guard = ReadGuard {
            connection: &connection,
            unusable: &unusable,
            finished: false,
        };
        assert!(!guard.finish());
        assert!(unusable.get());
        assert!(!connection.is_autocommit());
        drop(guard);
        connection.authorizer(
            None::<fn(rusqlite::hooks::AuthContext<'_>) -> rusqlite::hooks::Authorization>,
        );
        connection.execute_batch("ROLLBACK").unwrap();
        assert!(unusable.get());
    }
    #[test]
    #[cfg(feature = "test-sqlite")]
    fn readonly_snapshot_survives_wal_publication() {
        let path = std::env::temp_dir().join(format!(
            "memory-read-session-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE nodes(seq INTEGER PRIMARY KEY); INSERT INTO nodes VALUES(1)").unwrap();
        let connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .unwrap();
        connection.execute_batch("PRAGMA query_only=ON").unwrap();
        let reader = MemoryReadSession {
            connection: Some(connection),
            unusable: std::cell::Cell::new(false),
        };
        let connection = reader.connection.as_ref().unwrap();
        connection.execute_batch("BEGIN DEFERRED").unwrap();
        let count = || {
            connection
                .query_row("SELECT count(*) FROM nodes", [], |r| r.get::<_, i64>(0))
                .unwrap()
        };
        assert_eq!(count(), 1);
        writer.execute_batch("INSERT INTO nodes VALUES(2)").unwrap();
        assert_eq!(count(), 1);
        connection.execute_batch("ROLLBACK").unwrap();
        assert_eq!(count(), 2);
        assert!(connection
            .execute_batch("INSERT INTO nodes VALUES(3)")
            .is_err());
        drop(reader);
        drop(writer);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    #[cfg(feature = "test-sqlite")]
    fn interrupted_read_guard_clears_hook_and_refreshes_snapshot() {
        let path = std::env::temp_dir().join(format!(
            "read-guard-{}-{}.sqlite",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let writer = Connection::open(&path).unwrap();
        writer.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE nodes(seq INTEGER PRIMARY KEY); INSERT INTO nodes VALUES(1)").unwrap();
        // Standalone Rust test has no Node/N-API runtime; exercise the real guard
        // with the constructor's read-only connection flags, not its SDK errors.
        let connection = Connection::open_with_flags(
            &path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .unwrap();
        connection.execute_batch("PRAGMA query_only=ON").unwrap();
        let mut reader = MemoryReadSession {
            connection: Some(connection),
            unusable: std::cell::Cell::new(false),
        };
        let connection = reader.connection.as_ref().unwrap();
        connection.execute_batch("BEGIN DEFERRED").unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM nodes", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            1
        );
        {
            let mut guard = ReadGuard {
                connection,
                unusable: &reader.unusable,
                finished: false,
            };
            connection.progress_handler(1, Some(|| true));
            let error = connection
                .query_row("SELECT count(*) FROM nodes", [], |r| r.get::<_, i64>(0))
                .unwrap_err();
            assert!(
                matches!(error, rusqlite::Error::SqliteFailure(ref code, _) if code.code == rusqlite::ErrorCode::OperationInterrupted)
            );
            assert!(guard.finish());
        }
        writer.execute_batch("INSERT INTO nodes VALUES(2)").unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM nodes", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            2
        );
        assert!(connection.is_autocommit());
        reader.close();
        reader.close();
        assert!(reader.connection.is_none());
        drop(reader);
        drop(writer);
        std::fs::remove_file(path).unwrap();
    }
    #[test]
    #[cfg(feature = "test-sqlite")]
    fn lexical_hits_keep_only_current_nodes_of_allowed_projects() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE nodes(seq INTEGER PRIMARY KEY,id TEXT,project_id TEXT); CREATE TABLE lexical_changes(id INTEGER PRIMARY KEY,node_seq INTEGER); INSERT INTO nodes VALUES(1,'a','p'),(2,'b','p'),(3,'c','q'),(4,'d','p'),(5,'e','p'); INSERT INTO lexical_changes(node_seq) VALUES(4);").unwrap();
        let projects = vec!["p".to_string()];
        // Another project's (3), changed since the index took it (4), gone (6).
        let seqs = [5, 4, 3, 2, 1, 6];
        let ids = lexical_ids(&c, &seqs, &projects, 1024, &|| Ok(())).unwrap();
        assert_eq!(kept(&seqs, &ids, 10), ["e", "b", "a"]);
        assert_eq!(kept(&seqs, &ids, 1), ["e"]);
        assert!(matches!(
            lexical_ids(&c, &seqs, &projects, 1, &|| Ok(())),
            Err(Outcome::BudgetExceeded)
        ));
    }
    #[test]
    #[cfg(feature = "test-sqlite")]
    fn interrupted_text_query_keeps_the_read_transaction() {
        // The text deadline interrupts a SELECT through the progress handler; the read goes on in
        // the same snapshot for the morph stage, so the interrupt must not end the transaction.
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE nodes(seq INTEGER PRIMARY KEY, text TEXT); WITH RECURSIVE r(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM r WHERE i<20000) INSERT INTO nodes SELECT i, 'x' || i FROM r; BEGIN DEFERRED;").unwrap();
        let interrupt = Arc::new(Mutex::new(Some(Instant::now())));
        let flag = interrupt.clone();
        c.progress_handler(100, Some(move || flag.lock().unwrap().is_some()));
        let error = c
            .query_row("SELECT count(*) FROM nodes a JOIN nodes b ON instr(a.text, b.text) > 0", [], |r| r.get::<_, i64>(0))
            .unwrap_err();
        assert!(matches!(error, rusqlite::Error::SqliteFailure(ref code, _) if code.code == rusqlite::ErrorCode::OperationInterrupted));
        *interrupt.lock().unwrap() = None;
        assert!(!c.is_autocommit());
        assert_eq!(c.query_row("SELECT count(*) FROM nodes", [], |r| r.get::<_, i64>(0)).unwrap(), 20000);
        c.execute_batch("ROLLBACK").unwrap();
    }
}
