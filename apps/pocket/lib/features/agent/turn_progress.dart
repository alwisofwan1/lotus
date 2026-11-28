import '../../models/conversation.dart';

enum ProgressState { done, now, next }

/// The four generic phases, used when the agent keeps no plan of its own.
enum Phase {
  reading('Reading'),
  changing('Changing'),
  testing('Testing'),
  summing('Summing up');

  const Phase(this.label);
  final String label;
}

class ProgressStep {
  const ProgressStep(this.label, this.state);
  final String label;
  final ProgressState state;
}

/// Chat's one progress signal for a turn: the agent's plan, else the generic phases.
///
/// Derived from the turn alone, so it rebuilds the same after the app resumes.
class TurnProgress {
  const TurnProgress._(this.steps, {required this.fromPlan, required this.phase, required this.count, this.took});

  final List<ProgressStep> steps;
  final bool fromPlan;

  /// The phase reached; meaningful only when [fromPlan] is false.
  final Phase phase;

  /// What the summary line counts: plan entries, else tool steps.
  final int count;

  /// Null while the turn runs.
  final Duration? took;

  static final RegExp _testCommand =
      RegExp(r'\b(test|tests|spec|pytest|jest|vitest|lint|analy[sz]e)\b', caseSensitive: false);

  static TurnProgress of(Turn turn, {Phase floor = Phase.reading}) {
    final open = turn.isOpen;
    final ended = turn.endedAt;
    final took = ended != null && ended.isAfter(turn.startedAt) ? ended.difference(turn.startedAt) : null;
    final plan = turn.parts.whereType<PlanUpdatePart>().lastOrNull;
    final tools = turn.parts.whereType<ToolCallPart>().length;

    if (plan != null && plan.entries.isNotEmpty) {
      return TurnProgress._(_planSteps(plan.entries, open: open),
          fromPlan: true, phase: floor, count: plan.entries.length, took: took);
    }

    final reached = <Phase>{};
    for (final part in turn.parts) {
      final phase = _phaseOf(part);
      if (phase != null) reached.add(phase);
    }
    final last = turn.parts.lastOrNull;
    if (last is AssistantTextPart || !open && reached.isNotEmpty) reached.add(Phase.summing);
    final top = [floor, ...reached].reduce((a, b) => a.index >= b.index ? a : b);
    reached.add(top);

    final steps = <ProgressStep>[
      for (final p in Phase.values)
        if (!open && reached.contains(p))
          ProgressStep(p.label, ProgressState.done)
        else if (open && p == top)
          ProgressStep(p.label, ProgressState.now)
        else if (open && p.index < top.index && reached.contains(p))
          ProgressStep(p.label, ProgressState.done)
        else if (open && p.index > top.index)
          ProgressStep(p.label, ProgressState.next),
    ];
    return TurnProgress._(steps, fromPlan: false, phase: top, count: tools, took: took);
  }

  static Phase? _phaseOf(Part part) => switch (part) {
        ToolCallPart(:final kind) when kind == 'edit' || kind == 'delete' || kind == 'move' => Phase.changing,
        ToolCallPart(:final kind, :final title) when kind == 'execute' && _testCommand.hasMatch(title) =>
          Phase.testing,
        ToolCallPart() => Phase.reading,
        _ => null,
      };

  static List<ProgressStep> _planSteps(List<PlanEntry> entries, {required bool open}) {
    if (!open) return [for (final e in entries) ProgressStep(e.content, ProgressState.done)];
    // A plan with nothing marked in progress is still being worked: the first open entry is.
    final anyNow = entries.any((e) => e.status == PlanStatus.inProgress);
    final firstOpen = entries.indexWhere((e) => e.status != PlanStatus.completed);
    return [
      for (var i = 0; i < entries.length; i++)
        ProgressStep(
          entries[i].content,
          switch (entries[i].status) {
            PlanStatus.completed => ProgressState.done,
            PlanStatus.inProgress => ProgressState.now,
            PlanStatus.pending => !anyNow && i == firstOpen ? ProgressState.now : ProgressState.next,
          },
        ),
    ];
  }
}
