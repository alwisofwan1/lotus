import 'conversation.dart';

/// Which store a transcript page was served from.
enum TranscriptSource {
  /// The runner's own conversation file — durable, unbounded, and pageable.
  file,

  /// The host's in-memory hook ring: 60 entries, emptied on every desktop restart.
  ring;

  static TranscriptSource fromWire(Object? raw) =>
      raw == 'file' ? TranscriptSource.file : TranscriptSource.ring;
}

/// One hook event as Chat renders it.
class TranscriptEntry {
  const TranscriptEntry({
    required this.event,
    required this.status,
    required this.title,
    required this.body,
    required this.userPrompt,
    required this.toolTarget,
    required this.timestamp,
    this.linesAdded,
    this.linesRemoved,
    this.toolCallId,
    this.questions,
    this.answers,
    this.bodyTruncated = false,
  });

  final String event;
  final String status;

  /// Tool name — `Edit`, `Bash`, `Read`.
  final String title;
  final String body;
  final String userPrompt;

  /// What the step acted on. Empty until the tool hook delegates to Node
  /// (PLAN §7 no. 11); an empty string is "not reported", not "no target".
  final String toolTarget;
  final DateTime timestamp;

  /// The runner's own id for the tool call this entry is about — on the call and on the result
  /// answering it.
  ///
  /// Pairing used to be by tool **name**, which cannot tell two concurrent `Bash` calls apart.
  /// Null on a hook drop, which carries none, and pairing then falls back to the name.
  final String? toolCallId;

  /// What an `AskUserQuestion` step is putting to the operator, whole — options and the words
  /// under each. Null on every other step, and on a host too old to send it.
  final List<UserQuestion>? questions;

  /// What the operator chose, on the result answering a question. Keyed by the question's own
  /// text. Null on a refused call: `event` is `tool-post-failed` there.
  final Map<String, List<String>>? answers;

  /// **Absent, not zero, when no diff applies.** "Changed nothing" and "no diff
  /// here" are different claims, and a `Read` step must never render `+0 −0`.
  final int? linesAdded;
  final int? linesRemoved;

  /// Whether [body] stops short of what the agent actually said.
  ///
  /// The host caps a hook body at 8000 bytes and cuts it hard — no ellipsis, because
  /// the cap is applied twice and truncation has to stay idempotent. So this flag is
  /// the only way to tell a clipped reply from a finished one, and Chat has to say
  /// so: at the previous 1000-byte cap, 15.8% of real replies were reaching the phone
  /// stopping mid-word with nothing to mark it (measured 2026-08-07).
  ///
  /// Defaults false, which is also what an older host that never sends the field
  /// means.
  final bool bodyTruncated;

  bool get hasDiffStat => linesAdded != null || linesRemoved != null;

  factory TranscriptEntry.fromJson(Map<String, Object?> json) => TranscriptEntry(
        event: json['event']! as String,
        status: json['status']! as String,
        title: json['title']! as String,
        body: json['body']! as String,
        userPrompt: json['userPrompt']! as String,
        toolTarget: json['toolTarget']! as String,
        timestamp: DateTime.fromMillisecondsSinceEpoch(json['timestamp']! as int),
        linesAdded: json['linesAdded'] as int?,
        linesRemoved: json['linesRemoved'] as int?,
        toolCallId: json['toolCallId'] as String?,
        questions: (json['questions'] as List<Object?>?)
            ?.map((e) => UserQuestion.fromJson(e! as Map<String, Object?>))
            .toList(growable: false),
        answers: (json['answers'] as Map<String, Object?>?)?.map(
          (key, value) => MapEntry(
            key,
            (value! as List<Object?>).map((e) => e! as String).toList(growable: false),
          ),
        ),
        // Absent means "not truncated": the host omits it when false to keep the
        // common entry small, so a missing key is an answer, not a gap.
        bodyTruncated: json['bodyTruncated'] as bool? ?? false,
      );
}

/// Whether a transcript is coming, and the third answer the booleans could not carry.
///
/// [unknown] exists because the desktop's pane→runner map is pushed by its UI (ADR-1):
/// it is empty after every restart and until a Canvas board is on screen, and during
/// that window the host genuinely cannot say. The old wire spelled that the same way it
/// spelled "steps are coming" — an absent flag — so Chat waited on panes nobody was
/// going to fill.
enum TranscriptOutlook {
  /// A transcript is expected. Nothing to say; wait, or pull to refresh.
  expected,

  /// This runner has nothing to report *with*. Not late — never coming.
  never,

  /// The host could not place this pane, so it will not guess either way.
  unknown;

  /// Absent means [expected]: only a host with something negative to say speaks up,
  /// which is the same rule `hostSupports` and `runnerReports` already follow.
  static TranscriptOutlook fromWire(Object? raw) => switch (raw) {
        'never' => TranscriptOutlook.never,
        'unknown' => TranscriptOutlook.unknown,
        // An unrecognised value is a newer host talking to an older phone. Treating it
        // as `expected` keeps the screen honest — it draws "nothing yet", which is the
        // one reading that is never a lie about a state we cannot name.
        _ => TranscriptOutlook.expected,
      };
}

/// `GET /m/cell/:paneId/transcript` — the ring the host keeps per pane, oldest first.
class TranscriptSnapshot {
  const TranscriptSnapshot({
    required this.paneId,
    required this.total,
    required this.entries,
    required this.hostSupports,
    required this.runnerReports,
    required this.outlook,
    this.source = TranscriptSource.ring,
    this.oldestCursor,
    this.hasMore = false,
    this.totalEver,
  });

  final String paneId;

  /// Entries returned. The ring is bounded (60 per pane), so this is not all of
  /// history and a client must not present it as such.
  final int total;
  final List<TranscriptEntry> entries;

  /// False only when the host has no hook pipeline at all — a VPS. Then an empty
  /// list means "not knowable here", and the UI points at Terminal instead of
  /// showing "nothing happened yet" (PLAN §7 no. 10).
  final bool hostSupports;

  /// Whether the CLI behind this pane reports anything a transcript is made of.
  ///
  /// False for a runner with no hook mechanism — Codex sends one turn-complete notify
  /// and nothing else. Absent means it does, the same way [hostSupports] reads: only a
  /// host that knows the answer is negative says so out loud.
  final bool runnerReports;

  /// The three-way answer, preferred over [runnerReports] where they overlap.
  ///
  /// Both are sent: [runnerReports] is kept for phones built before this field, and a
  /// `false` there always means [TranscriptOutlook.never]. The reverse does not hold —
  /// an absent [runnerReports] carries no claim at all, which is the whole reason this
  /// exists.
  final TranscriptOutlook outlook;

  /// Where these entries came from.
  ///
  /// The distinction the operator can act on: a [TranscriptSource.file] cell can be
  /// scrolled back into real history, a [TranscriptSource.ring] one cannot — its window
  /// slides on its own, so there is nothing stable to walk backwards through.
  final TranscriptSource source;

  /// Cursor for the next page back, or null when there is nothing older to ask for.
  final int? oldestCursor;

  /// Whether older entries exist beyond this page.
  final bool hasMore;

  /// How many entries the source holds in total.
  ///
  /// Null from a host that predates the field, and from the ring — which cannot answer
  /// it, having only ever counted what it returned. Deliberately separate from [total]:
  /// that one has always meant "entries in this response" and clients in the field read
  /// it that way.
  final int? totalEver;

  bool get isEmptyButKnowable =>
      hostSupports && outlook == TranscriptOutlook.expected && entries.isEmpty;

  factory TranscriptSnapshot.fromJson(Map<String, Object?> json) => TranscriptSnapshot(
        paneId: json['paneId']! as String,
        total: json['total']! as int,
        entries: (json['entries']! as List<Object?>)
            .map((e) => TranscriptEntry.fromJson(e! as Map<String, Object?>))
            .toList(growable: false),
        // Absent means supported: only a host that cannot do it says so out loud.
        hostSupports: json['hostSupports'] as bool? ?? true,
        runnerReports: json['runnerReports'] as bool? ?? true,
        // A host that sends the old field but not the new one still gets read correctly:
        // `runnerReports: false` is `never` by definition, and its absence is `expected`
        // — exactly what this phone did before the field existed.
        // Absent means the ring: a host that predates Fase 3 serves the bounded hook
        // history and nothing else, which is exactly what `ring` describes.
        source: TranscriptSource.fromWire(json['source']),
        oldestCursor: json['oldestCursor'] as int?,
        hasMore: json['hasMore'] as bool? ?? false,
        totalEver: json['totalEver'] as int?,
        outlook: json.containsKey('transcriptOutlook')
            ? TranscriptOutlook.fromWire(json['transcriptOutlook'])
            : (json['runnerReports'] as bool? ?? true)
                ? TranscriptOutlook.expected
                : TranscriptOutlook.never,
      );
}
