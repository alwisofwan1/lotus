import 'package:flutter/foundation.dart';

import '../../models/conversation.dart';

/// What the agent is doing right now, read from the turn it is in the middle of.
///
/// Three phases, because that is what the parts can actually distinguish — and the
/// distinction is the point of the working row: *thinking* has nothing to show yet,
/// *running a tool* has a target the operator may recognise, and *writing* means the
/// answer is arriving. Saying "working" for all three is what the old indicator did.
///
/// A pure function over what the store already holds. No new field on the wire, no
/// extra request: an open turn (`endedAt == null`) is the whole signal, and its parts
/// say which phase it is in.
enum WorkPhase {
  /// No step and no prose yet — or reasoning, which is thinking made visible.
  thinking,

  /// A tool call is open. [WorkState.verb] and [WorkState.target] name it.
  tool,

  /// Prose is streaming in. **Only ever claimed for a runner that streams**; see
  /// [WorkState.of].
  writing,
}

@immutable
class WorkState {
  const WorkState({
    required this.phase,
    required this.startedAt,
    required this.steps,
    this.verb,
    this.target,
  });

  final WorkPhase phase;

  /// When the turn opened, for the elapsed count. From the host's clock, which is the
  /// same clock the turn's own timestamps come from.
  final DateTime startedAt;

  /// How many tool calls this turn has made, so one slow step does not read as the
  /// only thing that happened.
  final int steps;

  /// The runner's own word for the step — `bash`, `read`, `grep`. Never invented here:
  /// the phone must not translate a tool name it does not own.
  final String? verb;

  /// What the step is working on: a path, a command, a query.
  final String? target;

  /// The state of the last turn, or `null` when nothing is running.
  ///
  /// **`writing` is withheld for a hook-driven cell**, and that is a deliberate refusal
  /// rather than an oversight. A terminal cell's steps arrive from hooks, which fire at
  /// step boundaries only — measured 2026-09-08: four events for a whole turn, the prose
  /// arriving in one piece at the end. There is no moment during which such a cell is
  /// *known* to be writing, so the row says `thinking` and shows the step count instead
  /// of claiming something it cannot see.
  static WorkState? of(List<Turn> turns) {
    if (turns.isEmpty) return null;
    final turn = turns.last;
    if (!turn.isOpen) return null;

    final parts = turn.parts;
    final steps = parts.whereType<ToolCallPart>().length;
    // The runner's own parts stream; converted hook entries do not. A turn with no
    // parts yet is treated as streaming-capable, because refusing on no evidence would
    // make every fresh turn read as the weaker case.
    final streams = parts.isEmpty || parts.any((p) => p.provenance == Provenance.native);

    final open = parts.whereType<ToolCallPart>().where((p) => p.isOpen).lastOrNull;
    if (open != null) {
      return WorkState(
        phase: WorkPhase.tool,
        startedAt: turn.startedAt,
        steps: steps,
        verb: open.toolName.isEmpty ? null : open.toolName,
        target: open.title.isEmpty ? null : open.title,
      );
    }

    final prose = parts.whereType<AssistantTextPart>().lastOrNull;
    final writing = streams && prose != null && prose.streaming;
    return WorkState(
      phase: writing ? WorkPhase.writing : WorkPhase.thinking,
      startedAt: turn.startedAt,
      steps: steps,
    );
  }

  /// What the row says beside the orb. Lowercase mono, like every other machine fact
  /// in this app (`idle`, `no file changes recorded`).
  String get label => switch (phase) {
        WorkPhase.thinking => 'thinking…',
        WorkPhase.writing => 'writing…',
        WorkPhase.tool => verb ?? 'working…',
      };
}
