import '../../models/cell.dart';
import '../../models/conversation.dart';
import 'question_flow.dart';

/// Whether what the operator asked for can reasonably be called finished.
///
/// Gates the header's Done: it must not show on every idle pane, or it nags. Every check
/// reads data the app already holds. Idle with a known turn, an ordinary `end_turn`, real
/// work (a tool call or plan step), a plan with nothing open, and closing words that do
/// not end on a question. [promptPending] is a sentence sent but not yet echoed back.
bool taskLooksFinished({
  required Cell cell,
  required List<Turn> turns,
  bool promptPending = false,
}) {
  if (!cell.turnKnown || !cell.isIdle || promptPending) return false;
  final last = turns.lastOrNull;
  if (last == null || last.isOpen || last.stopReason != 'end_turn') return false;
  if (asking(turns) || last.parts.any((p) => p is ErrorPart)) return false;

  final worked = last.parts.any((p) => p is ToolCallPart || p is PlanUpdatePart && p.entries.isNotEmpty);
  if (!worked) return false;

  final plan = last.parts.whereType<PlanUpdatePart>().lastOrNull;
  if (plan != null && plan.entries.any((e) => e.status != PlanStatus.completed)) return false;

  final closing = last.parts.whereType<AssistantTextPart>().lastOrNull?.text;
  return closing == null || !_endsWithQuestion(closing);
}

/// The last non-empty line, ignoring a closing bracket or quote after the `?`.
bool _endsWithQuestion(String text) {
  final line = text.trimRight().split('\n').lastWhere((l) => l.trim().isNotEmpty, orElse: () => '');
  return line.trimRight().replaceFirst(RegExp(r'''[)\]"'*_`]+$'''), '').endsWith('?');
}
