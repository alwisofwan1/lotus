import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/data/done_marks.dart';
import 'package:lotus_pocket/data/draft_keeper.dart';
import 'package:lotus_pocket/data/transcript_pager.dart';
import 'package:lotus_pocket/features/agent/agent_page.dart';
import 'package:lotus_pocket/features/agent/widgets/agent_input.dart';
import 'package:lotus_pocket/features/agent/widgets/agent_top_bar.dart';
import 'package:lotus_pocket/features/agent/widgets/view_switch.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';

import '../../support/agent_harness.dart';
import '../../support/fake_security.dart';
import '../../support/upright.dart';

const HostId mac = HostId('mac');
String fixture(String name) => File('../../contract/fixtures/$name.json').readAsStringSync();

Cell cell({String? turn}) => Cell(
      host: mac, paneId: 'p-1', workspaceId: 'CNVS', workspaceLabel: 'CNVS', agentType: 'claude',
      title: 'Nyx', status: 'live', isAlive: true, turn: turn, turnAgeMs: turn == null ? null : 120000,
    );

/// Section H3: Done takes effect at once, keeps the session, and can be undone for 5 s.
void main() {
  late AgentHarness harness;
  late DoneMarks marks;

  setUp(() async {
    harness = await AgentHarness.paired(at: DateTime.utc(2026, 8, 6, 12));
    marks = DoneMarks(InMemorySecureStore());
  });

  tearDown(() => harness.dispose());

  Future<void> show(WidgetTester tester, Cell c) async {
    holdUpright(tester);
    harness.live.follow([c.ref]);
    harness.http
      ..enqueue(fixture('rest-transcript'))
      ..enqueue('{"paneId":"p-1","awaiting":false,"prompt":null}');
    final drafts = DraftKeeper(InMemorySecureStore(), sleep: (_) async {});
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(
        body: AgentPage(
          cell: c,
          repository: harness.repository,
          live: harness.live,
          pager: TranscriptPager(fetch: (_, _) async => null),
          snippets: harness.snippets,
          drafts: drafts,
          doneMarks: marks,
          index: 0,
          total: 1,
          hostLabel: 'mac',
          waitingAt: const {},
          onBack: () {},
        ),
      ),
    ));
    await tester.pumpAndSettle();
  }

  String hint(WidgetTester tester) =>
      tester.widget<TextField>(find.descendant(of: find.byType(AgentInput), matching: find.byType(TextField)))
          .decoration!
          .hintText!;

  testWidgets('Done marks the agent finished at once, and Undo takes it back', (tester) async {
    await show(tester, cell(turn: 'idle'));
    expect(hint(tester), contains('Reply to Nyx'));

    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();

    expect(find.text('Marked done'), findsOne);
    expect(find.text('Undo'), findsOne);
    expect(find.textContaining('Done · '), findsOne);
    expect(find.descendant(of: find.byType(AgentTopBar), matching: find.textContaining('done')), findsOne);
    expect(hint(tester), 'New task for Nyx…');
    expect(marks.markFor(cell().ref), isNotNull, reason: 'the session is kept, only marked');

    await tester.tap(find.text('Undo'));
    await tester.pumpAndSettle();
    expect(marks.markFor(cell().ref), isNull);
    expect(find.text('Done'), findsOne, reason: 'the action is back');
  });

  testWidgets('the snackbar leaves on its own after five seconds', (tester) async {
    await show(tester, cell(turn: 'idle'));
    await tester.tap(find.text('Done'));
    await tester.pumpAndSettle();
    expect(find.text('Marked done'), findsOne);
    await tester.pump(const Duration(seconds: 6));
    await tester.pumpAndSettle();
    expect(find.text('Marked done'), findsNothing);
    expect(marks.markFor(cell().ref), isNotNull);
  });

  testWidgets('while working the composer adds an instruction', (tester) async {
    await show(tester, cell(turn: 'running'));
    expect(hint(tester), 'Add an instruction…');
  });

  testWidgets('the agent actions open from ⋯ (Close is among them where the host can close)',
      (tester) async {
    await show(tester, cell(turn: 'idle'));
    expect(find.text('Stop turn'), findsNothing);
    await tester.tap(find.byTooltip('More actions'));
    await tester.pumpAndSettle();
    expect(find.text('Stop turn'), findsOne);
  });

  testWidgets('the Chat | Terminal switch sits by the composer, not in the header', (tester) async {
    await show(tester, cell(turn: 'idle'));
    expect(find.descendant(of: find.byType(AgentTopBar), matching: find.byType(ViewSwitch)), findsNothing);
    expect(find.descendant(of: find.byType(AgentInput), matching: find.byType(ViewSwitch)), findsOne);
  });
}
