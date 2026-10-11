use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::fs::File;
mod sqlite_bridge;
mod read_session;
mod search_control;
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

// Synchronous methods are called only inside the owning Node worker.
#[napi]
pub struct VectorIndex {
    inner: IdMapIndex,
}

#[napi]
impl VectorIndex {
    #[napi(constructor)]
    pub fn new(dimensions: u32, bits: u32) -> Result<Self> {
        Ok(Self {
            inner: IdMapIndex::new(dimensions as usize, bits as usize).map_err(js_error)?,
        })
    }
    #[napi]
    pub fn add(&mut self, vectors: Float32Array, ids: Vec<String>) -> Result<()> {
        let ids = ids
            .iter()
            .map(|id| parse_id(id))
            .collect::<Result<Vec<_>>>()?;
        self.inner.add_with_ids(&vectors, &ids).map_err(js_error)
    }
    #[napi]
    /// `allowed_ids`: omitted searches the whole index; an empty list returns no results.
    pub fn search(
        &self,
        query: Float32Array,
        k: u32,
        allowed_ids: Option<Vec<String>>,
    ) -> Result<SearchResult> {
        if Some(query.len()) != self.inner.dim_opt() {
            return Err(js_error("Expected one query vector"));
        }
        if self.inner.len() == 0 {
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
        let result = self
            .inner
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
        search_control::search(
            &self.inner,
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
    pub fn remove(&mut self, id: String) -> Result<bool> {
        Ok(self.inner.remove(parse_id(&id)?))
    }
    #[napi]
    pub fn save(&self, path: String) -> Result<()> {
        self.inner.write(path).map_err(js_error)
    }
    #[napi(factory)]
    pub fn load(path: String) -> Result<Self> {
        Ok(Self {
            inner: IdMapIndex::load(path).map_err(js_error)?,
        })
    }
    #[napi]
    pub fn dimensions(&self) -> Result<u32> {
        self.inner
            .dim_opt()
            .map(|dim| dim as u32)
            .ok_or_else(|| js_error("Index dimension is not initialized"))
    }
    #[napi]
    pub fn bits(&self) -> u32 {
        self.inner.bit_width() as u32
    }
    #[napi]
    pub fn size(&self) -> u32 {
        self.inner.len() as u32
    }
    #[napi]
    pub fn validate_ids(&self, ids: Vec<String>) -> Result<()> {
        if ids.len() != self.inner.len() {
            return Err(js_error("Vector snapshot mapping mismatch"));
        }
        let ids = canonical_unique_ids(&ids)
            .ok_or_else(|| js_error("Vector snapshot mapping mismatch"))?;
        for id in ids {
            if !self.inner.contains(id) {
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
