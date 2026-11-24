import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/features/agent/widgets/thinking_orb.dart';
import 'package:lotus_pocket/features/agent/widgets/working_row.dart';
import 'package:lotus_pocket/features/agent/work_state.dart';

final _started = DateTime.fromMillisecondsSinceEpoch(1788820000000);

Widget _host(Widget child) => MaterialApp(
      theme: ThemeData.dark().copyWith(extensions: const [AppTokens.dark]),
      home: Scaffold(body: Center(child: child)),
    );

WorkState _state(WorkPhase phase, {String? verb, String? target, int steps = 0}) =>
    WorkState(phase: phase, startedAt: _started, steps: steps, verb: verb, target: target);

void main() {
  testWidgets('names the step in the runner own words, and counts elapsed', (tester) async {
    await tester.pumpWidget(_host(WorkingRow(
      state: _state(WorkPhase.tool, verb: 'bash', target: 'bun test pty --reporter=dot', steps: 4),
      onStop: () {},
      now: () => _started.add(const Duration(seconds: 21)),
    )));

    expect(find.text('bash'), findsOneWidget);
    expect(find.text('bun test pty --reporter=dot'), findsOneWidget);
    expect(find.text('21s'), findsOneWidget);
    expect(find.text('step 4 of this turn'), findsOneWidget);
    expect(find.byType(ThinkingOrb), findsOneWidget);
  });

  testWidgets('a long command is cut, never wrapped', (tester) async {
    // One working row stays one row. This is the defect the mockup review caught: a
    // wrapped command pushed the elapsed count and the stop control off their line.
    await tester.pumpWidget(_host(SizedBox(
      width: 300,
      child: WorkingRow(
        state: _state(WorkPhase.tool, verb: 'bash',
            target: 'bun test packages/host/src/adapters/mobile --reporter=dot --bail'),
        now: () => _started,
      ),
    )));
    final text = tester.widget<Text>(find.textContaining('bun test packages'));
    expect(text.maxLines, 1);
    expect(text.overflow, TextOverflow.ellipsis);
  });

  testWidgets('thinking has no target and no step count to show', (tester) async {
    await tester.pumpWidget(_host(WorkingRow(state: _state(WorkPhase.thinking), now: () => _started)));
    expect(find.text('thinking…'), findsOneWidget);
    expect(find.textContaining('step'), findsNothing);
  });

  testWidgets('writing says so', (tester) async {
    await tester.pumpWidget(_host(WorkingRow(state: _state(WorkPhase.writing), now: () => _started)));
    expect(find.text('writing…'), findsOneWidget);
  });

  testWidgets('stop is offered, and only when the host can be asked', (tester) async {
    var stopped = 0;
    await tester.pumpWidget(_host(WorkingRow(
      state: _state(WorkPhase.tool, verb: 'bash', steps: 1),
      onStop: () => stopped++,
      now: () => _started,
    )));
    await tester.tap(find.text('STOP'));
    expect(stopped, 1);

    await tester.pumpWidget(_host(WorkingRow(
      state: _state(WorkPhase.tool, verb: 'bash', steps: 1),
      now: () => _started,
    )));
    // A control that cannot be honoured is not drawn, rather than drawn and inert.
    expect(find.text('STOP'), findsNothing);
  });

  testWidgets('says one sentence to a screen reader, not four fragments', (tester) async {
    final handle = tester.ensureSemantics();
    await tester.pumpWidget(_host(WorkingRow(
      state: _state(WorkPhase.tool, verb: 'bash', target: 'bun test', steps: 2),
      now: () => _started.add(const Duration(seconds: 8)),
    )));
    expect(find.bySemanticsLabel('Running bash on bun test, 8s so far'), findsOneWidget);
    handle.dispose();
  });
}
