import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/agent/chat_layout.dart';
import 'package:lotus_pocket/features/agent/chat_transcript.dart';
import 'package:lotus_pocket/features/agent/pending_dispatch.dart';

final DateTime noon = DateTime.utc(2026, 8, 7, 12);

ChatItem step(String label, {String? diff, DateTime? at}) => ChatItem(
      kind: ChatLine.step,
      text: 'src/legacy/shim.ts',
      label: label,
      diff: diff,
      timestamp: at ?? noon,
    );

ChatItem prose([DateTime? at]) =>
    ChatItem(kind: ChatLine.prose, text: 'Done.', timestamp: at ?? noon);

ChatItem inTurn(ChatItem item, String turnId) => item.inTurn(turnId, null);

ChatItem thinking([DateTime? at]) => ChatItem(
      kind: ChatLine.thinking,
      text: 'Flaky di CI tapi tidak lokal biasanya soal waktu.',
      timestamp: at ?? noon,
    );

ChatItem notice([DateTime? at]) => ChatItem(
      kind: ChatLine.notice,
      text: 'five_hour plan limit: allowed_warning.',
      label: 'notice',
      timestamp: at ?? noon,
    );

ChatItem problem([DateTime? at]) => ChatItem(
      kind: ChatLine.problem,
      text: 'Interrupted',
      label: 'error',
      timestamp: at ?? noon,
    );

ChatLayout layout(List<ChatItem> items, {int? edge, List<PendingDispatch> pending = const [], String? live}) =>
    ChatLayout.of(ChatTranscript(items), historyEdgeAt: edge, pending: pending, live: live);

/// Rows of one kind, in order.
List<T> only<T extends ChatRow>(ChatLayout l) => l.rows.whereType<T>().toList();

void main() {
  _turnBreaks();
  _workFold();
  group('runs of look-around steps collapse; edits never do', () {
    test('three consecutive steps become one capsule', () {
      final l = layout([step('Grep'), step('Read'), step('Read')]);

      final runs = only<StepRunRow>(l);
      expect(runs, hasLength(1));
      expect(runs.single.steps, hasLength(3));
      // And none of them is also drawn as its own line.
      expect(only<LineRow>(l), isEmpty);
    });

    test('two now fold, where it used to take three', () {
      // Changed by issue 03. The old rule read: "collapsing two into `2 steps` costs a
      // tap and saves one line — a worse screen, not a tidier one." True while the fold
      // was about tidiness; the fold is now about leaving the answer alone at full size,
      // and two lines of work already compete with it.
      final l = layout([step('Grep'), step('Read')]);

      expect(only<StepRunRow>(l), hasLength(1));
      expect(only<LineRow>(l), isEmpty);
    });

    test('a step carrying a diff breaks the run and keeps its own line', () {
      // The rule that keeps the collapse honest: a read is how an agent looks around,
      // an edit changed something on the operator's machine.
      final l = layout([
        step('Read'),
        step('Read'),
        step('Edit', diff: '+0 −34'),
        step('Read'),
        step('Read'),
      ]);

      // The edit keeps its own line; the reads either side fold into a run each.
      expect(only<StepRunRow>(l), hasLength(2));
      expect(only<LineRow>(l), hasLength(1));
      expect(only<LineRow>(l).single.item.diff, '+0 −34');
    });

    test('prose interrupts a run rather than being swallowed by it', () {
      final l = layout([step('Read'), step('Read'), prose(), step('Read'), step('Read')]);

      expect(only<StepRunRow>(l), hasLength(2));
      // The prose is the one thing left at full size between them.
      expect(only<LineRow>(l), hasLength(1));
      expect(only<LineRow>(l).single.item.kind, ChatLine.prose);
    });

    test('the summary names each tool once, counting repeats', () {
      final run = only<StepRunRow>(
        layout([step('Grep'), step('Read'), step('Read'), step('Read'), step('Grep')]),
      ).single;

      expect(run.summary, 'grep ×2, read ×3');
    });

    test('the id comes from the run itself, so trimming the front cannot move it', () {
      // The host's ring holds sixty entries and drops the oldest, so every list index
      // shifts on overflow — an expanded capsule would silently close while a different
      // one opened.
      final head = [prose(), prose()];
      final run = [step('Read'), step('Read'), step('Read')];

      final before = only<StepRunRow>(layout([...head, ...run])).single;
      final after = only<StepRunRow>(layout(run)).single;

      expect(after.id, before.id);
    });
  });

  group('day breaks', () {
    test('the first row of any transcript gets one', () {
      expect(only<DayBreakRow>(layout([prose()])), hasLength(1));
    });

    test('a second day opens a second break', () {
      final l = layout([prose(noon), prose(noon.add(const Duration(days: 1)))]);

      expect(only<DayBreakRow>(l), hasLength(2));
    });

    test('a run cannot span a day, so the break is never swallowed', () {
      final tomorrow = noon.add(const Duration(days: 1));
      final l = layout([
        step('Read'),
        step('Read'),
        step('Read'),
        step('Read', at: tomorrow),
        step('Read', at: tomorrow),
        step('Read', at: tomorrow),
      ]);

      expect(only<DayBreakRow>(l), hasLength(2));
      expect(only<StepRunRow>(l), hasLength(2));
    });
  });

  group('the edges of the list', () {
    test('the history edge is drawn only when the ring is full', () {
      expect(only<HistoryEdgeRow>(layout([prose()], edge: 60)).single.entries, 60);
      // Below the cap nothing was dropped, so announcing a limit would be an apology
      // for a problem that does not exist.
      expect(only<HistoryEdgeRow>(layout([prose()])), isEmpty);
    });

    test('pending dispatches sit after everything the host has said', () {
      final l = layout([prose()], pending: const [PendingDispatch(text: 'run the tests')]);

      expect(l.rows.last, isA<PendingRow>());
    });

    test('the live line comes last of all — it is the tail', () {
      final l = layout(
        [prose()],
        pending: const [PendingDispatch(text: 'run the tests')],
        live: 'atlas · 312 of 476 suites',
      );

      expect(l.rows.last, isA<LiveRow>());
      expect(l.rows[l.rows.length - 2], isA<PendingRow>());
    });

    test('a blank live phrase draws no line at all', () {
      expect(only<LiveRow>(layout([prose()], live: '   ')), isEmpty);
    });

    test('an empty transcript with nothing pending is an empty layout', () {
      expect(layout(const []).rows, isEmpty);
    });
  });

  group('a dispatch hands over to the host, and only then', () {
    test('a prompt the host is now carrying settles it', () {
      const sent = PendingDispatch(text: 'run the tests');

      expect(sent.settledBy({'run the tests'}), isTrue);
    });

    test('an unrelated prompt does not', () {
      const sent = PendingDispatch(text: 'run the tests');

      expect(sent.settledBy({'clean up the legacy files'}), isFalse);
    });

    test('a landed one settles too — the host is simply slower than the accept', () {
      const sent = PendingDispatch(text: 'run the tests');

      expect(sent.landed.settledBy({'run the tests'}), isTrue);
    });

    test('a refused dispatch is never settled — it is waiting for a retry, not an echo', () {
      const sent = PendingDispatch(text: 'run the tests');

      // The prompt appearing would be some *other* turn's; folding a refusal into it
      // would report a sentence as delivered that never left the device.
      expect(sent.refused.settledBy({'run the tests'}), isFalse);
    });
  });
}

/// One turn reads as one block, and the thing between two turns is space.
///
/// `ChatLayout` grouped by day and by run of steps, and by nothing else: six kinds of line
/// arrived as equal neighbours in one long column, so the agent's answer was one row among
/// many. Issue 02 of `plans/pocket-chat-turn-presentation`.
///
/// **A break, not a container.** `ChatView` builds rows through a `ListView.builder`, and
/// nesting a turn's rows inside one row would lay a two-hundred-step turn out whole — the
/// cost `chat_view.dart:227` exists to avoid.
void _turnBreaks() {
  group('a turn is one block, separated by space', () {
    test('a break sits between two turns, and nowhere else', () {
      final l = layout([
        inTurn(prose(), 't-1'),
        inTurn(prose(), 't-2'),
      ]);

      expect(only<TurnBreakRow>(l), hasLength(1));
    });

    test('a line belonging to no turn does not open a block of its own', () {
      // `ChatTranscript` can be built directly, and a line built outside `ofTurns` carries
      // no turn. It belongs to whatever turn is open, not to a new one — otherwise the gap
      // would announce a boundary the host never drew.
      final l = layout([
        inTurn(prose(), 't-1'),
        prose(),
        inTurn(prose(), 't-1'),
      ]);

      expect(only<TurnBreakRow>(l), isEmpty);
    });

    test('three turns make two breaks — nothing above the first', () {
      final l = layout([
        inTurn(prose(), 't-1'),
        inTurn(prose(), 't-2'),
        inTurn(prose(), 't-3'),
      ]);

      expect(only<TurnBreakRow>(l), hasLength(2));
      // Above the first turn is the day, and a break there would separate it from nothing.
      expect(l.rows.first, isA<DayBreakRow>());
    });

    test('a day break already separates them, so no turn break joins it', () {
      // Two marks in the same gap would say the same thing twice, and the day is the
      // larger claim.
      final l = layout([
        inTurn(prose(noon), 't-1'),
        inTurn(prose(noon.add(const Duration(days: 1))), 't-2'),
      ]);

      expect(only<DayBreakRow>(l), hasLength(2));
      expect(only<TurnBreakRow>(l), isEmpty);
    });
  });
}

/// One line for the work, so the answer is the only thing at full size.
///
/// Reasoning and tool steps used to be two separate folds — [ThinkingRow] and
/// [StepRunRow] — and a lone step did not fold at all. Three appearances for one idea:
/// *this is what it did to get there*. Issue 03 of `plans/pocket-chat-turn-presentation`.
void _workFold() {
  group('reasoning and steps fold together', () {
    test('reasoning next to steps is one run, not two rows', () {
      final l = layout([thinking(), step('Grep'), step('Read')]);

      expect(only<StepRunRow>(l), hasLength(1));
      expect(only<LineRow>(l), isEmpty);
      // `ThinkingRow` is gone entirely — reasoning has no fold of its own any more.
    });

    test('one step keeps its line, and with it the path it touched', () {
      // Settled by evidence: taking the threshold to one turned three tests in
      // `agent_screen_test.dart` red, each asserting a single step shows its target.
      // A lone step is already recessive against serif prose — mono, dim, one glyph
      // wide — so folding it bought consistency and sold the fact the line carries.
      final l = layout([step('Grep')]);

      expect(only<StepRunRow>(l), isEmpty);
      expect(only<LineRow>(l), hasLength(1));
      expect(only<LineRow>(l).single.item.text, 'src/legacy/shim.ts');
    });

    test('the summary names thinking ahead of the tools', () {
      final run = only<StepRunRow>(layout([thinking(), step('Grep'), step('Read')])).single;

      expect(run.summary, 'thinking, grep, read');
    });

    test('two thoughts are counted like any other repeat', () {
      final run = only<StepRunRow>(layout([thinking(), thinking(), step('Read')])).single;

      expect(run.summary, 'thinking ×2, read');
    });

    test('no thinking, no mention of it', () {
      final run = only<StepRunRow>(layout([step('Grep'), step('Read')])).single;

      expect(run.summary, 'grep, read');
    });

    test('the count counts steps, and thinking is not a step', () {
      // The capsule prints this number over the word "steps". With reasoning folded into
      // the same run, `steps.length` started answering a different question than the one
      // the label asks.
      final run = only<StepRunRow>(layout([thinking(), thinking(), step('Read')])).single;

      expect(run.stepCount, 1);
      expect(run.steps, hasLength(3));
    });

    test('the count reads as English, singular and plural', () {
      String labelOf(List<ChatItem> items) =>
          only<StepRunRow>(layout(items)).single.countLabel;

      expect(labelOf([thinking(), step('Read')]), '1 step');
      expect(labelOf([step('Read'), step('Grep')]), '2 steps');
      // A run that is only the agent working something out has no steps to count, and
      // `0 steps` would be a number where the truth is "none of this was a step".
      expect(labelOf([thinking(), thinking()]), 'thinking');
    });

    test('a notice never folds either — a quota wall must be seen coming', () {
      final l = layout([step('Read'), step('Grep'), notice(), step('Read'), step('Grep')]);

      expect(only<StepRunRow>(l), hasLength(2));
      expect(only<LineRow>(l), hasLength(1));
      expect(only<LineRow>(l).single.item.kind, ChatLine.notice);
    });

    test('a failure never folds — red is there to be seen', () {
      // Runs of two either side, so the only line left unfolded is the failure itself.
      final l = layout([step('Read'), step('Grep'), problem(), step('Read'), step('Grep')]);

      expect(only<StepRunRow>(l), hasLength(2));
      expect(only<LineRow>(l), hasLength(1));
      expect(only<LineRow>(l).single.item.kind, ChatLine.problem);
    });
  });
}
