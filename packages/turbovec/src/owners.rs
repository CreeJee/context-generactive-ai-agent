//! Which node each vector of the index belongs to, and what holds that node: its conversation, or
//! its project when it has none (docs/vector-index-design.md, step 1). A read builds its allowlist
//! from here instead of from SQLite, then checks only its hits against the snapshot.
//!
//! A conversation never changes (`nodes` triggers forbid it), and a fold moves whole conversations
//! between projects, so a vector held by its conversation stays found under the conversation's
//! current project. A node outside a conversation is never folded: a project holding one is not
//! folded. What is held here may still be stale (a vector not committed yet, or one waiting to be
//! removed): the read's check against SQLite drops those hits.
use std::collections::HashMap;

/// What holds a node: its conversation, or its project when it has none.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub(crate) enum Holder {
    Session(String),
    Project(String),
}

#[derive(Default)]
pub(crate) struct Owners {
    /// Each holder's vectors, vector id to parent node seq.
    groups: HashMap<Holder, HashMap<u64, u64>>,
    /// The holder of each vector, to remove it.
    holder_of: HashMap<u64, Holder>,
}

impl Owners {
    pub(crate) fn insert(&mut self, id: u64, parent: u64, holder: Holder) {
        self.remove(id);
        self.groups
            .entry(holder.clone())
            .or_default()
            .insert(id, parent);
        self.holder_of.insert(id, holder);
    }
    pub(crate) fn remove(&mut self, id: u64) {
        let Some(holder) = self.holder_of.remove(&id) else {
            return;
        };
        if let Some(group) = self.groups.get_mut(&holder) {
            group.remove(&id);
            if group.is_empty() {
                self.groups.remove(&holder);
            }
        }
    }
    /// The vectors `holder` holds, vector id to parent node seq.
    pub(crate) fn group(&self, holder: &Holder) -> Option<&HashMap<u64, u64>> {
        self.groups.get(holder)
    }
    pub(crate) fn len(&self) -> usize {
        self.holder_of.len()
    }
}

#[cfg(test)]
mod tests {
    use super::{Holder, Owners};
    #[test]
    fn a_vector_has_one_holder() {
        let mut owners = Owners::default();
        let session = Holder::Session("s".into());
        let project = Holder::Project("p".into());
        owners.insert(1, 10, session.clone());
        owners.insert(2, 10, session.clone());
        owners.insert(2, 11, project.clone());
        assert_eq!(owners.group(&session).map(|group| group.len()), Some(1));
        assert_eq!(
            owners.group(&project).and_then(|group| group.get(&2)),
            Some(&11)
        );
        owners.remove(1);
        assert!(owners.group(&session).is_none());
        assert_eq!(owners.len(), 1);
    }
}
