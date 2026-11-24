//! ONE concurrency budget shared by every run. Port of `graph-run-slots.ts`.
//!
//! The scheduler decides *what* may run; the pool decides *how many* run at once, across all
//! runs. Each step is a real agent process, so N runs must never mean N × the limit. A freed slot
//! goes to the oldest waiting step of ANY run (FIFO across runs).
//!
//! The pool never starts anything itself: it says which step may start, and the engine starts it.

use std::collections::{HashMap, HashSet, VecDeque};

/// Default ceiling on steps in flight at once, across every run (`DEFAULT_MAX_CONCURRENT_RUNS`).
pub const DEFAULT_MAX_CONCURRENT: usize = 8;

#[derive(Debug, Clone)]
pub struct SlotPool {
    max: usize,
    active: usize,
    waiting: VecDeque<(String, String)>,
    held: HashMap<String, HashSet<String>>,
}

impl SlotPool {
    pub fn new(max: usize) -> Self {
        Self { max: max.max(1), active: 0, waiting: VecDeque::new(), held: HashMap::new() }
    }

    /// Leaves the host two cores, capped at [`DEFAULT_MAX_CONCURRENT`] (`resolveMaxConcurrentRuns`).
    pub fn host_limit() -> usize {
        std::thread::available_parallelism()
            .map(|n| n.get().saturating_sub(2).clamp(1, DEFAULT_MAX_CONCURRENT))
            .unwrap_or(DEFAULT_MAX_CONCURRENT)
    }

    /// True = a slot is claimed for the step and it may start now; false = it waits in line.
    pub fn submit(&mut self, run: &str, node: &str) -> bool {
        if self.active < self.max {
            self.claim(run, node);
            true
        } else {
            self.waiting.push_back((run.to_string(), node.to_string()));
            false
        }
    }

    /// Takes back a slot whose step could not start. A refused step must never hold a slot, or
    /// every run would wedge behind a slot nobody frees.
    pub fn refuse(&mut self, run: &str, node: &str) {
        self.release(run, node);
    }

    /// Frees the slot `node` held. Only the run that holds it can free it. Call
    /// [`SlotPool::next_ready`] afterwards to hand the slot on.
    pub fn release(&mut self, run: &str, node: &str) -> bool {
        let freed = self.held.get_mut(run).is_some_and(|set| set.remove(node));
        if freed {
            self.active -= 1;
        }
        freed
    }

    /// The oldest waiting step that may start now, with its slot already claimed.
    pub fn next_ready(&mut self) -> Option<(String, String)> {
        if self.active >= self.max {
            return None;
        }
        let (run, node) = self.waiting.pop_front()?;
        self.claim(&run, &node);
        Some((run, node))
    }

    /// Drops this run's waiting steps; its in-flight steps keep their slots.
    pub fn drop_queued(&mut self, run: &str) {
        self.waiting.retain(|(r, _)| r != run);
    }

    /// Drops the run's queue and frees every slot it held. Call `next_ready` afterwards.
    pub fn clear(&mut self, run: &str) {
        self.drop_queued(run);
        if let Some(set) = self.held.remove(run) {
            self.active -= set.len();
        }
    }

    pub fn in_flight_of(&self, run: &str) -> usize {
        self.held.get(run).map_or(0, HashSet::len)
    }

    pub fn queued_of(&self, run: &str) -> usize {
        self.waiting.iter().filter(|(r, _)| r == run).count()
    }

    pub fn in_flight(&self) -> usize {
        self.active
    }

    pub fn queued(&self) -> usize {
        self.waiting.len()
    }

    fn claim(&mut self, run: &str, node: &str) {
        self.active += 1;
        self.held.entry(run.to_string()).or_default().insert(node.to_string());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overflow_waits_and_a_freed_slot_goes_fifo_across_runs() {
        let mut pool = SlotPool::new(2);
        assert!(pool.submit("A", "a1"));
        assert!(pool.submit("A", "a2"));
        assert!(!pool.submit("B", "b1"));
        assert!(!pool.submit("A", "a3"));
        assert!(pool.release("A", "a1"));
        assert_eq!(pool.next_ready(), Some(("B".into(), "b1".into())));
        assert_eq!(pool.next_ready(), None);
        assert_eq!(pool.in_flight(), 2);
    }

    #[test]
    fn only_the_holder_frees_a_slot() {
        let mut pool = SlotPool::new(1);
        pool.submit("A", "x");
        assert!(!pool.release("B", "x"));
        assert_eq!(pool.in_flight(), 1);
    }

    #[test]
    fn clear_gives_the_slots_to_other_runs() {
        let mut pool = SlotPool::new(1);
        pool.submit("A", "a1");
        pool.submit("A", "a2");
        pool.submit("B", "b1");
        pool.clear("A");
        assert_eq!(pool.next_ready(), Some(("B".into(), "b1".into())));
        assert_eq!(pool.queued(), 0);
    }

    #[test]
    fn drop_queued_keeps_in_flight() {
        let mut pool = SlotPool::new(1);
        pool.submit("A", "a1");
        pool.submit("A", "a2");
        pool.drop_queued("A");
        assert_eq!((pool.in_flight_of("A"), pool.queued_of("A")), (1, 0));
    }

    #[test]
    fn a_refused_step_holds_no_slot() {
        let mut pool = SlotPool::new(1);
        pool.submit("A", "a1");
        pool.refuse("A", "a1");
        assert_eq!(pool.in_flight(), 0);
    }
}
