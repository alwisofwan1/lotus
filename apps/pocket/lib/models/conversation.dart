/// Preserves unknown parts, nullable counts, and explicit truncation for newer hosts.
/// See `plans/pocket-chat-conversation-model/RESEARCH.md` and `contract/README.md`.
library;

part 'question.dart';

/// How much of one part kind this cell's pipeline delivers.
enum CapLevel {
  expected,
  partial,
  never;

  /// An unrecognised level is a newer host; `partial` is the reading that neither
  /// promises nor refuses.
  static CapLevel fromWire(Object? raw) => switch (raw) {
        'expected' => CapLevel.expected,
        'never' => CapLevel.never,
        _ => CapLevel.partial,
      };
}

/// Per runner, per part kind — the three-way answer `TranscriptOutlook` gave once per pane.
class RunnerTranscriptCaps {
  const RunnerTranscriptCaps(this._levels);

  final Map<String, CapLevel> _levels;

  static const List<String> kinds = [
    'turns', 'text', 'streaming', 'reasoning', 'toolCalls', 'toolStatus', 'diff',
    'output', 'permission', 'plan', 'subagent', 'usage', 'mode',
  ];

  /// A kind the host did not name reads `never`: an absent capability is one this host
  /// cannot deliver, the same rule `hostCaps.features` follows.
  CapLevel of(String kind) => _levels[kind] ?? CapLevel.never;

  bool get reportsAnything => _levels.values.any((l) => l != CapLevel.never);

  factory RunnerTranscriptCaps.fromJson(Map<String, Object?> json) => RunnerTranscriptCaps({
        for (final kind in kinds)
          if (json.containsKey(kind)) kind: CapLevel.fromWire(json[kind]),
      });
}

/// Where a part's facts came from — `hook` (the ring), `derived` (the runner's file),
/// `native` (a runner's own structured record; no host produces it yet).
enum Provenance {
  native,
  derived,
  hook;

  static Provenance fromWire(Object? raw) => switch (raw) {
        'native' => Provenance.native,
        'derived' => Provenance.derived,
        _ => Provenance.hook,
      };
}

/// One part of a turn. Subclasses are the ACP update kinds; [UnknownPart] is the rest.
sealed class Part {
  const Part({required this.id, required this.ts, required this.seq, required this.provenance});

  /// Stable across pages and the REST/stream seam — what a client dedupes by.
  final String id;
  final DateTime ts;
  final int seq;
  final Provenance provenance;

  factory Part.fromJson(Map<String, Object?> json) {
    final id = json['id']! as String;
    final ts = DateTime.fromMillisecondsSinceEpoch(json['ts']! as int);
    final seq = json['seq']! as int;
    final provenance = Provenance.fromWire(json['provenance']);
    final type = json['type'] as String? ?? '';
    return switch (type) {
      'user_message' => UserMessagePart(
          id: id, ts: ts, seq: seq, provenance: provenance, text: json['text']! as String),
      'assistant_text' => AssistantTextPart(
          id: id, ts: ts, seq: seq, provenance: provenance,
          text: json['text']! as String,
          streaming: json['state'] == 'streaming',
          truncated: json['truncated'] as bool? ?? false),
      'reasoning' => ReasoningPart(
          id: id, ts: ts, seq: seq, provenance: provenance,
          text: json['text']! as String, redacted: json['redacted'] as bool? ?? false),
      'tool_call' => ToolCallPart.fromJson(json, id: id, ts: ts, seq: seq, provenance: provenance),
      'question' => QuestionPart.fromJson(json, id: id, ts: ts, seq: seq, provenance: provenance),
      'status' => StatusPart(
          id: id, ts: ts, seq: seq, provenance: provenance,
          state: json['state']! as String, detail: json['detail'] as String?),
      'error' => ErrorPart(
          id: id, ts: ts, seq: seq, provenance: provenance,
          message: json['message']! as String, recoverable: json['recoverable'] as bool? ?? false),
      'plan_update' => PlanUpdatePart(
          id: id, ts: ts, seq: seq, provenance: provenance,
          entries: PlanEntry.listFrom(json['entries'])),
      // `permission`, `mode_change`, `result` are kept whole so the UI can still name them.
      _ => UnknownPart(
          id: id, ts: ts, seq: seq, provenance: provenance,
          rawType: json['rawType'] as String? ?? type,
          summary: json['summary'] as String? ?? json['title'] as String? ?? ''),
    };
  }
}

class UserMessagePart extends Part {
  const UserMessagePart({
    required super.id, required super.ts, required super.seq, required super.provenance,
    required this.text,
  });
  final String text;
}

class AssistantTextPart extends Part {
  const AssistantTextPart({
    required super.id, required super.ts, required super.seq, required super.provenance,
    required this.text, required this.streaming, required this.truncated,
  });
  final String text;
  final bool streaming;
  /// Whether [text] stops short of what the agent said.
  final bool truncated;
}

class ReasoningPart extends Part {
  const ReasoningPart({
    required super.id, required super.ts, required super.seq, required super.provenance,
    required this.text, required this.redacted,
  });
  final String text;
  final bool redacted;
}

/// One file a tool changed. Counts are **absent, not zero**, when no diff was measured.
class FileDiff {
  const FileDiff({required this.path, required this.op, this.additions, this.deletions});
  final String path;
  final String op;
  final int? additions;
  final int? deletions;
  bool get hasStat => additions != null || deletions != null;

  factory FileDiff.fromJson(Map<String, Object?> json) => FileDiff(
        path: json['path']! as String,
        op: json['op'] as String? ?? 'modify',
        additions: json['additions'] as int?,
        deletions: json['deletions'] as int?,
      );
}

class ToolCallPart extends Part {
  const ToolCallPart({
    required super.id, required super.ts, required super.seq, required super.provenance,
    required this.toolCallId, required this.toolName, required this.title,
    required this.kind, required this.status, required this.locations, required this.files,
  });

  final String toolCallId;
  /// The runner's own name for the tool — `Edit`, `exec`.
  final String toolName;
  /// What it acted on — a path, a command, a query.
  final String title;
  /// ACP kind: `read edit delete move search execute think fetch other`. Kept as the wire
  /// string so a newer host's kind still draws as a step.
  final String kind;
  /// `pending in_progress completed failed cancelled`.
  final String status;
  final List<String> locations;
  /// Per-file counts, empty when the tool reported no diff.
  final List<FileDiff> files;

  bool get isOpen => status == 'pending' || status == 'in_progress';
  bool get hasDiff => files.any((f) => f.hasStat);
  int? get additions => hasDiff ? files.fold<int>(0, (n, f) => n + (f.additions ?? 0)) : null;
  int? get deletions => hasDiff ? files.fold<int>(0, (n, f) => n + (f.deletions ?? 0)) : null;

  factory ToolCallPart.fromJson(
    Map<String, Object?> json, {
    required String id, required DateTime ts, required int seq, required Provenance provenance,
  }) {
    final diff = json['diff'] as Map<String, Object?>?;
    return ToolCallPart(
      id: id, ts: ts, seq: seq, provenance: provenance,
      toolCallId: json['toolCallId'] as String? ?? id,
      toolName: json['toolName']! as String,
      title: json['title'] as String? ?? '',
      kind: json['kind'] as String? ?? 'other',
      status: json['status'] as String? ?? 'completed',
      locations: [
        for (final l in (json['locations'] as List<Object?>?) ?? const <Object?>[])
          (l! as Map<String, Object?>)['path']! as String,
      ],
      files: [
        for (final f in (diff?['files'] as List<Object?>?) ?? const <Object?>[])
          FileDiff.fromJson(f! as Map<String, Object?>),
      ],
    );
  }
}

enum PlanStatus { pending, inProgress, completed }

class PlanEntry {
  const PlanEntry({required this.content, required this.status});
  final String content;
  final PlanStatus status;

  /// Entries with no text are dropped: a blank step would draw as an empty row.
  static List<PlanEntry> listFrom(Object? raw) => [
        for (final e in (raw as List<Object?>?) ?? const <Object?>[])
          if (e case {'content': final String content} when content.trim().isNotEmpty)
            PlanEntry(
              content: content.trim(),
              status: switch ((e as Map<String, Object?>)['status']) {
                'completed' => PlanStatus.completed,
                'in_progress' => PlanStatus.inProgress,
                _ => PlanStatus.pending,
              },
            ),
      ];
}

/// The agent's own todo list, replaced whole on every update.
class PlanUpdatePart extends Part {
  const PlanUpdatePart({
    required super.id, required super.ts, required super.seq, required super.provenance,
    required this.entries,
  });
  final List<PlanEntry> entries;
}

class StatusPart extends Part {
  const StatusPart({
    required super.id, required super.ts, required super.seq, required super.provenance,
    required this.state, this.detail,
  });
  /// `running idle requires_action compacted retrying ended`.
  final String state;
  final String? detail;
}

class ErrorPart extends Part {
  const ErrorPart({
    required super.id, required super.ts, required super.seq, required super.provenance,
    required this.message, required this.recoverable,
  });
  final String message;
  final bool recoverable;
}

class UnknownPart extends Part {
  const UnknownPart({
    required super.id, required super.ts, required super.seq, required super.provenance,
    required this.rawType, required this.summary,
  });
  final String rawType;
  final String summary;
}

class Turn {
  const Turn({required this.turnId, required this.startedAt, required this.parts, this.endedAt, this.stopReason});
  final String turnId;
  final DateTime startedAt;
  /// Null while the turn is still open.
  final DateTime? endedAt;
  /// `end_turn cancelled error max_turns`, null while open.
  final String? stopReason;
  final List<Part> parts;
  bool get isOpen => endedAt == null;

  factory Turn.fromJson(Map<String, Object?> json) => Turn(
        turnId: json['turnId']! as String,
        startedAt: DateTime.fromMillisecondsSinceEpoch(json['startedAt']! as int),
        endedAt: switch (json['endedAt']) {
          final int ms => DateTime.fromMillisecondsSinceEpoch(ms),
          _ => null,
        },
        stopReason: json['stopReason'] as String?,
        parts: [
          for (final p in json['parts']! as List<Object?>) Part.fromJson(p! as Map<String, Object?>),
        ],
      );
}

class ConversationPage {
  const ConversationPage({
    required this.paneId, required this.runner, required this.capabilities, required this.source,
    required this.turns, required this.hasMore, required this.hostSupports,
    this.runnerLabel, this.oldestCursor, this.totalEver, this.outlook,
  });

  final String paneId;
  final String runner;
  final String? runnerLabel;
  final RunnerTranscriptCaps capabilities;
  /// `file` or `ring` — whether paging back is possible at all.
  final String source;
  final List<Turn> turns;
  final int? oldestCursor;
  final bool hasMore;
  final int? totalEver;
  /// Absent means supported, as on the transcript route.
  final bool hostSupports;
  /// `never` / `unknown`, null when a transcript is expected.
  final String? outlook;

  factory ConversationPage.fromJson(Map<String, Object?> json) => ConversationPage(
        paneId: json['paneId']! as String,
        runner: json['runner']! as String,
        runnerLabel: json['runnerLabel'] as String?,
        capabilities: RunnerTranscriptCaps.fromJson(json['capabilities']! as Map<String, Object?>),
        source: json['source'] as String? ?? 'ring',
        turns: [
          for (final t in json['turns']! as List<Object?>) Turn.fromJson(t! as Map<String, Object?>),
        ],
        oldestCursor: json['oldestCursor'] as int?,
        hasMore: json['hasMore'] as bool? ?? false,
        totalEver: json['totalEver'] as int?,
        hostSupports: json['hostSupports'] as bool? ?? true,
        outlook: json['transcriptOutlook'] as String?,
      );
}
