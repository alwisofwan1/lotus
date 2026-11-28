import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/agent/chat_transcript.dart';
import 'package:lotus_pocket/features/agent/widgets/changes_chip.dart';
import 'package:lotus_pocket/features/agent/widgets/chat_steps.dart';
import 'package:lotus_pocket/models/conversation.dart';

final _at = DateTime.fromMillisecondsSinceEpoch(1788820000000);

Widget _host(Widget child) => MaterialApp(
      theme: buildAppTheme(),
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
