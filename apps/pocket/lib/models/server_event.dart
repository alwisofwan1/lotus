import 'cell.dart';
import 'conversation_update.dart';
import 'host_id.dart';
import 'notification_event.dart';

/// Everything the host pushes over the single WebSocket per host (ADR-10).
///
/// `sealed` so a `switch` over it is exhaustive at compile time — the reason
/// ADR-10 chose hand-written models over codegen: this guarantee is the language's,
/// not a build step's.
sealed class ServerEvent {
  const ServerEvent();

  /// The socket supplies host identity (ADR-13); unknown frames must be skipped (ADR-10).
  static ServerEvent? fromJson(Map<String, Object?> json, {required HostId host}) {
    switch (json['type']) {
      case 'hello':
        return HelloEvent.fromJson(json);
      case 'fleet.changed':
        return FleetChangedEvent(cells: Cell.listFromJson(json['cells'], host: host));
      case 'cell.output':
        return CellOutputEvent(
          paneId: json['paneId']! as String,
          chunk: json['chunk']! as String,
          byteOffset: json['byteOffset']! as int,
        );
      case 'cell.truncated':
        return CellTruncatedEvent(
          paneId: json['paneId']! as String,
          requestedFromByte: json['requestedFromByte']! as int,
          servedFromByte: json['servedFromByte']! as int,
        );
      case 'notification':
        return NotificationEvent(
          hook: HookNotification.fromJson(json['event']! as Map<String, Object?>),
        );
      case 'conversation':
        final update = ConversationUpdate.fromJson(json['update']! as Map<String, Object?>);
        // A delta shape this build cannot read is dropped, not raised: the host is allowed
        // to be newer, and the `notification` lane carries the same step anyway.
        return update == null
            ? null
            : ConversationFrame(
                paneId: json['paneId']! as String,
                agentType: json['agentType'] as String? ?? '',
                update: update,
                cursor: json['cursor'] as int? ?? 0,
              );
      case 'conversation.truncated':
        return ConversationTruncatedFrame(
          paneId: json['paneId']! as String,
          requestedFromCursor: json['requestedFromCursor'] as int? ?? 0,
          oldestCursor: json['oldestCursor'] as int? ?? 0,
        );
      default:
        return null;
    }
  }
}

/// First frame on every connection, so the app never has to ask separately.
class HelloEvent extends ServerEvent {
  const HelloEvent({
    required this.hostId,
    required this.hostLabel,
    required this.mode,
    required this.caps,
  });

  final HostId hostId;
  final String hostLabel;

  /// `client` (desktop) or `standalone` (VPS). Decides the shape of the Agent
  /// page before it opens: a VPS host has no Chat (PLAN §7 no. 10).
  final String mode;
  final HostCaps caps;

  bool get isStandalone => mode == 'standalone';

  factory HelloEvent.fromJson(Map<String, Object?> json) => HelloEvent(
        hostId: HostId(json['hostId']! as String),
        hostLabel: json['hostLabel']! as String,
        mode: json['mode']! as String,
        caps: HostCaps.fromJson(json['hostCaps']! as Map<String, Object?>),
      );
}

class FleetChangedEvent extends ServerEvent {
  const FleetChangedEvent({required this.cells});

  final List<Cell> cells;
}

class CellOutputEvent extends ServerEvent {
  const CellOutputEvent({
    required this.paneId,
    required this.chunk,
    required this.byteOffset,
  });

  final String paneId;

  /// Raw PTY bytes as text, ANSI included. Goes straight to `Terminal.write`.
  final String chunk;

  /// Offset this chunk ends at — what a later `resume` asks from.
  final int byteOffset;
}

/// Sent instead of silently serving a later position when the 64 KB ring buffer
/// no longer reaches back to what was asked for (R-4).
class CellTruncatedEvent extends ServerEvent {
  const CellTruncatedEvent({
    required this.paneId,
    required this.requestedFromByte,
    required this.servedFromByte,
  });

  final String paneId;
  final int requestedFromByte;
  final int servedFromByte;

  int get missingBytes => servedFromByte - requestedFromByte;
}

class NotificationEvent extends ServerEvent {
  const NotificationEvent({required this.hook});

  final HookNotification hook;
}

/// One conversation delta for a cell — the same step [NotificationEvent] carries, as the
/// `Part` it amounts to.
///
/// Both lanes ride for every step, so a reader takes one or the other and never both, or it
/// draws each step twice. Which lane is available is `hostCaps` → `conversation-stream`.
class ConversationFrame extends ServerEvent {
  const ConversationFrame({
    required this.paneId,
    required this.agentType,
    required this.update,
    this.cursor = 0,
  });

  final String paneId;

  /// The runner, because a [Part] carries none and the app files by cell.
  final String agentType;
  final ConversationUpdate update;

  /// Monotonic per cell for the life of the host process — what a reconnect sends back so the
  /// host can replay what was missed. Zero from a host older than the resume lane, which is
  /// simply a host this app cannot resume from; it refetches, as it always did.
  final int cursor;
}

/// The host holds nothing as far back as the cursor this app asked to resume from.
///
/// One REST fetch repairs it. The frame exists so the gap is **named**: replaying the oldest
/// deltas the host still had would look like success and leave the transcript missing its
/// middle — the same contract as [CellTruncatedEvent] for PTY output.
class ConversationTruncatedFrame extends ServerEvent {
  const ConversationTruncatedFrame({
    required this.paneId,
    required this.requestedFromCursor,
    required this.oldestCursor,
  });

  final String paneId;
  final int requestedFromCursor;

  /// The oldest cursor the host still holds. Zero when it holds nothing for this cell.
  final int oldestCursor;
}
