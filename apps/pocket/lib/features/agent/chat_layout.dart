import 'chat_transcript.dart';
import 'pending_dispatch.dart';
import 'turn_progress.dart';

/// What Chat actually draws, once grouping and separators have been decided.
///
/// A pure function over the transcript: where a day starts, where a turn's progress sits,
/// what ends the list. [ChatTranscript] owns what a *line* is; this owns what a *row* is.
sealed class ChatRow {
  const ChatRow();
}

/// The transcript reaches as far back as the host keeps, and no further.
///
/// Drawn only at the ring's cap, never below it: a shorter history means nothing was
/// dropped, and announcing a limit that is not being hit reads as an apology for a
/// problem that does not exist.
class HistoryEdgeRow extends ChatRow {
  const HistoryEdgeRow(this.entries);

  final int entries;
}

/// Space between two turns — the only thing that separates them.
///
/// **A break, not a container.** [ChatView] builds rows through a `ListView.builder`, and
/// wrapping a turn's rows inside one row would lay a two-hundred-step turn out whole, which
/// is the cost `chat_view.dart:227` exists to avoid. So a turn is a block by the space
/// around it, exactly as [DayBreakRow] makes a day one.
///
/// **Space rather than a rule**, because `MVP.md` allows this screen two colours and no
/// decoration: a line between turns would be a third thing the eye has to read, where the
/// gap is one it already understands.
class TurnBreakRow extends ChatRow {
  const TurnBreakRow();
}

/// `TODAY`, `YESTERDAY`, `7 AUG` — between turns that fall on different days.
class DayBreakRow extends ChatRow {
  const DayBreakRow(this.at);

  final DateTime at;
}

/// One line, drawn as its own kind decides.
class LineRow extends ChatRow {
  const LineRow(this.item);

  final ChatItem item;
}

/// Something the operator said that the host has not echoed back yet.
class PendingRow extends ChatRow {
  const PendingRow(this.pending);

  final PendingDispatch pending;
}

/// The agent is working, and this says so at the end of the transcript.
///
/// The activity phrase already exists in the header, ~500px from the eye that is
/// reading the tail. `MVP.md` names this exact gap as the first thing to revisit if a
/// screen of running agents feels dead — and it is answered here with motion and mono
/// rather than with a colour, because colour still means only two things.
class LiveRow extends ChatRow {
  const LiveRow(this.text);

  final String text;
}

/// The turn in progress: its plan or phases, right under the prompt.
class ProgressRow extends ChatRow {
  const ProgressRow(this.turnId, this.progress);

  final String turnId;
  final TurnProgress progress;
}

/// A finished turn's work, folded into `N steps · 3m 10s ›`.
class SummaryRow extends ChatRow {
  const SummaryRow(this.turnId, this.progress);

  final String turnId;
  final TurnProgress progress;
}

/// The last turn's facts line, the link to its changes.
class ResultRow extends ChatRow {
  const ResultRow();
}

class ChatLayout {
  const ChatLayout(this.rows);

  final List<ChatRow> rows;

  factory ChatLayout.of(
    ChatTranscript transcript, {
    int? historyEdgeAt,
    List<PendingDispatch> pending = const [],
    String? live,
    Map<String, TurnProgress> progress = const {},
    bool working = false,
    bool ending = false,
  }) {
    final rows = <ChatRow>[];
    if (historyEdgeAt != null) rows.add(HistoryEdgeRow(historyEdgeAt));

    final placed = <String>{};
    void place(String? turnId) {
      if (turnId == null || !placed.add(turnId)) return;
      final row = _progressRow(turnId, progress[turnId], working: working);
      if (row != null) rows.add(row);
    }

    DateTime? day;
    String? turn;
    for (final item in transcript.items.where(_shown)) {
      // The prompt ends where anything else of its turn begins, or where the next turn does.
      if (item.kind != ChatLine.prompt || item.turnId != turn) place(turn);
      final dayChanged = day == null || !_sameDay(day, item.timestamp);
      if (dayChanged) {
        rows.add(DayBreakRow(item.timestamp));
        day = item.timestamp;
      }
      // Only between two named turns, and never beside a day break that already separates them.
      if (turn != null && item.turnId != null && item.turnId != turn && !dayChanged) {
        rows.add(const TurnBreakRow());
      }
      turn = item.turnId ?? turn;
      rows.add(LineRow(item));
    }
    place(turn);

    for (final dispatch in pending) {
      rows.add(PendingRow(dispatch));
    }
    // A turn the transcript has no line for yet still says it is running.
    for (final e in progress.entries) {
      if (e.value.took == null) place(e.key);
    }
    if (ending) rows.add(const ResultRow());
    if (!rows.any((r) => r is ProgressRow) && live != null && live.trim().isNotEmpty) {
      rows.add(LiveRow(live.trim()));
    }
    return ChatLayout(rows);
  }

  static ChatRow? _progressRow(String turnId, TurnProgress? p, {required bool working}) {
    if (p == null) return null;
    if (p.took == null && p.steps.isNotEmpty) return working ? ProgressRow(turnId, p) : null;
    return p.took != null && p.count > 0 ? SummaryRow(turnId, p) : null;
  }

  /// Chat is what was said; how the agent got there stays in Terminal.
  static bool _shown(ChatItem item) => item.kind != ChatLine.step && item.kind != ChatLine.thinking;

  static bool _sameDay(DateTime a, DateTime b) =>
      a.year == b.year && a.month == b.month && a.day == b.day;
}
