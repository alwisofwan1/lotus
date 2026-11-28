import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/data/draft_keeper.dart';
import 'package:lotus_pocket/data/transcript_pager.dart';
import 'package:lotus_pocket/features/agent/agent_page.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/conversation.dart';
import 'package:lotus_pocket/models/host_id.dart';

import '../../support/agent_harness.dart';
import '../../support/fake_security.dart';
import '../../support/upright.dart';

const HostId mac = HostId('mac');
final _at = DateTime.fromMillisecondsSinceEpoch(1788820000000);

Cell cell({String? turn = 'idle'}) => Cell(
      host: mac, paneId: 'p-1', workspaceId: 'CNVS', workspaceLabel: 'CNVS', agentType: 'claude',
      title: 'Nyx', status: 'live', isAlive: true, turn: turn, turnAgeMs: turn == null ? null : 120000,
    );

Turn finishedTurn({String closing = 'All done.'}) => Turn(
      turnId: 't-1', startedAt: _at, endedAt: _at.add(const Duration(minutes: 1)), stopReason: 'end_turn',
      parts: [
        UserMessagePart(id: 'u', ts: _at, seq: 1, provenance: Provenance.hook, text: 'fix it'),
        ToolCallPart(
            id: 'c', ts: _at, seq: 2, provenance: Provenance.hook, toolCallId: 'c', toolName: 'Edit',
            title: 'a.dart', kind: 'edit', status: 'completed', locations: const [], files: const []),
        AssistantTextPart(
            id: 'a', ts: _at, seq: 3, provenance: Provenance.hook, text: closing,
            streaming: false, truncated: false),
      ],
    );

/// The header's Stop / Done slot, and what Done does: leave at once, close after 5 s unless undone.
void main() {
  late AgentHarness harness;
  late int closes;

  setUp(() async {
    harness = await AgentHarness.paired(at: DateTime.utc(2026, 8, 6, 12));
    harness.registry.add(harness.host(mac,
        features: const ['fleet', 'dispatch', 'transcript', 'permission', 'close']));
    closes = 0;
  });

  tearDown(() => harness.dispose());

  /// A "project screen" that opens the agent page, so leaving it is a real pop.
  Future<void> show(WidgetTester tester, Cell c,
      {List<Turn> turns = const [], bool result = false}) async {
    holdUpright(tester);
    harness.live.follow([c.ref]);
    harness.http.enqueue('{"paneId":"p-1","total":0,"entries":[]}');
    harness.http.enqueue('{"paneId":"p-1","awaiting":false,"prompt":null}');
    if (result) harness.http.enqueue(File('../../contract/fixtures/rest-result.json').readAsStringSync());
    final drafts = DraftKeeper(InMemorySecureStore(), sleep: (_) async {});
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: Builder(
        builder: (context) => Scaffold(
          body: Center(
            child: TextButton(
              onPressed: () => Navigator.of(context).push(MaterialPageRoute<void>(
                builder: (_) => Scaffold(
                  body: AgentPage(
                    cell: c,
                    repository: harness.repository,
                    live: harness.live,
                    pager: TranscriptPager(fetch: (_, _) async => null),
                    snippets: harness.snippets,
                    drafts: drafts,
                    index: 0,
                    total: 1,
                    hostLabel: 'mac',
                    waitingAt: const {},
                    onBack: () => Navigator.of(context).pop(),
                  ),
                ),
              )),
              child: const Text('Project'),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.text('Project'));
    await tester.pumpAndSettle();
    if (turns.isNotEmpty) {
      harness.live.seed(c.ref, turns);
      await tester.pumpAndSettle();
    }
  }

  void countCloses() {
    closes = harness.http.sent.where((r) => r.method == 'DELETE' && r.uri.path == '/m/cell/p-1').length;
  }

  Finder inHeader(String text) => find.text(text);

  group('the slot', () {
    testWidgets('says Stop while the agent works', (tester) async {
      await show(tester, cell(turn: 'running'), turns: [finishedTurn()]);
      expect(inHeader('Stop'), findsOne);
      expect(inHeader('Done'), findsNothing);
    });

    testWidgets('Stop interrupts the turn through the gate', (tester) async {
      await show(tester, cell(turn: 'running'));
      harness.http.sent.clear();
      await tester.tap(inHeader('Stop'));
      await tester.pumpAndSettle();
      expect(harness.http.last.uri.path, '/m/cell/p-1/stop');
    });

    testWidgets('says Done once the task looks finished', (tester) async {
      await show(tester, cell(), turns: [finishedTurn()]);
      expect(inHeader('Done'), findsOne);
      expect(inHeader('Stop'), findsNothing);
    });

    testWidgets('says nothing after a greeting, or when the agent asks a question', (tester) async {
      await show(tester, cell(), turns: [
        Turn(turnId: 't-0', startedAt: _at, endedAt: _at, stopReason: 'end_turn', parts: [
          UserMessagePart(id: 'u', ts: _at, seq: 1, provenance: Provenance.hook, text: 'hi'),
          AssistantTextPart(
              id: 'a', ts: _at, seq: 2, provenance: Provenance.hook, text: 'Hi! What can I help you with?',
              streaming: false, truncated: false),
        ]),
      ]);
      expect(inHeader('Done'), findsNothing);
      expect(inHeader('Stop'), findsNothing);

      harness.live.seed(cell().ref, [finishedTurn(closing: 'Fixed. Add a test?')]);
      await tester.pumpAndSettle();
      expect(inHeader('Done'), findsNothing);
    });

    testWidgets('no Done on a host that cannot close a cell', (tester) async {
      harness.registry.add(harness.host(mac));
      await show(tester, cell(), turns: [finishedTurn()]);
      expect(inHeader('Done'), findsNothing);
    });
  });

  group('Done closes the agent', () {
    testWidgets('leaves at once, says what was closed, and closes after five seconds', (tester) async {
      await show(tester, cell(), turns: [finishedTurn()]);
      harness.http.sent.clear();
      harness.http.enqueue('{"ok":true}');

      await tester.tap(inHeader('Done'));
      await tester.pumpAndSettle(const Duration(milliseconds: 100));

      expect(find.text('Project'), findsOne, reason: 'back on the project screen');
      expect(find.text('Closed Nyx'), findsOne);
      expect(find.text('Undo'), findsOne);
      countCloses();
      expect(closes, 0, reason: 'nothing is closed yet');

      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
      countCloses();
      expect(closes, 1);
    });

    testWidgets('Undo from the project screen cancels the close', (tester) async {
      await show(tester, cell(), turns: [finishedTurn()]);
      harness.http.sent.clear();

      await tester.tap(inHeader('Done'));
      await tester.pumpAndSettle(const Duration(milliseconds: 100));
      await tester.tap(find.text('Undo'));
      await tester.pump(const Duration(seconds: 6));
      await tester.pumpAndSettle();

      countCloses();
      expect(closes, 0);
    });

    testWidgets('the snackbar counts files git says are not committed', (tester) async {
      harness.registry.add(harness.host(mac,
          features: const ['fleet', 'dispatch', 'transcript', 'permission', 'close', 'result']));
      await show(tester, cell(), turns: [finishedTurn()], result: true);
      await tester.tap(inHeader('Done'));
      await tester.pumpAndSettle(const Duration(milliseconds: 100));
      expect(find.text('Closed Nyx · 4 files not committed'), findsOne);
      harness.http.enqueue('{"ok":true}');
      await tester.pump(const Duration(seconds: 5));
      await tester.pumpAndSettle();
    });
  });

  group('⋯ and Close agent', () {
    testWidgets('Close agent is in ⋯ when Done is not showing, and not when it is', (tester) async {
      await show(tester, cell(), turns: [finishedTurn(closing: 'Fixed. Add a test?')]);
      await tester.tap(find.byTooltip('More actions'));
      await tester.pumpAndSettle();
      expect(find.text('Close agent'), findsOne);
      expect(find.text('Stop turn'), findsOne);
    });

    testWidgets('with Done showing, ⋯ has no Close', (tester) async {
      await show(tester, cell(), turns: [finishedTurn()]);
      await tester.tap(find.byTooltip('More actions'));
      await tester.pumpAndSettle();
      expect(find.text('Close agent'), findsNothing);
      expect(find.text('Close'), findsNothing);
      expect(find.text('Stop turn'), findsOne);
    });
  });
}
