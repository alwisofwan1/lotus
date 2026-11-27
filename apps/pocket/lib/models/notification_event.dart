import 'transcript.dart';

/// Hook payloads retain their original snake_case wire format.
class HookNotification {
  const HookNotification({
    required this.kind,
    required this.timestamp,
    this.paneId,
    this.agentType,
    this.event,
    this.toolTarget,
    this.title,
    this.body,
    this.status,
    this.cwd,
    this.userPrompt,
    this.linesAdded,
    this.linesRemoved,
    this.bodyTruncated = false,
  });

  /// `agent_stop`, `tool-pre`, … open on purpose: the pipeline adds kinds.
  final String kind;
  final DateTime timestamp;

  /// Absent when the hook could not be correlated to a pane. Without it the event
  /// cannot be attributed, and the host drops such payloads from the transcript
  /// rather than guessing (PLAN §7 no. 7).
  final String? paneId;
  final String? agentType;
  final String? event;

  /// What the step acted on — `rm src/legacy/shim.ts`, not just `Bash`.
  final String? toolTarget;
  final String? title;
  final String? body;

  /// `needs-input` here is the push-worthy one (job story #1).
  final String? status;
  final String? cwd;

  /// Carries the prompt so the live transcript can show the user turn without refetching.
  final String? userPrompt;

  /// Lines the step added / removed. Null means no diff applies — a `Read` must
  /// never render `+0 −0`.
  final int? linesAdded;
  final int? linesRemoved;

  /// Whether [body] was cut by the host's 8000-byte cap.
  final bool bodyTruncated;

  bool get needsInput => status == 'needs-input';

  factory HookNotification.fromJson(Map<String, Object?> json) => HookNotification(
        kind: json['kind']! as String,
        timestamp: DateTime.fromMillisecondsSinceEpoch(json['timestamp']! as int),
        paneId: json['pane_id'] as String?,
        agentType: json['agent_type'] as String?,
        event: json['event'] as String?,
        toolTarget: json['tool_target'] as String?,
        title: json['title'] as String?,
        body: json['body'] as String?,
        status: json['status'] as String?,
        cwd: json['cwd'] as String?,
        // snake_case here too — this payload is passed through from Rust verbatim,
        // which is the whole reason this class is the one exception in `models/`.
        userPrompt: json['user_prompt'] as String?,
        linesAdded: json['lines_added'] as int?,
        linesRemoved: json['lines_removed'] as int?,
        bodyTruncated: json['body_truncated'] as bool? ?? false,
      );

  /// Converts the wire shape to [TranscriptEntry], where empty strings mean not reported.
  TranscriptEntry toTranscriptEntry() => TranscriptEntry(
        event: event ?? kind,
        status: status ?? '',
        title: title ?? '',
        body: body ?? '',
        userPrompt: userPrompt ?? '',
        toolTarget: toolTarget ?? '',
        timestamp: timestamp,
        linesAdded: linesAdded,
        linesRemoved: linesRemoved,
        bodyTruncated: bodyTruncated,
      );
}
