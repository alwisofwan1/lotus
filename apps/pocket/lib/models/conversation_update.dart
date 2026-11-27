import 'conversation.dart';

/// Absent fields remain unchanged; turn headers replace headers without clearing parts.
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

/// Ignore deltas for unknown parts: settled parts are resent (`contract/README.md`, `part/opens-before-delta`, `part/settles-once`).
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
