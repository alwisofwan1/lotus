import '../models/conversation.dart';
import '../models/conversation_update.dart';

/// Update parts by identity where held, even if a delta names a different turn, to avoid duplicates.
void applyUpdate(List<Turn> held, ConversationUpdate update) {
  switch (update) {
    case TurnUpdate():
      final i = held.indexWhere((t) => t.turnId == update.turnId);
      if (i >= 0) {
        held[i] = update.onto(held[i]);
      } else {
        held.add(update.onto(null));
      }
    case PartUpdate(:final turnId, :final part):
      final elsewhere = held.indexWhere((t) => t.parts.any((p) => p.id == part.id));
      if (elsewhere >= 0 && held[elsewhere].turnId != turnId) {
        held[elsewhere] = _with(held[elsewhere], [
          for (final p in held[elsewhere].parts) if (p.id == part.id) part else p,
        ]);
        return;
      }
      var i = held.indexWhere((t) => t.turnId == turnId);
      if (i < 0) {
        // A part for a turn no header has opened yet — frames can arrive out of order, and a
        // part that cannot be placed is a step the operator never sees.
        held.add(Turn(turnId: turnId, startedAt: part.ts, parts: const []));
        i = held.length - 1;
      }
      final parts = [...held[i].parts];
      final at = parts.indexWhere((p) => p.id == part.id);
      if (at >= 0) {
        parts[at] = part;
      } else {
        parts.add(part);
      }
      held[i] = _with(held[i], parts);
    case TextDelta(:final partId, :final delta, :final seq):
      // Found by part id across every turn, for the same reason a [PartUpdate] is: the part
      // is the step, and it is grown where it lives. The frame's `turnId` is not consulted —
      // the host guarantees it matches (`part/one-turn`), and a delta that disagreed would
      // be a step to grow, not a step to move.
      final i = held.indexWhere((t) => t.parts.any((p) => p.id == partId));
      // A delta for a part this client never received. The host does not send one
      // (`part/opens-before-delta`), so this is a page that has not been seeded yet, or one
      // whose oldest turns were trimmed — and dropping it costs nothing, because the whole
      // part is re-sent when it settles.
      if (i < 0) return;
      final parts = [
        for (final p in held[i].parts) p.id == partId ? _grown(p, delta, seq) : p,
      ];
      held[i] = _with(held[i], parts);
  }
}

/// The same part with [delta] appended, or unchanged for a part that carries no text.
///
/// Only the two kinds that stream can grow. Anything else arriving here would be the host
/// breaking its own grammar, and the honest answer is to leave the part exactly as it is
/// rather than to invent a shape for it.
Part _grown(Part part, String delta, int seq) => switch (part) {
      AssistantTextPart() => AssistantTextPart(
          id: part.id,
          ts: part.ts,
          seq: seq,
          provenance: part.provenance,
          text: part.text + delta,
          streaming: part.streaming,
          truncated: part.truncated,
        ),
      ReasoningPart() => ReasoningPart(
          id: part.id,
          ts: part.ts,
          seq: seq,
          provenance: part.provenance,
          text: part.text + delta,
          redacted: part.redacted,
        ),
      _ => part,
    };

Turn _with(Turn turn, List<Part> parts) => Turn(
      turnId: turn.turnId,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      stopReason: turn.stopReason,
      parts: parts,
    );
