//! Admission is a measured-time policy, NOT a preemptive deadline guarantee.
//! The pinned engine includes synchronous mask construction and cold cache warming.
//! Index and allowlist size are not admission bounds: the engine call costs a few ms
//! up to 800k vectors (docs/decisions.md, 2026-10-20). A later call in the same
//! request is admitted only while the remaining budget covers the previous call.
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, Instant},
};
use turbovec::IdMapIndex;

#[napi(object)]
pub struct ControlledSearchResult {
    pub kind: String,
    pub ids: Vec<String>,
    pub scores: Vec<f64>,
    pub native_window: String,
    pub native_ms: f64,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Outcome {
    Success,
    Cancelled,
    BudgetExceeded,
    InvalidInput,
    IndexFailed,
    ReadFailed,
}
impl Outcome {
    pub(crate) fn tag(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Cancelled => "cancelled",
            Self::BudgetExceeded => "budget-exceeded",
            Self::InvalidInput => "invalid-input",
            Self::IndexFailed => "index-failed",
            Self::ReadFailed => "read-failed",
        }
    }
}
pub(crate) fn outcome(kind: Outcome, start: Instant) -> ControlledSearchResult {
    ControlledSearchResult {
        kind: kind.tag().into(),
        ids: vec![],
        scores: vec![],
        native_window: "whole-call".into(),
        native_ms: start.elapsed().as_secs_f64() * 1000.0,
    }
}

const MAX_CONTROLS: usize = 4096;
// Never recycle issued capabilities, without keeping an unbounded tombstone set.
static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);
static REGISTRY: OnceLock<Mutex<HashMap<String, Arc<RequestState>>>> = OnceLock::new();
fn registry() -> &'static Mutex<HashMap<String, Arc<RequestState>>> {
    REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}
pub(crate) struct RequestState {
    token: String,
    cancelled: AtomicBool,
    claimed: AtomicBool,
    snapshot_pinned: AtomicBool,
    deadline: Instant,
    owner_key: String,
    epoch: String,
    request_id: String,
}
impl RequestState {
    pub(crate) fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Acquire)
    }
    pub(crate) fn mark_snapshot_pinned(&self) {
        self.snapshot_pinned.store(true, Ordering::Release);
    }
    pub(crate) fn remaining(&self) -> Duration {
        self.deadline.saturating_duration_since(Instant::now())
    }
    pub(crate) fn check(&self) -> std::result::Result<(), Outcome> {
        if self.cancelled() {
            Err(Outcome::Cancelled)
        } else if self.remaining().is_zero() {
            Err(Outcome::BudgetExceeded)
        } else {
            Ok(())
        }
    }
}
#[napi]
pub struct SearchControl {
    seed: String,
    token: String,
    state: Arc<RequestState>,
}
#[napi]
impl SearchControl {
    #[napi(constructor)]
    pub fn new(
        token: String,
        owner_key: String,
        epoch: String,
        request_id: String,
        remaining_ms: f64,
    ) -> Result<Self> {
        register(token, owner_key, epoch, request_id, remaining_ms).map_err(Error::from_reason)
    }
    #[napi]
    pub fn token(&self) -> String {
        self.token.clone()
    }
    /// Request-local monotonic event, NOT proof the snapshot is still alive.
    /// Host must separately observe actual completion/cancellation and owner order.
    #[napi]
    pub fn snapshot_was_pinned(&self) -> bool {
        self.state.snapshot_pinned.load(Ordering::Acquire)
    }
    #[napi]
    pub fn cancel(&self) {
        self.state.cancelled.store(true, Ordering::Release);
    }
    #[napi]
    pub fn close(&self) {
        self.cancel();
        if let Ok(mut entries) = registry().lock() {
            if entries
                .get(&self.seed)
                .is_some_and(|s| Arc::ptr_eq(s, &self.state))
            {
                entries.remove(&self.seed);
            }
        }
    }
    #[napi]
    pub fn count() -> u32 {
        registry()
            .lock()
            .map_or(MAX_CONTROLS as u32, |entries| entries.len() as u32)
    }
}
fn register(
    token: String,
    owner_key: String,
    epoch: String,
    request_id: String,
    remaining_ms: f64,
) -> std::result::Result<SearchControl, &'static str> {
    if [&token, &owner_key, &epoch, &request_id]
        .iter()
        .any(|s| s.is_empty() || s.len() > 256)
        || !remaining_ms.is_finite()
        || !(0.0..=86_400_000.0).contains(&remaining_ms)
    {
        return Err("Invalid search control");
    }
    let serial = NEXT_TOKEN
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            value.checked_add(1)
        })
        .map_err(|_| "Control token exhausted")?;
    let seed = token;
    let token = format!("{seed}:{serial}");
    let state = Arc::new(RequestState {
        token: token.clone(),
        cancelled: AtomicBool::new(false),
        claimed: AtomicBool::new(false),
        snapshot_pinned: AtomicBool::new(false),
        deadline: Instant::now() + Duration::from_secs_f64(remaining_ms / 1000.0),
        owner_key,
        epoch,
        request_id,
    });
    let mut entries = registry()
        .lock()
        .map_err(|_| "Control registry unavailable")?;
    if entries.len() >= MAX_CONTROLS || entries.contains_key(&seed) {
        return Err("Control registration rejected");
    }
    entries.insert(seed.clone(), state.clone());
    Ok(SearchControl { seed, token, state })
}
impl Drop for SearchControl {
    fn drop(&mut self) {
        self.close();
    }
}
pub(crate) fn claim(
    token: &str,
    owner_key: &str,
    epoch: &str,
    request_id: &str,
) -> Option<Arc<RequestState>> {
    let entries = registry().lock().ok()?;
    let (seed, _) = token.rsplit_once(':')?;
    let state = entries.get(seed)?;
    if state.token != token
        || state.owner_key != owner_key
        || state.epoch != epoch
        || state.request_id != request_id
        || state
            .claimed
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
    {
        return None;
    }
    Some(state.clone())
}

/// `previous` is the measured span of the request's previous engine call, zero before the first.
pub(crate) fn admitted(
    dim: usize,
    bits: usize,
    k: u32,
    remaining: Duration,
    previous: Duration,
) -> bool {
    dim == 384 && bits == 4 && k <= 48 && remaining >= previous.max(Duration::from_millis(12))
}

pub fn search(
    index: &IdMapIndex,
    query: Float32Array,
    k: u32,
    token: String,
    owner_key: String,
    epoch: String,
    request_id: String,
    allowed: Option<Vec<String>>,
) -> ControlledSearchResult {
    let start = Instant::now();
    let cell = match claim(&token, &owner_key, &epoch, &request_id) {
        Some(cell) => cell,
        None => return outcome(Outcome::InvalidInput, start),
    };
    if cell.cancelled() {
        return outcome(Outcome::Cancelled, start);
    }
    if Some(query.len()) != index.dim_opt()
        || query.iter().any(|x| !x.is_finite() || x.abs() >= 1e16)
        || k == 0
    {
        return outcome(Outcome::InvalidInput, start);
    }
    if !admitted(
        query.len(),
        index.bit_width(),
        k,
        cell.remaining(),
        Duration::ZERO,
    ) {
        return outcome(Outcome::BudgetExceeded, start);
    }
    let ids = match allowed {
        Some(ids) => match ids
            .iter()
            .map(|id| crate::parse_id(id))
            .collect::<Result<Vec<_>>>()
        {
            Ok(ids) => Some(ids),
            Err(_) => return outcome(Outcome::InvalidInput, start),
        },
        None => None,
    };
    if cell.cancelled() {
        return outcome(Outcome::Cancelled, start);
    }
    if !admitted(
        query.len(),
        index.bit_width(),
        k,
        cell.remaining(),
        Duration::ZERO,
    ) {
        return outcome(Outcome::BudgetExceeded, start);
    }
    // Preserve the existing early-empty semantics and the exact single engine
    // call. Never clip candidates or replace the engine/index/writer.
    let result = if index.len() == 0 || ids.as_ref().is_some_and(|ids| ids.is_empty()) {
        None
    } else {
        Some(index.try_search_with_allowlist(&query, k as usize, ids.as_deref()))
    };
    if cell.cancelled() {
        return outcome(Outcome::Cancelled, start);
    }
    if cell.remaining().is_zero() {
        return outcome(Outcome::BudgetExceeded, start);
    }
    let mut out = outcome(Outcome::Success, start);
    if let Some(result) = result {
        match result {
            Ok(result) => {
                out.ids = result.ids.iter().map(u64::to_string).collect();
                out.scores = result.scores.iter().map(|x| *x as f64).collect();
            }
            Err(_) => return outcome(Outcome::IndexFailed, start),
        }
    }
    if cell.cancelled() {
        return outcome(Outcome::Cancelled, start);
    }
    if cell.remaining().is_zero() {
        return outcome(Outcome::BudgetExceeded, start);
    }
    out.native_ms = start.elapsed().as_secs_f64() * 1000.0;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn registry_binding_one_shot_and_lifecycle() {
        let control = register(
            "rust-registry-lifecycle".into(),
            "owner".into(),
            "epoch".into(),
            "request".into(),
            1000.0,
        )
        .unwrap();
        assert!(register(
            control.seed.clone(),
            "other".into(),
            "epoch".into(),
            "request".into(),
            1000.0
        )
        .is_err());
        assert!(!control.state.cancelled());
        assert!(register(
            "invalid-budget".into(),
            "owner".into(),
            "epoch".into(),
            "request".into(),
            f64::NAN
        )
        .is_err());
        assert!(register(
            "invalid-budget".into(),
            "owner".into(),
            "epoch".into(),
            "request".into(),
            -1.0
        )
        .is_err());
        assert!(claim(&control.token, "wrong", "epoch", "request").is_none());
        assert!(claim(&control.token, "owner", "wrong", "request").is_none());
        assert!(claim(&control.token, "owner", "epoch", "wrong").is_none());
        let worker = claim(&control.token, "owner", "epoch", "request").unwrap();
        assert!(claim(&control.token, "owner", "epoch", "request").is_none());
        assert_eq!(worker.check(), Ok(()));
        control.cancel();
        assert_eq!(worker.check(), Err(Outcome::Cancelled));
        control.close();
        control.close();
        assert!(claim(&control.token, "owner", "epoch", "request").is_none());
        // An old handle cannot remove/cancel a newer registration with a reused token.
        let newer = register(
            control.seed.clone(),
            "owner".into(),
            "epoch".into(),
            "request".into(),
            1000.0,
        )
        .unwrap();
        assert_ne!(newer.token, control.token);
        assert!(claim(&control.token, "owner", "epoch", "request").is_none());
        control.close();
        let new_worker = claim(&newer.token, "owner", "epoch", "request").unwrap();
        assert_eq!(new_worker.check(), Ok(()));
        drop(newer);
        assert_eq!(new_worker.check(), Err(Outcome::Cancelled));
    }
    #[test]
    fn zero_deadline_is_exceeded() {
        let control = register(
            "rust-zero-deadline".into(),
            "owner".into(),
            "epoch".into(),
            "request".into(),
            0.0,
        )
        .unwrap();
        assert_eq!(
            claim(&control.token, "owner", "epoch", "request")
                .unwrap()
                .check(),
            Err(Outcome::BudgetExceeded)
        );
    }
    #[test]
    fn admission_needs_previous_call_span() {
        let ms = Duration::from_millis;
        assert!(admitted(384, 4, 48, ms(12), Duration::ZERO));
        assert!(!admitted(384, 4, 49, ms(12), Duration::ZERO));
        assert!(!admitted(384, 4, 48, ms(11), Duration::ZERO));
        assert!(!admitted(383, 4, 48, ms(12), Duration::ZERO));
        assert!(admitted(384, 4, 48, ms(30), ms(30)));
        assert!(!admitted(384, 4, 48, ms(29), ms(30)));
    }
}
