//! Read-only seed ranking. Host owns authorization and index publication serialization.
use crate::{
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
/// What the text stage leaves of the read's budget for morph and coverage. Past that point the
/// text matches are dropped (`text_unavailable`) and the read goes on, instead of the whole read
/// failing on a slow text query (docs/decisions.md, 2026-10-30).
const TEXT_RESERVE: Duration = Duration::from_millis(600);
// Same terms as the `nodes_embeddable` partial index; spelled differently, SQLite would not use it.
const EMBEDDED_KINDS: &str = "n.kind IN ('user', 'assistant', 'topic')";
const MEANINGFUL: &str ="length(trim(n.text, char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))) > 0 AND NOT EXISTS (SELECT 1 FROM memory_graph_suppressed_nodes s WHERE s.node_seq = n.seq)";
// For the text and morph queries. A node one of their terms matched is never blank: the terms hold no
// whitespace (the host splits on it, and \s is the set trimmed above), so checking that again would
// only read every matched node's whole text, overflow pages and all.
const NOT_SUPPRESSED: &str = "NOT EXISTS (SELECT 1 FROM memory_graph_suppressed_nodes s WHERE s.node_seq = n.seq)";
#[napi(object)]
pub struct NativeReadInput {
    pub allowed_projects: Vec<String>,
    pub embedder: String,
    pub query: Option<Float32Array>,
    pub trigram_terms: Vec<String>,
    pub short_terms: Vec<String>,
    pub morph_terms: Vec<String>,
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
    pub unindexed: f64,
    pub uninterpreted: f64,
    pub candidate_count: u32,
    pub sqlite_executions: u32,
    pub candidate_ms: f64,
    pub vector_ms: f64,
    pub text_ms: f64,
    pub morph_ms: f64,
    pub mapping_ms: f64,
    /// The unindexed and uninterpreted counts.
    pub coverage_ms: f64,
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
    Coverage,
}
impl Stage {
    fn name(self) -> &'static str {
        match self {
            Stage::Candidate => "candidate",
            Stage::Vector => "vector",
            Stage::Mapping => "mapping",
            Stage::Text => "text",
            Stage::Morph => "morph",
            Stage::Coverage => "coverage",
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
            unindexed: 0.,
            uninterpreted: 0.,
            candidate_count: 0,
            sqlite_executions: 0,
            candidate_ms: 0.,
            vector_ms: 0.,
            text_ms: 0.,
            morph_ms: 0.,
            mapping_ms: 0.,
            coverage_ms: 0.,
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
            Stage::Coverage => &mut self.coverage_ms,
        }
    }
    /// A failed read carries no hits or coverage, only the work it did: the stages that finished
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
            coverage_ms: self.coverage_ms,
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
fn quoted(terms: &[String]) -> String {
    terms
        .iter()
        .map(|s| format!("\"{}\"", s.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ")
}
fn scope(projects: &[String]) -> String {
    if projects.is_empty() {
        "NULL".into()
    } else {
        vec!["?"; projects.len()].join(",")
    }
}
/// Walks `sql` (rows of id and text, newest first) once and keeps, for each term, the ids of its
/// newest `k` rows that contain it. Stops when every term has `k`.
fn short_term_hits(
    connection: &Connection,
    sql: &str,
    params: Vec<Value>,
    terms: &[String],
    k: usize,
    id_budget: usize,
    check: &dyn Fn() -> std::result::Result<(), Outcome>,
) -> std::result::Result<Vec<Vec<String>>, Outcome> {
    let mut statement = connection.prepare(sql).map_err(|_| Outcome::ReadFailed)?;
    let mut rows = statement
        .query(params_from_iter(params))
        .map_err(|_| Outcome::ReadFailed)?;
    let mut hits: Vec<Vec<String>> = vec![Vec::new(); terms.len()];
    let mut open = if k == 0 { 0 } else { terms.len() };
    while open > 0 {
        let Some(row) = rows.next().map_err(|_| Outcome::ReadFailed)? else {
            break;
        };
        check()?;
        let text = row
            .get_ref(1)
            .map_err(|_| Outcome::ReadFailed)?
            .as_str()
            .map_err(|_| Outcome::ReadFailed)?;
        let mut id: Option<String> = None;
        for (term, found) in terms.iter().zip(hits.iter_mut()) {
            if found.len() < k && text.contains(term.as_str()) {
                if id.is_none() {
                    let value = row
                        .get_ref(0)
                        .map_err(|_| Outcome::ReadFailed)?
                        .as_str()
                        .map_err(|_| Outcome::ReadFailed)?;
                    if value.len() > id_budget {
                        return Err(Outcome::BudgetExceeded);
                    }
                    id = Some(value.to_owned());
                }
                found.push(id.clone().unwrap_or_default());
                if found.len() == k {
                    open -= 1;
                }
            }
        }
    }
    Ok(hits)
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
    /// Close SQLite before worker teardown; a later N-API GC must not retain WAL mappings.
    #[napi]
    pub fn close(&mut self) {
        self.connection.take();
    }
    #[napi]
    pub fn search(
        &mut self,
        index: ClassInstance<'_, VectorIndex>,
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
                    .chain(&input.morph_terms)
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
            || (input.morph_enabled && input.morph_k == 0)
            || input
                .allowed_projects
                .iter()
                .chain(&input.trigram_terms)
                .chain(&input.short_terms)
                .chain(&input.morph_terms)
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
            let projects = scope(&input.allowed_projects);
            let project_values = || {
                input
                    .allowed_projects
                    .iter()
                    .cloned()
                    .map(Value::Text)
                    .collect::<Vec<_>>()
            };
            let mut allowed = Vec::new();
            let mut parents = HashMap::new();
            if input.query.is_some() && !input.allowed_projects.is_empty() {
                let mut values = vec![Value::Text(input.embedder.clone())];
                values.extend(project_values());
                // The kind terms let SQLite answer from the `nodes_embeddable` index without reading text.
                let sql = format!("SELECT COALESCE(c.vector_id,n.seq),n.seq FROM node_vectors v JOIN nodes n ON n.seq=v.node_seq LEFT JOIN node_vector_chunks c ON c.node_seq=v.node_seq AND c.embedder=v.embedder WHERE {MEANINGFUL} AND {EMBEDDED_KINDS} AND v.embedder=? AND n.project_id IN ({projects})");
                let mut statement = connection.prepare(&sql).map_err(|_| Outcome::ReadFailed)?;
                let mut rows = statement
                    .query(params_from_iter(values))
                    .map_err(|_| Outcome::ReadFailed)?;
                out.sqlite_executions += 1;
                while let Some(row) = rows.next().map_err(|_| Outcome::ReadFailed)? {
                    check()?;
                    let seq: i64 = row.get(0).map_err(|_| Outcome::ReadFailed)?;
                    if seq < 0 {
                        return Err(Outcome::ReadFailed);
                    }
                    allowed.push(seq as u64);
                    parents.insert(
                        seq as u64,
                        row.get::<_, i64>(1).map_err(|_| Outcome::ReadFailed)?,
                    );
                }
            }
            out.candidate_count = allowed.len() as u32;
            out.candidate_ms = ms(running.1);
            running = (Stage::Vector, Instant::now());
            // The parent node of each hit in `out.vector_seqs`, same order.
            let mut hit_parents = Vec::new();
            if let Some(query) = &input.query {
                check()?;
                let mut remaining = allowed.clone();
                let mut seen = HashSet::new();
                let mut last_call = Duration::ZERO;
                while !remaining.is_empty() && !inner.is_empty() {
                    let take =
                        (input.vector_k as usize - out.vector_seqs.len()).min(remaining.len());
                    let previous = seen.len();
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
                    record_vector_channel(&mut out, result, |hits, out| {
                        // Hits are score ordered: the first chunk is the parent's maximum score.
                        for (id, score) in hits.ids.iter().zip(&hits.scores) {
                            if let Some(parent) = parents.get(id) {
                                if seen.insert(*parent) {
                                    hit_parents.push(*parent);
                                    out.vector_seqs.push(id.to_string());
                                    out.vector_scores.push(*score as f64);
                                    if out.vector_seqs.len() >= input.vector_k as usize {
                                        break;
                                    }
                                }
                            }
                        }
                    });
                    if out.vector_unavailable
                        || out.vector_seqs.len() >= input.vector_k as usize
                        || seen.len() == previous
                    {
                        break;
                    }
                    // Exclude all chunks of selected parents before the next bounded search.
                    // Keep each call inside the k <= 48 admission bound.
                    remaining.retain(|id| parents.get(id).is_some_and(|p| !seen.contains(p)));
                }
                if out.vector_unavailable {
                    hit_parents.clear();
                    out.vector_seqs.clear();
                    out.vector_scores.clear();
                }
            }
            out.vector_ms = ms(running.1);
            running = (Stage::Mapping, Instant::now());
            if !hit_parents.is_empty() {
                // The candidate read already applied embedder, kind, project and meaning in this
                // snapshot, so the parents only need their ids. Matching the hits' vector ids
                // instead walked every node of the allowed projects: no index covers that.
                let placeholders = vec!["?"; hit_parents.len()].join(",");
                let sql = format!("SELECT seq,id FROM nodes WHERE seq IN ({placeholders})");
                let mut statement = connection.prepare(&sql).map_err(|_| Outcome::ReadFailed)?;
                let mut rows = statement
                    .query(params_from_iter(hit_parents.iter()))
                    .map_err(|_| Outcome::ReadFailed)?;
                out.sqlite_executions += 1;
                let mut mapped = HashMap::new();
                let mut mapping_bytes = 0usize;
                while let Some(row) = rows.next().map_err(|_| Outcome::ReadFailed)? {
                    check()?;
                    let value = row.get_ref(1).map_err(|_| Outcome::ReadFailed)?;
                    let id = value.as_str().map_err(|_| Outcome::ReadFailed)?;
                    mapping_bytes = mapping_bytes.saturating_add(id.len());
                    if mapping_bytes > input.output_budget_bytes as usize {
                        return Err(Outcome::BudgetExceeded);
                    }
                    mapped.insert(
                        row.get::<_, i64>(0).map_err(|_| Outcome::ReadFailed)?,
                        id.to_owned(),
                    );
                }
                let mut seqs = Vec::new();
                let mut scores = Vec::new();
                for ((seq, score), parent) in out
                    .vector_seqs
                    .iter()
                    .zip(&out.vector_scores)
                    .zip(&hit_parents)
                {
                    if let Some(id) = mapped.remove(parent) {
                        out.vector_ids.push(id);
                        seqs.push(seq.clone());
                        scores.push(*score);
                    }
                }
                out.vector_seqs = seqs;
                out.vector_scores = scores;
            }
            out.mapping_ms = ms(running.1);
            running = (Stage::Text, Instant::now());
            let mut short_executions = 0u32;
            let mut rank = |sql: String,
                            first: String,
                            k: u32,
                            target: &mut Vec<String>,
                            dedupe: bool,
                            check: &dyn Fn() -> std::result::Result<(), Outcome>|
             -> std::result::Result<(), Outcome> {
                check()?;
                let mut values = vec![Value::Text(first)];
                values.extend(project_values());
                values.push(Value::Integer(k as i64));
                let mut statement = connection.prepare(&sql).map_err(|_| Outcome::ReadFailed)?;
                let mut rows = statement
                    .query(params_from_iter(values))
                    .map_err(|_| Outcome::ReadFailed)?;
                out.sqlite_executions += 1;
                let mut seen: HashSet<String> = target.iter().cloned().collect();
                let mut logical_bytes: usize = target.iter().map(String::len).sum();
                while let Some(row) = rows.next().map_err(|_| Outcome::ReadFailed)? {
                    check()?;
                    let value = row.get_ref(0).map_err(|_| Outcome::ReadFailed)?;
                    let text = value.as_str().map_err(|_| Outcome::ReadFailed)?;
                    if text.len() > input.output_budget_bytes as usize {
                        return Err(Outcome::BudgetExceeded);
                    }
                    let id = text.to_owned();
                    if !dedupe || seen.insert(id.clone()) {
                        logical_bytes += id.len();
                        target.push(id);
                    }
                    if logical_bytes > input.output_budget_bytes as usize {
                        return Err(Outcome::BudgetExceeded);
                    }
                }
                Ok(())
            };
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
            let mut text_ids: Vec<String> = Vec::new();
            let mut trigram_ms: Option<f64> = None;
            let (mut short_term_ms, mut short_term_max_ms, mut short_terms_done) = (0., 0., 0u32);
            let text = (|| -> std::result::Result<(), Outcome> {
                if input.text_enabled && !input.allowed_projects.is_empty() {
                    if !input.trigram_terms.is_empty() {
                        let started = Instant::now();
                        rank(format!("SELECT n.id FROM nodes_fts f JOIN nodes n ON n.seq=f.rowid WHERE {NOT_SUPPRESSED} AND nodes_fts MATCH ? AND n.project_id IN ({projects}) ORDER BY f.rank LIMIT ?"), quoted(&input.trigram_terms), input.text_k, &mut text_ids, false, &text_check)?;
                        trigram_ms = Some(ms(started));
                    }
                    if !input.short_terms.is_empty() {
                        let started = Instant::now();
                        // One newest-first walk for every short term, instead of one walk per term: a
                        // rare term walked the whole table, and a Korean question has several. Each
                        // term keeps its newest `text_k` matches, appended in term order as before.
                        // One project walks its own rows through nodes_project(project_id, seq). For
                        // several, `+` keeps SQLite on the rowid scan, which stops early, instead of
                        // reading every listed project's rows to sort them.
                        let filter = if input.allowed_projects.len() == 1 {
                            format!("n.project_id IN ({projects})")
                        } else {
                            format!("+n.project_id IN ({projects})")
                        };
                        let hits = short_term_hits(
                            connection,
                            &format!("SELECT n.id, n.text FROM nodes n WHERE {filter} AND {NOT_SUPPRESSED} ORDER BY n.seq DESC"),
                            project_values(),
                            &input.short_terms,
                            input.text_k as usize,
                            input.output_budget_bytes as usize,
                            &text_check,
                        )?;
                        short_executions += 1;
                        let mut seen: HashSet<String> = text_ids.iter().cloned().collect();
                        let mut logical_bytes: usize = text_ids.iter().map(String::len).sum();
                        for id in hits.into_iter().flatten() {
                            if seen.insert(id.clone()) {
                                logical_bytes += id.len();
                                text_ids.push(id);
                            }
                            if logical_bytes > input.output_budget_bytes as usize {
                                return Err(Outcome::BudgetExceeded);
                            }
                        }
                        let took = ms(started);
                        short_term_ms = took;
                        short_term_max_ms = took;
                        short_terms_done = input.short_terms.len() as u32;
                    }
                }
                Ok(())
            })();
            if let Ok(mut until) = text_until.lock() {
                *until = None;
            }
            out.trigram_ms = trigram_ms;
            out.short_term_ms = short_term_ms;
            out.short_term_max_ms = short_term_max_ms;
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
            if input.morph_enabled
                && !input.morph_terms.is_empty()
                && !input.allowed_projects.is_empty()
            {
                rank(format!("SELECT n.id FROM nodes_morph f JOIN nodes n ON n.seq=f.rowid WHERE {NOT_SUPPRESSED} AND nodes_morph MATCH ? AND n.project_id IN ({projects}) ORDER BY f.rank LIMIT ?"), quoted(&input.morph_terms), input.morph_k, &mut out.morph_ids, false, &check)?;
            }
            out.morph_ms = ms(running.1);
            out.sqlite_executions += short_executions;
            running = (Stage::Coverage, Instant::now());
            out.unindexed = connection.query_row(&format!("SELECT count(*) FROM nodes n LEFT JOIN node_vectors v ON v.node_seq=n.seq AND v.embedder=? WHERE v.node_seq IS NULL AND {MEANINGFUL} AND {EMBEDDED_KINDS}"), [&input.embedder], |r| r.get::<_,i64>(0)).map_err(|_| Outcome::ReadFailed)? as f64;
            out.sqlite_executions += 1;
            // CROSS JOIN keeps the few open jobs as the outer loop; otherwise SQLite walks every node of the project.
            out.uninterpreted = connection.query_row(&format!("SELECT count(*) FROM interpret_jobs j CROSS JOIN nodes n ON n.id=j.node_id WHERE j.status!='done' AND {MEANINGFUL} AND n.project_id IN ({projects})"), params_from_iter(project_values()), |r| r.get::<_,i64>(0)).map_err(|_| Outcome::ReadFailed)? as f64;
            out.sqlite_executions += 1;
            out.coverage_ms = ms(running.1);
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
        out.unindexed = 7.;
        record_vector_channel(&mut out, Err::<(), _>(()), |_, _| {
            panic!("failed engine must not record hits")
        });
        assert_eq!(out.kind, Outcome::Success.tag());
        assert!(out.vector_unavailable);
        assert!(out.vector_ids.is_empty());
        assert_eq!(out.text_ids, ["text-hit"]);
        assert_eq!(out.morph_ids, ["morph-hit"]);
        assert_eq!(out.unindexed, 7.);
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
        out.unindexed = 7.;
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
        assert_eq!(failed.unindexed, 0.);
        assert_eq!(failed.candidate_count, 3);
        assert_eq!((failed.candidate_ms, failed.vector_ms), (5., 6.));
        assert_eq!(
            (failed.queue_ms, failed.trigram_ms, failed.short_term_ms, failed.short_terms_done),
            (2., Some(3.), 4., 1)
        );
        assert!(failed.mapping_ms >= 40.);
        assert_eq!(failed.text_ms, 0.);
        assert_eq!(failed.failed_stage.as_deref(), Some("mapping"));
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
    fn one_short_term_walk_matches_a_query_per_term() {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE nodes(seq INTEGER PRIMARY KEY,id TEXT,text TEXT,project_id TEXT); CREATE INDEX nodes_project ON nodes(project_id, seq); CREATE TABLE memory_graph_suppressed_nodes(node_seq INTEGER); INSERT INTO memory_graph_suppressed_nodes VALUES(5);").unwrap();
        let texts = ["오늘 PR", "어제 작업", "PR 오늘 어제", "UI", "오늘 숨김", "작업 오늘", "다른", "PR PR", "오늘"];
        for (i, text) in texts.iter().enumerate() {
            let project = if i == 6 { "q" } else { "p" };
            c.execute("INSERT INTO nodes VALUES(?,?,?,?)", rusqlite::params![i as i64 + 1, format!("n{}", i + 1), text, project]).unwrap();
        }
        let terms: Vec<String> = ["오늘", "PR", "작업", "없음", "다른"].iter().map(|t| t.to_string()).collect();
        for k in [1usize, 2, 3, 10] {
            let walked = short_term_hits(
                &c,
                &format!("SELECT n.id, n.text FROM nodes n WHERE n.project_id IN (?) AND {NOT_SUPPRESSED} ORDER BY n.seq DESC"),
                vec![Value::Text("p".into())],
                &terms,
                k,
                1024,
                &|| Ok(()),
            )
            .unwrap();
            let per_term: Vec<Vec<String>> = terms
                .iter()
                .map(|term| {
                    c.prepare(&format!("SELECT n.id FROM nodes n WHERE {MEANINGFUL} AND instr(n.text,?)>0 AND +n.project_id IN (?) ORDER BY n.seq DESC LIMIT ?"))
                        .unwrap()
                        .query_map(rusqlite::params![term, "p", k as i64], |r| r.get::<_, String>(0))
                        .unwrap()
                        .collect::<rusqlite::Result<Vec<_>>>()
                        .unwrap()
                })
                .collect();
            assert_eq!(walked, per_term, "k={k}");
        }
    }
    #[test]
    #[cfg(feature = "test-sqlite")]
    fn interrupted_text_query_keeps_the_read_transaction() {
        // The text deadline interrupts a SELECT through the progress handler; the read goes on in
        // the same snapshot for morph and coverage, so the interrupt must not end the transaction.
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
    #[test]
    #[cfg(feature = "test-sqlite")]
    fn quoting_and_real_trigram_predicate() {
        assert_eq!(quoted(&["a\"b".into(), "c".into()]), "\"a\"\"b\" OR \"c\"");
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE nodes(seq INTEGER PRIMARY KEY,id TEXT,text TEXT,project_id TEXT); CREATE TABLE memory_graph_suppressed_nodes(node_seq INTEGER); CREATE VIRTUAL TABLE nodes_fts USING fts5(text,tokenize='trigram'); INSERT INTO nodes VALUES(1,'a',char(65279,160,9),'p'),(2,'b','hello','p'),(3,'c','hello','p'); INSERT INTO memory_graph_suppressed_nodes VALUES(3); INSERT INTO nodes_fts(rowid,text) SELECT seq,text FROM nodes;").unwrap();
        let ids = c.prepare(&format!("SELECT n.id FROM nodes_fts f JOIN nodes n ON n.seq=f.rowid WHERE {MEANINGFUL} AND nodes_fts MATCH ? ORDER BY f.rank")).unwrap().query_map(["\"hello\""], |r| r.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        assert_eq!(ids, ["b"]);
    }
}
