//! The run graph and its topological scheduler. Port of `canvas-run-scheduler.ts`.

use std::collections::{BTreeMap, BTreeSet, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunDependency {
    /// Must complete before `to` may start.
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunGraph {
    pub node_ids: Vec<String>,
    pub deps: Vec<RunDependency>,
}

/// A canvas node as the graph builder needs it: its id and node type.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct CanvasNode {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
}

/// A canvas wire as the graph builder needs it. `wire_kind` absent = "default" (not an order).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasEdge {
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub wire_kind: Option<String>,
}

/// Node types a graph run can dispatch.
pub fn is_runnable_node_type(node_type: &str) -> bool {
    matches!(node_type, "agent" | "team" | "critic" | "human-gate")
}

/// Only a "triggers" or "orchestrates" wire orders a run; any other wire is context, not order.
fn is_execution_edge(edge: &CanvasEdge) -> bool {
    matches!(edge.wire_kind.as_deref(), Some("triggers" | "orchestrates"))
}

/// The runnable graph: runnable nodes, plus dependencies from execution edges between two of them.
/// `scope` limits it to those node ids (a Run Node's members): a node outside is never dispatched,
/// and an edge counts only when both ends are inside. No scope = the whole canvas.
pub fn build_run_graph(nodes: &[CanvasNode], edges: &[CanvasEdge], scope: Option<&HashSet<String>>) -> RunGraph {
    let node_ids: Vec<String> = nodes
        .iter()
        .filter(|n| is_runnable_node_type(&n.node_type) && scope.map_or(true, |s| s.contains(&n.id)))
        .map(|n| n.id.clone())
        .collect();
    let runnable: HashSet<&str> = node_ids.iter().map(String::as_str).collect();
    let deps = edges
        .iter()
        .filter(|e| is_execution_edge(e) && runnable.contains(e.source.as_str()) && runnable.contains(e.target.as_str()))
        .map(|e| RunDependency { from: e.source.clone(), to: e.target.clone() })
        .collect();
    RunGraph { node_ids, deps }
}

/// Transitive descendants of `node_id` along the dependency edges, sorted. Cycle-safe.
pub fn descendants_of(node_id: &str, deps: &[RunDependency]) -> Vec<String> {
    let mut found = BTreeSet::new();
    let mut queue = VecDeque::from([node_id.to_string()]);
    while let Some(current) = queue.pop_front() {
        for d in deps.iter().filter(|d| d.from == current) {
            if found.insert(d.to.clone()) {
                queue.push_back(d.to.clone());
            }
        }
    }
    found.into_iter().collect()
}

/// Topological run over the graph: hands out roots, then releases each dependent once all of its
/// dependencies finish. Pure and synchronous; the engine feeds completions in.
#[derive(Debug, Clone)]
pub struct Scheduler {
    remaining: BTreeMap<String, BTreeSet<String>>,
    deps: Vec<RunDependency>,
    completed: HashSet<String>,
    started: HashSet<String>,
    blocked: HashSet<String>,
}

impl Scheduler {
    /// `seed_completed`: nodes finished in a prior run (resume), never dispatched again.
    pub fn new(graph: &RunGraph, seed_completed: &[String]) -> Self {
        let mut remaining: BTreeMap<String, BTreeSet<String>> =
            graph.node_ids.iter().map(|id| (id.clone(), BTreeSet::new())).collect();
        for d in &graph.deps {
            if remaining.contains_key(&d.from) {
                if let Some(set) = remaining.get_mut(&d.to) {
                    set.insert(d.from.clone());
                }
            }
        }
        let completed = seed_completed.iter().filter(|id| remaining.contains_key(*id)).cloned().collect();
        Self { remaining, deps: graph.deps.clone(), completed, started: HashSet::new(), blocked: HashSet::new() }
    }

    /// Closes a gate (a failed Critic): its not-yet-completed descendants never dispatch.
    pub fn block(&mut self, node_id: &str) -> Vec<String> {
        let mut blocked = Vec::new();
        for id in descendants_of(node_id, &self.deps) {
            if !self.completed.contains(&id) && self.remaining.contains_key(&id) {
                self.blocked.insert(id.clone());
                blocked.push(id);
            }
        }
        blocked
    }

    /// The initially runnable nodes.
    pub fn start(&mut self) -> Vec<String> {
        self.release()
    }

    /// Marks a node finished; returns the nodes it unblocked. Unknown ids are ignored.
    pub fn complete(&mut self, node_id: &str) -> Vec<String> {
        if !self.remaining.contains_key(node_id) {
            return Vec::new();
        }
        self.completed.insert(node_id.to_string());
        self.release()
    }

    pub fn is_done(&self) -> bool {
        self.completed.len() + self.blocked.len() == self.remaining.len()
    }

    /// Unfinished, unblocked nodes, sorted.
    pub fn pending(&self) -> Vec<String> {
        self.remaining.keys().filter(|id| !self.completed.contains(*id) && !self.blocked.contains(*id)).cloned().collect()
    }

    /// Unfinished nodes remain but none can ever run (dependency cycle).
    pub fn has_cycle(&self) -> bool {
        !self.is_done() && self.runnable().is_empty()
    }

    fn runnable(&self) -> Vec<String> {
        self.remaining
            .iter()
            .filter(|(id, deps)| {
                !self.completed.contains(*id)
                    && !self.started.contains(*id)
                    && !self.blocked.contains(*id)
                    && deps.iter().all(|d| self.completed.contains(d))
            })
            .map(|(id, _)| id.clone())
            .collect()
    }

    /// Sorted (BTreeMap order) so dispatch order is deterministic across runs and replays.
    fn release(&mut self) -> Vec<String> {
        let ready = self.runnable();
        for id in &ready {
            self.started.insert(id.clone());
        }
        ready
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn graph(ids: &[&str], deps: &[(&str, &str)]) -> RunGraph {
        RunGraph {
            node_ids: ids.iter().map(|s| s.to_string()).collect(),
            deps: deps.iter().map(|(f, t)| RunDependency { from: f.to_string(), to: t.to_string() }).collect(),
        }
    }

    #[test]
    fn releases_in_dependency_order() {
        let mut s = Scheduler::new(&graph(&["a", "b", "c"], &[("a", "b"), ("a", "c")]), &[]);
        assert_eq!(s.start(), vec!["a"]);
        assert_eq!(s.complete("a"), vec!["b", "c"]);
        assert!(s.complete("b").is_empty());
        s.complete("c");
        assert!(s.is_done());
    }

    #[test]
    fn fan_in_waits_for_every_dependency() {
        let mut s = Scheduler::new(&graph(&["a", "b", "c"], &[("a", "c"), ("b", "c")]), &[]);
        assert_eq!(s.start(), vec!["a", "b"]);
        assert!(s.complete("a").is_empty());
        assert_eq!(s.complete("b"), vec!["c"]);
    }

    #[test]
    fn seeded_nodes_are_not_dispatched_again() {
        let mut s = Scheduler::new(&graph(&["a", "b"], &[("a", "b")]), &["a".into()]);
        assert_eq!(s.start(), vec!["b"]);
    }

    #[test]
    fn a_closed_gate_blocks_its_descendants() {
        let mut s = Scheduler::new(&graph(&["g", "x", "y"], &[("g", "x"), ("x", "y")]), &[]);
        s.start();
        assert_eq!(s.block("g"), vec!["x", "y"]);
        assert!(s.complete("g").is_empty());
        assert!(s.is_done());
    }

    #[test]
    fn a_cycle_is_detected() {
        let mut s = Scheduler::new(&graph(&["a", "b"], &[("a", "b"), ("b", "a")]), &[]);
        assert!(s.start().is_empty());
        assert!(s.has_cycle());
        assert_eq!(s.pending(), vec!["a", "b"]);
    }

    #[test]
    fn reads_the_ts_run_graph_shape() {
        let g: RunGraph = serde_json::from_str(r#"{"nodeIds":["a","b"],"deps":[{"from":"a","to":"b"}]}"#).unwrap();
        assert_eq!(g, graph(&["a", "b"], &[("a", "b")]));
    }

    #[test]
    fn scope_keeps_members_and_inner_edges_only() {
        let nodes = [("a", "agent"), ("b", "critic"), ("out", "agent"), ("n", "note")]
            .map(|(id, t)| CanvasNode { id: id.into(), node_type: t.into() });
        let edge = |s: &str, t: &str, k: Option<&str>| CanvasEdge { source: s.into(), target: t.into(), wire_kind: k.map(Into::into) };
        let edges = [edge("a", "b", Some("triggers")), edge("out", "a", Some("triggers")), edge("a", "b", Some("context")), edge("a", "b", None)];
        let scope: HashSet<String> = ["a", "b", "n"].map(String::from).into();
        let g = build_run_graph(&nodes, &edges, Some(&scope));
        assert_eq!(g, graph(&["a", "b"], &[("a", "b")]));
        assert_eq!(build_run_graph(&nodes, &edges, None).node_ids, vec!["a", "b", "out"]);
    }
}
