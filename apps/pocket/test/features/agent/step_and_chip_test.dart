import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/features/agent/chat_transcript.dart';
import 'package:lotus_pocket/features/agent/widgets/changes_chip.dart';
import 'package:lotus_pocket/features/agent/chat_layout.dart';
import 'package:lotus_pocket/features/agent/widgets/chat_steps.dart';
import 'package:lotus_pocket/features/agent/widgets/thinking_block.dart';
import 'package:lotus_pocket/models/conversation.dart';

final _at = DateTime.fromMillisecondsSinceEpoch(1788820000000);

Widget _host(Widget child) => MaterialApp(
      theme: ThemeData.dark().copyWith(extensions: const [AppTokens.dark]),
      home: Scaffold(body: Center(child: child)),
    );

Part _tool(String status) => ToolCallPart(
    id: 'c$status', ts: _at, seq: 0, provenance: Provenance.native, toolCallId: 'c',
    toolName: 'bash', title: 'bun test pty', kind: 'execute', status: status,
    locations: const [], files: const []);

Part _error(String message) => ErrorPart(
    id: 'e', ts: _at, seq: 1, provenance: Provenance.native, message: message,
    recoverable: false);

List<ChatItem> _items(List<Part> parts) =>
    ChatTranscript.ofTurns([Turn(turnId: 't-1', startedAt: _at, parts: parts)]).items;

void main() {
  _capsuleBody();
  _noticeLine();
  /// Three meanings shared one appearance until 2026-09-08: a failed command, an
  /// interruption and a file being read all drew the same mono line. The transcript
  /// could say a command ran and not whether it worked — the one thing it was being
  /// read for.
  group('a step carries how it ended', () {
    test('the runner own status rides along', () {
      expect(_items([_tool('completed')]).single.status, 'completed');
      expect(_items([_tool('failed')]).single.status, 'failed');
    });

    test('an error is its own kind of line now, not a step', () {
      final items = _items([_error('Interrupted by the operator')]);
      expect(items.single.kind, ChatLine.problem);
      expect(items.single.text, 'Interrupted by the operator');
    });

    testWidgets('the glyph column says done, failed, or merely happened', (tester) async {
      for (final (status, glyph) in [
        ('completed', '✓'),
        ('failed', '✕'),
        ('cancelled', '–'),
        ('in_progress', '·'),
      ]) {
        await tester.pumpWidget(_host(StepLine(item: _items([_tool(status)]).single)));
        expect(find.text(glyph), findsOneWidget, reason: 'for $status');
      }
    });

    testWidgets('a failure is drawn in the colour that already means that', (tester) async {
      await tester.pumpWidget(_host(ProblemLine(item: _items([_error('boom')]).single)));
      final text = tester.widget<Text>(find.text('boom'));
      expect(text.style?.color, AppTokens.dark.error);
      expect(find.text('✕'), findsOneWidget);
    });
  });

  group('the header chip', () {
    testWidgets('names the count and opens the account', (tester) async {
      var opened = 0;
      await tester.pumpWidget(_host(ChangesChip(files: 3, onTap: () => opened++)));
      expect(find.textContaining('CHANGED'), findsOneWidget);
      await tester.tap(find.byType(ChangesChip));
      expect(opened, 1);
    });

    testWidgets('reaches the minimum a thumb needs', (tester) async {
      await tester.pumpWidget(_host(ChangesChip(files: 1, onTap: () {})));
      expect(tester.getSize(find.byType(ChangesChip)).height, greaterThanOrEqualTo(28));
    });

    testWidgets('says one sentence to a screen reader', (tester) async {
      final handle = tester.ensureSemantics();
      await tester.pumpWidget(_host(ChangesChip(files: 1, onTap: () {})));
      expect(find.bySemanticsLabel('1 file changed on disk. Tap for the list'), findsOneWidget);
      handle.dispose();
    });
  });
}

/// Opening a fold must draw each line in its own voice.
///
/// Reasoning folds into the same run as tool steps since issue 03 of
/// `plans/pocket-chat-turn-presentation`. The expanded body drew every member through
/// [StepLine] — mono, with a tool glyph in the left column — which is the voice for what
/// the agent *did*, not for what it was working out. `MVP.md` buys a whole typeface for
/// that difference.
void _capsuleBody() {
  testWidgets('an opened fold draws reasoning as reasoning, not as a step', (tester) async {
    final row = StepRunRow('r-1', [
      ChatItem(kind: ChatLine.thinking, text: 'Menimbang dua penyebab.', timestamp: _at),
      ChatItem(kind: ChatLine.step, text: 'src/pty.rs', label: 'Read', timestamp: _at),
    ]);

    await tester.pumpWidget(_host(
      StepCapsule(row: row, expanded: true, onToggle: () {}),
    ));

    expect(find.byType(ThinkingBlock), findsOneWidget);
    // The one `Read` is still a step; the thought is not.
    expect(find.byType(StepLine), findsOneWidget);
  });
}

/// A notice is mono like a step and never red.
///
/// `AppTokens.error` is one of the two colours `MVP.md` allows this screen, and its whole
/// job is failure. A plan-window warning wearing it sends the operator hunting for a fault
/// that is not there.
void _noticeLine() {
  ChatItem notice() => ChatItem(
        kind: ChatLine.notice,
        text: 'five_hour plan limit: allowed_warning.',
        label: 'notice',
        timestamp: _at,
      );

  ChatItem problem() => ChatItem(
        kind: ChatLine.problem,
        text: 'Interrupted',
        label: 'error',
        timestamp: _at,
      );

  Color? inkOf(WidgetTester tester) =>
      tester.widget<Text>(find.text(find.byType(NoticeLine).evaluate().isEmpty
              ? 'Interrupted'
              : 'five_hour plan limit: allowed_warning.'))
          .style
          ?.color;

  testWidgets('a notice does not wear the error colour', (tester) async {
    await tester.pumpWidget(_host(NoticeLine(item: notice())));
    final noticeInk = inkOf(tester);

    await tester.pumpWidget(_host(ProblemLine(item: problem())));
    final problemInk = inkOf(tester);

    expect(problemInk, isNotNull);
    expect(noticeInk, isNotNull);
    expect(noticeInk, isNot(problemInk));
  });
}
