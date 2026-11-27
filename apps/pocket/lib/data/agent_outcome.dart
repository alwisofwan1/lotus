import '../models/conversation.dart';
import '../models/transcript.dart';
import 'conversation_builder.dart';

/// Derive the last turn from held entries without claiming truncated text or a diff (PLAN.md §2.2).
class AgentOutcome {
  const AgentOutcome({
    required this.closing,
    required this.closingTruncated,
    required this.files,
    required this.finishedAt,
    this.ranFor,
  });

  /// The agent's last words, as far as the host kept them.
  final String closing;
  final bool closingTruncated;

  /// Every path an edit touched in this turn, in first-touched order, stats summed.
  final List<ChangedFile> files;

  final DateTime finishedAt;

  /// From the turn's first recorded entry to its stop. Null when the turn is one entry
  /// long — a duration of zero would be a claim, not a measurement.
  final Duration? ranFor;

  int get added => files.fold(0, (sum, f) => sum + f.added);
  int get removed => files.fold(0, (sum, f) => sum + f.removed);
  bool get changedFiles => files.isNotEmpty;

  /// `+212 −34 · 4 files`, or null when nothing was edited — the row then says so in
  /// words rather than printing `+0 −0`, which reads as a measurement of nothing.
  String? get diffSummary => changedFiles
      ? '+$added −$removed · ${files.length} ${files.length == 1 ? 'file' : 'files'}'
      : null;

  /// Only a completed last turn is a stable outcome; preserve absent counts.
  static AgentOutcome? of(List<TranscriptEntry> entries) =>
      ofTurns(turnsFromEntries(entries, Provenance.hook));

  static AgentOutcome? ofTurns(List<Turn> turns) {
    if (turns.isEmpty) return null;
    final turn = turns.last;
    final endedAt = turn.endedAt;
    if (endedAt == null || turn.stopReason != 'end_turn') return null;

    final byPath = <String, ChangedFile>{};
    AssistantTextPart? closing;
    for (final part in turn.parts) {
      switch (part) {
        case AssistantTextPart():
          closing = part;
        case ToolCallPart() when part.hasDiff:
          for (final f in part.files) {
            if (f.path.isEmpty) continue;
            final seen = byPath[f.path];
            byPath[f.path] = ChangedFile(
              f.path,
              added: (seen?.added ?? 0) + (f.additions ?? 0),
              removed: (seen?.removed ?? 0) + (f.deletions ?? 0),
            );
          }
        default:
      }
    }

    final first = turn.startedAt;
    return AgentOutcome(
      closing: closing?.text ?? '',
      closingTruncated: closing?.truncated ?? false,
      files: List.unmodifiable(byPath.values),
      finishedAt: endedAt,
      ranFor: endedAt.isAfter(first) ? endedAt.difference(first) : null,
    );
  }
}

class ChangedFile {
  const ChangedFile(this.path, {required this.added, required this.removed});

  final String path;
  final int added;
  final int removed;
}
