use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::{
    fs::File,
    sync::{Arc, RwLock, RwLockReadGuard, RwLockWriteGuard},
};
mod lexical;
mod owners;
mod read_session;
mod search_control;
mod shared;
mod sqlite_bridge;
pub use lexical::{LexicalApplied, LexicalDocument, LexicalIndex};
pub use read_session::{MemoryReadSession, NativeReadInput, NativeReadOutput};
pub use search_control::{ControlledSearchResult, SearchControl};
use turbovec::IdMapIndex;

fn js_error(error: impl std::fmt::Display) -> Error {
    Error::from_reason(error.to_string())
}
fn parse_id(value: &str) -> Result<u64> {
    let id = value.parse::<u64>().map_err(js_error)?;
    if id.to_string() != value {
        return Err(js_error("Non-canonical vector ID"));
    }
    Ok(id)
}

fn canonical_unique_ids(ids: &[String]) -> Option<Vec<u64>> {
    let mut seen = std::collections::HashSet::new();
    ids.iter()
        .map(|value| {
            let id = value.parse::<u64>().ok()?;
            if id.to_string() != *value || !seen.insert(id) {
                return None;
            }
            Some(id)
        })
        .collect()
}

#[napi(object)]
pub struct SearchResult {
    pub ids: Vec<String>,
    pub scores: Vec<f64>,
}

pub(crate) fn ms(start: std::time::Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.
}

#[napi]
pub struct CacheLease {
    file: Option<File>,
}

#[napi]
impl CacheLease {
    #[napi(constructor)]
    pub fn new(path: String) -> Result<Self> {
        let mut options = File::options();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = options.open(path).map_err(js_error)?;
        file.try_lock().map_err(|error| match error {
            std::fs::TryLockError::WouldBlock => {
                js_error("Vector cache is locked by another scorer")
            }
            std::fs::TryLockError::Error(error) => js_error(error),
        })?;
        Ok(Self { file: Some(file) })
    }
    #[napi]
    pub fn close(&mut self) {
        self.file.take();
    }
}

/// The vectors and which node each belongs to, changed together under one lock so a read's
/// allowlist always names vectors the index holds.
pub(crate) struct Vectors {
    pub(crate) index: IdMapIndex,
    /// The node and holder of each vector `attach_owners` found; reads build their allowlist here.
    pub(crate) owners: owners::Owners,
}

static SHARED: shared::Registry<RwLock<Vectors>> = shared::Registry::new();

/// The owner worker changes the index; reader workers of the same process search it through
/// `attach` at the same time. A change waits for the reads holding the lock, and a read waits only
/// for a change in progress (docs/vector-index-design.md, step 3).
#[napi]
pub struct VectorIndex {
    /// `None` after `close`: later calls fail instead of reaching the released index.
    inner: Option<Arc<RwLock<Vectors>>>,
    /// False for a reader's view: it searches the owner's index and never changes it.
    writable: bool,
}

impl VectorIndex {
    fn owned(index: IdMapIndex) -> Self {
        Self {
            inner: Some(Arc::new(RwLock::new(Vectors {
                index,
                owners: owners::Owners::default(),
            }))),
            writable: true,
        }
    }
    pub(crate) fn read(&self) -> Result<RwLockReadGuard<'_, Vectors>> {
        self.inner
            .as_ref()
            .ok_or_else(|| js_error("Vector index is closed"))?
            .read()
            .map_err(|_| js_error("Vector index is unusable"))
    }
    fn write(&self) -> Result<RwLockWriteGuard<'_, Vectors>> {
        if !self.writable {
            return Err(js_error("Vector index is shared to read only"));
        }
        self.inner
            .as_ref()
            .ok_or_else(|| js_error("Vector index is closed"))?
            .write()
            .map_err(|_| js_error("Vector index is unusable"))
    }
}

#[napi]
impl VectorIndex {
    #[napi(constructor)]
    pub fn new(dimensions: u32, bits: u32) -> Result<Self> {
        Ok(Self::owned(
            IdMapIndex::new(dimensions as usize, bits as usize).map_err(js_error)?,
        ))
    }
    /// Lets reader workers of this process `attach` to this index by `key` while it is open.
    #[napi]
    pub fn share(&self, key: String) -> Result<()> {
        if !self.writable {
            return Err(js_error("Only the owner shares its index"));
        }
        let inner = self
            .inner
            .as_ref()
            .ok_or_else(|| js_error("Vector index is closed"))?;
        SHARED.share(&key, inner).map_err(js_error)
    }
    /// A read-only view of the index the owner shared by `key`: searches see every change the
    /// owner makes. Fails when the owner has not shared it or has closed it.
    #[napi(factory)]
    pub fn attach(key: String) -> Result<Self> {
        Ok(Self {
            inner: Some(
                SHARED
                    .find(&key)
                    .ok_or_else(|| js_error("No shared vector index"))?,
            ),
            writable: false,
        })
    }
    /// Empties the index in place, so the readers attached to it see the empty one too.
    #[napi]
    pub fn reset(&self, dimensions: u32, bits: u32) -> Result<()> {
        let index = IdMapIndex::new(dimensions as usize, bits as usize).map_err(js_error)?;
        let mut vectors = self.write()?;
        vectors.index = index;
        vectors.owners = owners::Owners::default();
        Ok(())
    }
    #[napi]
    pub fn add(&self, vectors: Float32Array, ids: Vec<String>) -> Result<()> {
        let ids = ids
            .iter()
            .map(|id| parse_id(id))
            .collect::<Result<Vec<_>>>()?;
        self.write()?
            .index
            .add_with_ids(&vectors, &ids)
            .map_err(js_error)
    }
    #[napi]
    /// `allowed_ids`: omitted searches the whole index; an empty list returns no results.
    pub fn search(
        &self,
        query: Float32Array,
        k: u32,
        allowed_ids: Option<Vec<String>>,
    ) -> Result<SearchResult> {
        let vectors = self.read()?;
        let index = &vectors.index;
        if Some(query.len()) != index.dim_opt() {
            return Err(js_error("Expected one query vector"));
        }
        if index.is_empty() {
            return Ok(SearchResult {
                ids: vec![],
                scores: vec![],
            });
        }
        let ids = match allowed_ids {
            Some(list) if list.is_empty() => {
                return Ok(SearchResult {
                    ids: vec![],
                    scores: vec![],
                })
            }
            Some(list) => Some(
                list.iter()
                    .map(|id| parse_id(id))
                    .collect::<Result<Vec<_>>>()?,
            ),
            None => None,
        };
        let result = index
            .try_search_with_allowlist(&query, k as usize, ids.as_deref())
            .map_err(js_error)?;
        Ok(SearchResult {
            ids: result.ids.iter().map(|id| id.to_string()).collect(),
            scores: result.scores.iter().map(|score| *score as f64).collect(),
        })
    }
    #[napi]
    pub fn search_controlled(
        &self,
        query: Float32Array,
        k: u32,
        token: String,
        owner_key: String,
        epoch: String,
        request_id: String,
        allowed_ids: Option<Vec<String>>,
    ) -> ControlledSearchResult {
        let Ok(vectors) = self.read() else {
            return search_control::outcome(
                search_control::Outcome::IndexFailed,
                std::time::Instant::now(),
            );
        };
        search_control::search(
            &vectors.index,
            query,
            k,
            token,
            owner_key,
            epoch,
            request_id,
            allowed_ids,
        )
    }
    #[napi]
    pub fn remove(&self, id: String) -> Result<bool> {
        let id = parse_id(&id)?;
        let mut vectors = self.write()?;
        let removed = vectors.index.remove(id);
        vectors.owners.remove(id);
        Ok(removed)
    }
    /// Reads from `session` the node and holder of `ids`, or of every vector when omitted, and
    /// keeps them for reads. A vector whose node the database does not have stays unowned: no read
    /// finds it. Returns how many vectors the index now owns. The database is read before the
    /// lock is taken, so reads go on meanwhile.
    #[napi]
    pub fn attach_owners(
        &self,
        session: ClassInstance<'_, MemoryReadSession>,
        ids: Option<Vec<String>>,
    ) -> Result<u32> {
        let ids = match ids {
            Some(ids) => ids
                .iter()
                .map(|id| parse_id(id))
                .collect::<Result<Vec<_>>>()?,
            None => self.read()?.index.iter_ids().collect(),
        };
        let found = session.owners_of(&ids).map_err(js_error)?;
        let mut vectors = self.write()?;
        // A vector removed while the database was read stays unowned.
        for (id, parent, holder) in found {
            if vectors.index.contains(id) {
                vectors.owners.insert(id, parent, holder);
            }
        }
        Ok(vectors.owners.len() as u32)
    }
    /// Persists the index to `path` and returns how many milliseconds it took: the addon cannot
    /// reach the host's tracer. The first save to a path (and the first after `load` of a file
    /// another writer made) writes the whole index through a temporary file and a rename; every
    /// later save appends only the rows added since and a record per removal, then flips a
    /// checksummed commit header with one `fsync` (turbovec `IdMapIndex::sync`). A crash at any
    /// byte loads as the previous save. One writer per path: the caller holds `CacheLease`.
    #[napi]
    pub fn save(&self, path: String) -> Result<f64> {
        let started = std::time::Instant::now();
        self.write()?.index.sync(path).map_err(js_error)?;
        Ok(ms(started))
    }
    #[napi(factory)]
    pub fn load(path: String) -> Result<Self> {
        Ok(Self::owned(IdMapIndex::load(path).map_err(js_error)?))
    }
    #[napi]
    pub fn dimensions(&self) -> Result<u32> {
        self.read()?
            .index
            .dim_opt()
            .map(|dim| dim as u32)
            .ok_or_else(|| js_error("Index dimension is not initialized"))
    }
    #[napi]
    pub fn bits(&self) -> Result<u32> {
        Ok(self.read()?.index.bit_width() as u32)
    }
    #[napi]
    pub fn size(&self) -> Result<u32> {
        Ok(self.read()?.index.len() as u32)
    }
    /// Releases this handle now rather than at garbage collection. Idempotent. The index itself
    /// goes once the owner and every attached reader have closed.
    #[napi]
    pub fn close(&mut self) {
        self.inner.take();
    }
    #[napi]
    pub fn validate_ids(&self, ids: Vec<String>) -> Result<()> {
        let vectors = self.read()?;
        let index = &vectors.index;
        if ids.len() != index.len() {
            return Err(js_error("Vector snapshot mapping mismatch"));
        }
        let ids = canonical_unique_ids(&ids)
            .ok_or_else(|| js_error("Vector snapshot mapping mismatch"))?;
        for id in ids {
            if !index.contains(id) {
                return Err(js_error("Vector snapshot mapping mismatch"));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::canonical_unique_ids;
    #[test]
    fn snapshot_ids_are_canonical_and_unique() {
        assert_eq!(
            canonical_unique_ids(&["1".into(), "2".into()]),
            Some(vec![1, 2])
        );
        assert!(canonical_unique_ids(&["1".into(), "1".into()]).is_none());
        assert!(canonical_unique_ids(&["01".into()]).is_none());
        assert!(canonical_unique_ids(&["18446744073709551616".into()]).is_none());
    }
}
