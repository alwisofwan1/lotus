import '../../models/cell.dart';
import '../../models/conversation.dart';
import 'question_flow.dart';

/// Whether the last ask can reasonably be called finished; gates the header's Done so it
/// never nags. Idle, a clean `end_turn`, real work, no open plan step, and closing words
/// that do not ask something. [promptPending] is a sentence sent but not yet echoed back.
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
