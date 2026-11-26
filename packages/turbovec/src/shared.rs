//! The owner worker's indexes, found by the reader workers of the same process: a reader searches
//! the very index the owner writes, under the owner's lock, instead of a copy that lags it
//! (docs/vector-index-design.md, step 3). The key is the host's private owner key.
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock, Weak},
};

pub(crate) struct Registry<T>(OnceLock<Mutex<HashMap<String, Weak<T>>>>);

impl<T> Registry<T> {
    pub(crate) const fn new() -> Self {
        Self(OnceLock::new())
    }
    fn entries(&self) -> &Mutex<HashMap<String, Weak<T>>> {
        self.0.get_or_init(Default::default)
    }
    /// Lets readers find `value` by `key` while it lives; the registry never keeps it alive.
    pub(crate) fn share(&self, key: &str, value: &Arc<T>) -> Result<(), String> {
        if key.is_empty() {
            return Err("Empty share key".into());
        }
        let mut entries = self
            .entries()
            .lock()
            .map_err(|_| "Share registry is unusable".to_string())?;
        entries.retain(|_, entry| entry.strong_count() > 0);
        entries.insert(key.to_owned(), Arc::downgrade(value));
        Ok(())
    }
    /// What the owner shared by `key`, while the owner still holds it.
    pub(crate) fn find(&self, key: &str) -> Option<Arc<T>> {
        self.entries().lock().ok()?.get(key)?.upgrade()
    }
}

#[cfg(test)]
mod tests {
    use super::Registry;
    use std::sync::Arc;
    #[test]
    fn found_only_while_the_owner_holds_it() {
        static NUMBERS: Registry<u32> = Registry::new();
        let shared = Arc::new(7);
        NUMBERS.share("k", &shared).unwrap();
        assert_eq!(NUMBERS.find("k").as_deref(), Some(&7));
        assert!(NUMBERS.find("other").is_none());
        assert!(NUMBERS.share("", &shared).is_err());
        drop(shared);
        assert!(NUMBERS.find("k").is_none());
    }
}
