import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/agent/chat_layout.dart';
import 'package:lotus_pocket/features/agent/chat_transcript.dart';
import 'package:lotus_pocket/features/agent/pending_dispatch.dart';
import 'package:lotus_pocket/features/agent/turn_progress.dart';
import 'package:lotus_pocket/data/done_marks.dart';
import 'package:lotus_pocket/models/conversation.dart';

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

ChatLayout layout(
  List<ChatItem> items, {
  int? edge,
  List<PendingDispatch> pending = const [],
  String? live,
  Map<String, TurnProgress> progress = const {},
  bool working = false,
  ChatEnding? ending,
}) =>
    ChatLayout.of(ChatTranscript(items),
        historyEdgeAt: edge, pending: pending, live: live,
        progress: progress, working: working, ending: ending);

ChatItem prompt(String turnId) =>
    ChatItem(kind: ChatLine.prompt, text: 'Move SSH', timestamp: noon).inTurn(turnId, null);

TurnProgress progressOf({required bool open, int tools = 2}) => TurnProgress.of(Turn(
      turnId: 't',
      startedAt: noon,
      endedAt: open ? null : noon.add(const Duration(seconds: 70)),
      parts: [
        for (var i = 0; i < tools; i++)
          ToolCallPart(
              id: 'c$i', ts: noon, seq: i, provenance: Provenance.native, toolCallId: 'c$i',
              toolName: 'Read', title: 'a.dart', kind: 'read', status: 'completed',
              locations: const [], files: const []),
      ],
    ));

/// Rows of one kind, in order.
List<T> only<T extends ChatRow>(ChatLayout l) => l.rows.whereType<T>().toList();

void main() {
  _turnBreaks();
  _simpleChat();
  group('day breaks', () {
    test('the first row of any transcript gets one', () {
      expect(only<DayBreakRow>(layout([prose()])), hasLength(1));
    });

    test('a second day opens a second break', () {
      final l = layout([prose(noon), prose(noon.add(const Duration(days: 1)))]);

      expect(only<DayBreakRow>(l), hasLength(2));
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

/// Section H: Chat carries the prompt, one progress signal, the answer and the result.
void _simpleChat() {
  group('the simplified chat', () {
    test('tool steps and reasoning never draw in Chat — they stay in Terminal', () {
      final l = layout([inTurn(step('Read'), 't-1'), inTurn(thinking(), 't-1'), inTurn(prose(), 't-1')]);
      expect(only<LineRow>(l).map((r) => r.item.kind), [ChatLine.prose]);
    });

    test('a failure and a notice still draw', () {
      final l = layout([problem(), notice()]);
      expect(only<LineRow>(l), hasLength(2));
    });

    test('working: the progress sits right under the prompt, above anything said since', () {
      final l = layout(
        [prompt('t-1'), inTurn(step('Read'), 't-1'), inTurn(prose(), 't-1')],
        progress: {'t-1': progressOf(open: true)},
        working: true,
      );
      final kinds = l.rows.where((r) => r is! DayBreakRow).map((r) => r.runtimeType).toList();
      expect(kinds, [LineRow, ProgressRow, LineRow]);
    });

    test('an open turn draws no progress once the agent stopped working', () {
      final l = layout([prompt('t-1')], progress: {'t-1': progressOf(open: true)});
      expect(only<ProgressRow>(l), isEmpty);
    });

    test('a progress row whose turn has no line yet goes last', () {
      final l = layout([], progress: {'t-1': progressOf(open: true)}, working: true);
      expect(l.rows.last, isA<ProgressRow>());
    });

    test('a finished turn folds its work into one summary line above the answer', () {
      final l = layout(
        [prompt('t-1'), inTurn(prose(), 't-1')],
        progress: {'t-1': progressOf(open: false, tools: 4)},
      );
      final kinds = l.rows.where((r) => r is! DayBreakRow).map((r) => r.runtimeType).toList();
      expect(kinds, [LineRow, SummaryRow, LineRow]);
      expect(only<SummaryRow>(l).single.progress.count, 4);
    });

    test('a reply with no work behind it has no summary line', () {
      final l = layout([prompt('t-1'), inTurn(prose(), 't-1')], progress: {'t-1': progressOf(open: false, tools: 0)});
      expect(only<SummaryRow>(l), isEmpty);
    });

    test('the result comes last; the tidy-up offer only once done with uncommitted files', () {
      final items = [prompt('t-1'), inTurn(prose(), 't-1')];
      final notDone = layout(items, ending: const ChatEnding(uncommitted: 3));
      expect(notDone.rows.last, isA<ResultRow>());
      expect(only<TidyRow>(notDone), isEmpty);

      final mark = DoneMark('t-1', noon);
      final done = layout(items, ending: ChatEnding(done: mark, uncommitted: 3));
      expect(only<ResultRow>(done).single.done, mark);
      expect(only<TidyRow>(done).single.files, 3);

      final clean = layout(items, ending: ChatEnding(done: mark));
      expect(only<TidyRow>(clean), isEmpty);
    });

    test('the live phrase is the fallback for a host with no turns, never beside progress', () {
      final l = layout([prompt('t-1')], progress: {'t-1': progressOf(open: true)}, working: true, live: 'atlas');
      expect(only<LiveRow>(l), isEmpty);
    });
  });
}
