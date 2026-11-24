import '../models/conversation.dart';

/// The same turns with the newest open question marked answered — **null when there is none**,
/// so a caller can tell "nothing changed" from "changed to the same thing" without comparing.
///
/// The operator's answer shows here first and the runner's own record replaces it on the next
/// read. On a cell with a terminal that record is written only after the keystroke lands, and a
/// card that waited for it had the operator tapping twice. `bb` closes the same gap with a
/// `resolving` status the client sets itself (`domain/pending-interactions.ts`).
List<Turn>? withQuestionAnswered(List<Turn> turns, String chosen) {
  for (var t = turns.length - 1; t >= 0; t--) {
    final parts = turns[t].parts;
    for (var i = parts.length - 1; i >= 0; i--) {
      final part = parts[i];
      if (part is! QuestionPart || !part.isOpen) continue;
      final held = turns[t];
      final settled = QuestionPart(
        id: part.id, ts: part.ts, seq: part.seq, provenance: part.provenance,
        questions: part.questions, toolCallId: part.toolCallId,
        answered: {part.questions.first.question: [chosen]},
      );
      return [...turns]..[t] = Turn(
          turnId: held.turnId, startedAt: held.startedAt, endedAt: held.endedAt,
          stopReason: held.stopReason, parts: [...parts]..[i] = settled,
        );
    }
  }
  return null;
}
