import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/agent/widgets/composer_context.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';

/// The line under Chat's capsule (v4 tiket 09): only what the host reports.
void main() {
  Cell cell({String? gating, String? model, String? branch}) => Cell(
        host: const HostId('mac'),
        paneId: 'p-1',
        workspaceId: 'ws-1',
        agentType: 'claude',
        title: 'Nita',
        status: 'live',
        isAlive: true,
        cwd: '/Users/me/experiments/Lotus',
        gating: gating,
        model: model,
        branch: branch,
      );

  Future<void> show(WidgetTester tester, Cell c, {double width = 390}) =>
      tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(
          body: Center(child: SizedBox(width: width, child: ComposerContext(cell: c))),
        ),
      ));

  test('the posture is worded as the rest of the app words it', () {
    expect(ComposerContext.posture('asks'), 'asks first');
    expect(ComposerContext.posture('skipped'), 'skips asking');
    expect(ComposerContext.posture('runner_cannot'), 'never asks');
    expect(ComposerContext.posture(null), isNull, reason: 'unknown is never drawn as safe');
    expect(ComposerContext.posture('plan'), isNull, reason: 'a value this build does not know');
  });

  testWidgets('the project and the posture, and no model the host never named',
      (tester) async {
    await show(tester, cell(gating: 'skipped'));

    expect(find.text('Lotus'), findsOne);
    expect(find.bySemanticsLabel('Project Lotus'), findsOne);
    expect(find.text('skips asking'), findsOne);
    for (final invented in ['opus', 'sonnet', 'opus · plan']) {
      expect(find.textContaining(invented), findsNothing, reason: invented);
    }
  });

  test('a model id is shortened, never renamed', () {
    expect(ComposerContext.modelLabel('claude-opus-5-5'), 'opus-5-5');
    expect(ComposerContext.modelLabel('claude-haiku-4-5-20251001'), 'haiku-4-5');
    expect(ComposerContext.modelLabel('gpt-5.6-luna'), 'gpt-5.6-luna');
    expect(ComposerContext.modelLabel(''), isNull);
    expect(ComposerContext.modelLabel(null), isNull);
  });

  test('model and branch are read from the contract fixture, and absent stays absent', () {
    final json = jsonDecode(File('../../contract/fixtures/rest-bootstrap.json').readAsStringSync())
        as Map<String, Object?>;
    final cells = Cell.listFromJson(json['cells'], host: const HostId('mac'));
    expect(cells[0].model, 'claude-opus-5-5');
    expect(cells[0].branch, 'feat/pocket-context');
    expect(cells[1].model, isNull);
    expect(cells[1].branch, isNull);
  });

  testWidgets('the model and branch the host reports are shown', (tester) async {
    await show(tester, cell(gating: 'asks', model: 'claude-opus-5-5', branch: 'feat/x'));

    expect(find.text('opus-5-5 · asks first'), findsOne);
    expect(find.text('feat/x'), findsOne);
    expect(find.bySemanticsLabel('Branch feat/x'), findsOne);
    expect(find.text('Lotus'), findsOne);
  });

  testWidgets('with no posture reported, only the project is said', (tester) async {
    await show(tester, cell());

    expect(find.text('Lotus'), findsOne);
    expect(find.byType(Text), findsOne);
  });

  testWidgets('a long project and branch give way rather than overflowing', (tester) async {
    final long = Cell(
      host: const HostId('mac'),
      paneId: 'p-1',
      workspaceId: 'ws-1',
      agentType: 'claude',
      title: 'Nita',
      status: 'live',
      isAlive: true,
      cwd: '/x/${'a-very-long-project-name' * 4}',
      gating: 'asks',
      model: 'claude-haiku-4-5-20251001',
      branch: 'feature/${'long-branch' * 5}',
    );
    await show(tester, long, width: 200);
    expect(tester.takeException(), isNull);
  });
}
