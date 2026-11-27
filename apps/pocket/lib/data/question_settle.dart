import '../models/conversation.dart';

/// Settle the open question immediately to prevent duplicate answers while waiting for the runner record (`domain/pending-interactions.ts`).
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
