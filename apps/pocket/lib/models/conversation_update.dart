import 'conversation.dart';

/// One thing that changed in a cell's conversation, as the host says it.
///
/// The live counterpart of [ConversationPage], carried by the `conversation` frame. Three
/// shapes, because a turn's header, its parts, and the characters inside a part that is
/// still being written all move independently: a turn opens before anything is in it and
/// closes after everything is, a part inside it is revised in place — a tool call when its
/// result lands — and prose grows a chunk at a time while the agent is speaking.
///
/// **Absent is unchanged, never cleared.** A turn header arrives whole each time, so a
/// second one for the same `turnId` replaces the header and leaves the parts alone.
sealed class ConversationUpdate {
  const ConversationUpdate();

  /// Returns null for a shape this build does not know — a newer host is not an error
  /// (ADR-10), and a frame that cannot be read is dropped rather than thrown.
  static ConversationUpdate? fromJson(Map<String, Object?> json) {
    try {
      return switch (json['kind']) {
        'turn' => TurnUpdate.fromJson(json['turn']! as Map<String, Object?>),
        'part' => PartUpdate(
            turnId: json['turnId']! as String,
            part: Part.fromJson(json['part']! as Map<String, Object?>),
          ),
        'text' => TextDelta(
            turnId: json['turnId']! as String,
            partId: json['partId']! as String,
            delta: json['delta']! as String,
            seq: json['seq']! as int,
          ),
        _ => null,
      };
    } on Object {
      return null;
    }
  }
}

/// A turn opening, or the same turn closing with its stop reason. Carries no parts.
class TurnUpdate extends ConversationUpdate {
  const TurnUpdate({
    required this.turnId,
    required this.startedAt,
    this.endedAt,
    this.stopReason,
  });

  final String turnId;
  final DateTime startedAt;
  final DateTime? endedAt;
  final String? stopReason;

  bool get isOpen => endedAt == null;

  factory TurnUpdate.fromJson(Map<String, Object?> json) => TurnUpdate(
        turnId: json['turnId']! as String,
        startedAt: DateTime.fromMillisecondsSinceEpoch(json['startedAt']! as int),
        endedAt: switch (json['endedAt']) {
          final int ms => DateTime.fromMillisecondsSinceEpoch(ms),
          _ => null,
        },
        stopReason: json['stopReason'] as String?,
      );

  /// The turn this update describes, keeping whatever parts were already held for it.
  Turn onto(Turn? held) => Turn(
        turnId: turnId,
        startedAt: startedAt,
        endedAt: endedAt,
        stopReason: stopReason,
        parts: held?.parts ?? const [],
      );
}

/// One part arriving, or the same part being revised. Matched by [Part.id].
class PartUpdate extends ConversationUpdate {
  const PartUpdate({required this.turnId, required this.part});

  final String turnId;
  final Part part;
}

/// Characters appended to a part that is still being written — **only the new ones**.
///
/// The shape streaming prose actually arrives in. A growing part used to be re-sent whole on
/// every chunk, so a reply crossed the network once per chunk: the host's own ACP capture is
/// 46 chunks for two sentences, which is 46 copies of a growing prefix over a tailnet to a
/// phone. The host sends the chunk now, and this is the frame that carries it.
///
/// **Safe to apply blindly, and safe to ignore entirely.** The host will never send one for
/// a part it has not already opened with a [PartUpdate], nor after that part has settled
/// (`part/opens-before-delta`, `part/settles-once` in `contract/README.md`) — so a delta for
/// an unknown part means this client is behind, not that the host misspoke, and dropping it
/// costs nothing: the whole part is re-sent when it settles.
class TextDelta extends ConversationUpdate {
  const TextDelta({
    required this.turnId,
    required this.partId,
    required this.delta,
    required this.seq,
  });

  final String turnId;

  /// The [Part.id] this grows.
  final String partId;

  /// What was appended — not the text so far.
  final String delta;

  /// The part's `seq` after the append, so this orders against a later revision.
  final int seq;
}
