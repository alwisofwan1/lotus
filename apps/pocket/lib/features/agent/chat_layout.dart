import 'chat_transcript.dart';
import 'pending_dispatch.dart';
import 'work_state.dart';

/// What Chat actually draws, once grouping and separators have been decided.
///
/// A layer between [ChatTranscript] and the widget, and it exists for one reason:
/// **three of the nine Chat fixes are decisions about a run of lines, not about a
/// line** — where a day starts, which steps collapse together, where the tail is. Left
/// in the widget they would be computed inside `build`, which is both wasteful and
/// untestable without pumping a frame. Here they are a pure function over a list.
///
/// [ChatTranscript] still owns what a *line* is. This owns what a *row* is.
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

/// A run of tool steps, collapsed.
///
/// **A step carrying a diff is never swallowed into one of these**, and that is the
/// rule that keeps the collapse honest: reads and greps are how an agent looks around,
/// and folding twelve of them into one line loses nothing, but an edit changed
/// something on the operator's machine and has to stay countable.
class StepRunRow extends ChatRow {
  const StepRunRow(this.id, this.steps);

  /// Identity for "is this one expanded", built from the run's first step rather than
  /// from where the run sits.
  ///
  /// A list index would have been simpler and wrong: the host's ring holds sixty entries
  /// and trims from the **front**, so every index shifts the moment it overflows — and an
  /// expanded capsule would silently close while a different one opened. Composed the
  /// same way `LiveTranscript` keys its entries, and for the same reason: hook timestamps
  /// come from `Date.now()` and a burst can share a millisecond, so the time alone is not
  /// enough to tell two steps apart.
  final String id;

  final List<ChatItem> steps;

  /// How many of the folded lines are tool steps.
  ///
  /// [StepCapsule] prints this over the word `steps`, and `steps.length` stopped answering
  /// that question the moment reasoning began folding into the same run: a run of two
  /// thoughts and one `Read` is one step, not three. The reasoning is still named — it is
  /// in [summary] — so nothing is hidden by counting it apart.
  int get stepCount => steps.where((s) => s.kind != ChatLine.thinking).length;

  /// What the capsule prints where it used to print `${steps.length} steps`.
  ///
  /// A string rather than a number, for two reasons the number could not carry. The
  /// threshold is now one, so `1 steps` became reachable — bad English on a screen that
  /// spends a whole typeface on voice. And a run may be reasoning alone, where `0 steps`
  /// states a count for something that was never counted; it says `thinking` instead,
  /// which is what happened.
  String get countLabel => switch (stepCount) {
        0 => 'thinking',
        1 => '1 step',
        final n => '$n steps',
      };

  /// `thinking ×2, grep, read ×3` — each kind of work named once, in the order it first
  /// appeared.
  ///
  /// **Reasoning is named, not counted silently.** A [ChatLine.thinking] line carries no
  /// `label` — there is no tool behind it — so it used to fall through the `isEmpty`
  /// guard and vanish from the summary, leaving a fold that said `read` over a run whose
  /// first half was the agent working something out. It is the one material a "thinking"
  /// state is made of, and a fold that hides it is the same defect
  /// `chat_transcript.dart` fixed on 2026-09-08, one layer up.
  ///
  /// Named rather than timed: a duration would have to come from the gap between two
  /// timestamps in the run, and a single reasoning line has no gap — it would read
  /// `thinking 0s`, which claims something false about a thing that did happen.
  String get summary {
    final counts = <String, int>{};
    for (final step in steps) {
      final label = step.kind == ChatLine.thinking
          ? 'thinking'
          : (step.label ?? '').trim().toLowerCase();
      if (label.isEmpty) continue;
      counts[label] = (counts[label] ?? 0) + 1;
    }
    return counts.entries
        .map((e) => e.value > 1 ? '${e.key} ×${e.value}' : e.key)
        .join(', ');
  }
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

/// The agent is working, and this is what it is doing — the row that replaced the
/// phrase above it wherever the host sends a conversation.
///
/// Kept apart from [LiveRow] rather than replacing it: a host that predates the
/// conversation lane sends a phrase and no turns, and this app has **no minimum host
/// version**. Where there are turns, this wins; where there are not, the phrase still
/// draws (`work_state.dart`, `widgets/working_row.dart`).
class WorkRow extends ChatRow {
  const WorkRow(this.state);

  final WorkState state;
}

/// What the last turn left behind, as one line at the end of the transcript.
///
/// The end, not the flow: it is a footnote to everything above it. Added only when
/// there is something to say — `TurnTail.has` is the gate, and it is checked before
/// this row exists rather than inside the widget, so the empty case costs no row.
class TailRow extends ChatRow {
  const TailRow();
}

class ChatLayout {
  const ChatLayout(this.rows);

  final List<ChatRow> rows;

  /// How many lines of work it takes before the run folds.
  ///
  /// **Two**, since issue 03 of `plans/pocket-chat-turn-presentation`. It was three, argued
  /// on tidiness: *"two steps collapsed into `2 steps` costs a tap and saves one line — that
  /// is a worse screen, not a tidier one"*. Right about what the fold was then for, and not
  /// about what it is for now — the answer has to be the only thing on the page at full
  /// size — so two folds where it used to take three.
  ///
  /// **One does not, and that was settled by evidence rather than by taste.** The first cut
  /// of this took the threshold to one, on the reasoning that every run should look the
  /// same. Three tests in `agent_screen_test.dart` then went red, each asserting that a
  /// single step shows the path it touched (`lib/search.dart`, `lib/renamed.dart`,
  /// `lib/offscreen.dart`) — written separately, for a different concern, and all three
  /// treating that path as the proof the event reached the screen. A lone step is already
  /// recessive: mono, dim, one glyph wide, against serif prose. Folding it bought
  /// consistency and sold the one fact the line carries.
  static const int runThreshold = 2;

  factory ChatLayout.of(
    ChatTranscript transcript, {
    int? historyEdgeAt,
    List<PendingDispatch> pending = const [],
    String? live,
    WorkState? work,
    bool tail = false,
  }) {
    final rows = <ChatRow>[];
    if (historyEdgeAt != null) rows.add(HistoryEdgeRow(historyEdgeAt));

    final items = transcript.items;
    DateTime? day;
    String? turn;
    var i = 0;

    while (i < items.length) {
      final item = items[i];
      final dayChanged = day == null || !_sameDay(day, item.timestamp);
      if (dayChanged) {
        rows.add(DayBreakRow(item.timestamp));
        day = item.timestamp;
      }
      // Only between two *named* turns. A line with no turn belongs to whichever one is
      // open — `ChatTranscript` can be built directly, and a break there would announce a
      // boundary the host never drew. Never beside a day break either, which already
      // separates what this would separate.
      if (turn != null && item.turnId != null && item.turnId != turn && !dayChanged) {
        rows.add(const TurnBreakRow());
      }
      turn = item.turnId ?? turn;

      if (_collapsible(item)) {
        var end = i;
        // Bounded by the day too, so a run spanning midnight cannot swallow the break
        // that separates the two days.
        while (end < items.length &&
            _collapsible(items[end]) &&
            _sameDay(item.timestamp, items[end].timestamp)) {
          end++;
        }
        if (end - i >= runThreshold) {
          rows.add(StepRunRow(_idOf(item), items.sublist(i, end)));
          i = end;
          continue;
        }
      }

      rows.add(LineRow(item));
      i++;
    }

    for (final dispatch in pending) {
      rows.add(PendingRow(dispatch));
    }
    // After the pending lines and before the working row: the account belongs to the
    // turn that just ended, and a turn that is running has not left anything yet.
    if (tail) rows.add(const TailRow());
    // The richer row wins. Both would be the same fact twice, in two voices.
    if (work != null) {
      rows.add(WorkRow(work));
    } else if (live != null && live.trim().isNotEmpty) {
      rows.add(LiveRow(live.trim()));
    }

    return ChatLayout(rows);
  }

  /// Whether a line is *work* — how the agent got somewhere, rather than what it said.
  ///
  /// Reasoning belongs here beside a tool step: both answer "what did it do to get there",
  /// and giving them two folds gave one idea two appearances. [ChatLine.problem] never
  /// folds — red is one of the two colours this screen allows, and its whole job is to be
  /// seen.
  static bool _collapsible(ChatItem item) =>
      (item.kind == ChatLine.step && item.diff == null) || item.kind == ChatLine.thinking;

  static String _idOf(ChatItem first) =>
      '${first.timestamp.microsecondsSinceEpoch}|${first.label}|${first.text}';

  static bool _sameDay(DateTime a, DateTime b) =>
      a.year == b.year && a.month == b.month && a.day == b.day;
}
