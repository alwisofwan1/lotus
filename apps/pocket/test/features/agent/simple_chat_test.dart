import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/agent/chat_transcript.dart';
import 'package:lotus_pocket/features/agent/widgets/chat_view.dart';
import 'package:lotus_pocket/models/cell_result.dart';
import 'package:lotus_pocket/models/conversation.dart';

final DateTime start = DateTime(2026, 8, 7, 14, 10);
var _seq = 0;

Part user(String text) =>
    UserMessagePart(id: 'u${_seq++}', ts: start, seq: _seq, provenance: Provenance.native, text: text);

Part prose(String text) => AssistantTextPart(
    id: 'a${_seq++}', ts: start, seq: _seq, provenance: Provenance.native, text: text,
    streaming: false, truncated: false);

Part tool(String title) => ToolCallPart(
    id: 'c${_seq++}', ts: start, seq: _seq, provenance: Provenance.native, toolCallId: 'c$_seq',
    toolName: 'Read', title: title, kind: 'read', status: 'completed', locations: const [], files: const []);

Part plan(List<(String, PlanStatus)> entries) => PlanUpdatePart(
    id: 'plan', ts: start, seq: _seq++, provenance: Provenance.native,
    entries: [for (final (c, s) in entries) PlanEntry(content: c, status: s)]);

Turn turn(List<Part> parts, {bool ended = false}) => Turn(
    turnId: 't-1', startedAt: start, parts: parts,
    endedAt: ended ? start.add(const Duration(minutes: 3, seconds: 10)) : null,
    stopReason: ended ? 'end_turn' : null);

const changes = CellResult(
  paneId: 'p-1',
  cwd: '/work/orbit',
  closing: null,
  reason: null,
  changes: CellChanges(files: [
    ChangedPath(path: 'a.dart', status: 'modified'),
    ChangedPath(path: 'b.dart', status: 'modified'),
    ChangedPath(path: 'c.dart', status: 'added'),
  ], added: 184, removed: 12),
);

void main() {
  final calls = <String>[];
  setUp(calls.clear);

  Future<void> show(WidgetTester tester, Turn t,
          {bool working = false, bool ending = false, CellResult? result}) =>
      tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(
          body: ChatView(
            transcript: ChatTranscript.ofTurns([t]),
            turns: [t],
            working: working,
            ending: ending,
            result: result,
            agent: 'Nyx',
            onOpenTerminal: () {},
            onRefresh: () async {},
            onOpenChanges: () => calls.add('changes'),
          ),
        ),
      ));

  final planned = [
    user('Move SSH to its own transport.'),
    tool('lib/transport.dart'),
    plan([
      ('Study the transports', PlanStatus.completed),
      ('Write SshTransport', PlanStatus.inProgress),
      ('Wire it to HostApi', PlanStatus.pending),
    ]),
  ];

  testWidgets('working: the prompt, then the plan — and no tool step', (tester) async {
    await show(tester, turn(planned), working: true);

    expect(find.text('Move SSH to its own transport.'), findsOneWidget);
    expect(find.text('Study the transports'), findsOneWidget);
    expect(find.text('Write SshTransport'), findsOneWidget);
    expect(find.text('Wire it to HostApi'), findsOneWidget);
    expect(find.textContaining('lib/transport.dart'), findsNothing);
    expect(find.text('✓'), findsOneWidget, reason: 'only the finished step is ticked');
    final now = tester.widget<Text>(find.text('Write SshTransport'));
    expect(now.style?.fontWeight, FontWeight.w600);
    expect(find.byType(LinearProgressIndicator), findsNothing);
    expect(find.byType(CircularProgressIndicator), findsNothing);
  });

  testWidgets('working without a plan: the generic phases', (tester) async {
    await show(tester, turn([user('Why is login missing?'), tool('a.dart')]), working: true);
    for (final label in ['Reading', 'Changing', 'Testing', 'Summing up']) {
      expect(find.text(label), findsOneWidget);
    }
  });

  testWidgets('result: a steps pill, the answer, and a facts line that opens the changes', (tester) async {
    final done = [
      ...planned.take(2),
      plan([('Study the transports', PlanStatus.completed), ('Write SshTransport', PlanStatus.completed)]),
      prose('Done. SSH has its own transport now.'),
    ];
    await show(tester, turn(done, ended: true), ending: true, result: changes);

    expect(find.text('2 steps · 3m 10s ›'), findsOneWidget);
    expect(find.text('Study the transports'), findsNothing, reason: 'collapsed until tapped');
    await tester.tap(find.text('2 steps · 3m 10s ›'));
    await tester.pump();
    expect(find.text('Study the transports'), findsOneWidget);

    expect(find.text('Done. SSH has its own transport now.'), findsOneWidget);
    expect(find.textContaining('tests'), findsNothing, reason: 'the host reports no test result');
    expect(find.text('View changes'), findsNothing);
    expect(find.text('Done'), findsNothing, reason: 'Done lives in the header');

    await tester.tap(find.text('3 files +184 −12 ›'));
    expect(calls, ['changes']);
  });

  testWidgets('a turn that changed nothing draws no facts line', (tester) async {
    final t = turn([user('go'), prose('All done.')], ended: true);
    await show(tester, t, ending: true);
    expect(find.textContaining('files'), findsNothing);
  });
}
