import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/shared/cell_actions.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';

const HostId mac = HostId('mac');

Cell cell(
  String paneId, {
  required String title,
  String agentType = 'claude',
  String? turn,
}) =>
    Cell(
      host: mac,
      paneId: paneId,
      workspaceId: 'CNVS',
      agentType: agentType,
      title: title,
      status: 'live',
      isAlive: true,
      turn: turn,
    );

/// Records what a drawer asked for, so a test can assert on the gesture rather than on
/// the mutation — which is the boundary this widget is supposed to hold.
class Log {
  final sentHere = <String>[];
  final stopped = <String>[];
  final closed = <String>[];
  final asked = <String>[];
  final cancelled = <String>[];
}

/// Drawer-nya sekarang hanya hidup di halaman agen ([AgentHeader]), jadi ia diuji sebagai
/// widget-nya sendiri alih-alih lewat `CellList`. Sebelum 2026-08-11 file ini memompanya
/// lewat daftar Home, karena di sanalah pintunya; pintu itu sudah tidak ada, dan menguji
/// lewat daftar akan menguji tempat yang tidak lagi memuatnya.
Widget harness(
  Cell cell, {
  required Log log,
  bool confirming = false,
  bool canClose = true,
  bool sendHere = true,
}) =>
    MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(
        body: CellActions(
          cell: cell,
          confirmingClose: confirming,
          onAskClose: () => log.asked.add(cell.title),
          onCancelClose: () => log.cancelled.add(cell.title),
          handlers: CellActionHandlers(
            canClose: (_) => canClose,
            onDispatchHere: sendHere ? (c) => log.sentHere.add(c.title) : null,
            onStop: (c) => log.stopped.add(c.title),
            onClose: (c) => log.closed.add(c.title),
          ),
        ),
      ),
    );

void main() {
  group('the drawer', () {
    testWidgets('offers send and stop, and close only where the host can', (tester) async {
      final log = Log();
      final atlas = cell('p-1', title: 'Atlas', turn: 'running');
      await tester.pumpWidget(harness(atlas, log: log));
      await tester.pumpAndSettle();

      expect(find.text('Send here'), findsOneWidget);
      expect(find.text('Stop turn'), findsOneWidget);
      expect(find.text('Close'), findsOneWidget);

      await tester.tap(find.text('Stop turn'));
      await tester.pumpAndSettle();
      expect(log.stopped, ['Atlas']);
    });

    testWidgets('hides close entirely on a host that cannot end a cell', (tester) async {
      final log = Log();
      final atlas = cell('p-1', title: 'Atlas', turn: 'running');
      await tester.pumpWidget(
        harness(atlas, log: log, canClose: false),
      );
      await tester.pumpAndSettle();

      // Not a disabled remnant: a host that never advertised the capability is not a
      // host that is failing, and ADR-14's rule is that an unhonourable control is worse
      // than empty space.
      expect(find.text('Close'), findsNothing);
      expect(find.text('Stop turn'), findsOneWidget);
    });

    testWidgets('stop stays live for a runner that reports no turn at all',
        (tester) async {
      final log = Log();
      // `codex` files no stop hook, so its silence cannot be read (`MVP.md` §2) — and
      // those are exactly the cells an operator most needs to be able to interrupt.
      final koda = cell('p-2', title: 'Koda', agentType: 'codex');
      await tester.pumpWidget(harness(koda, log: log));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Stop turn'));
      await tester.pumpAndSettle();
      expect(log.stopped, ['Koda']);
    });

    testWidgets('stop is drawn but dead for a cell the host reported idle',
        (tester) async {
      final log = Log();
      final atlas = cell('p-1', title: 'Atlas', turn: 'idle');
      await tester.pumpWidget(harness(atlas, log: log));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Stop turn'));
      await tester.pumpAndSettle();
      expect(log.stopped, isEmpty);
      // Drawn rather than hidden, so `Close` does not move under the thumb between one
      // agent and the next.
      expect(find.text('Stop turn'), findsOneWidget);
    });

    testWidgets('confirming names the agent and keeps the question in the row',
        (tester) async {
      final log = Log();
      final nova = cell('p-3', title: 'Nova', turn: 'running');
      await tester.pumpWidget(
        harness(nova, log: log, confirming: true),
      );
      await tester.pumpAndSettle();

      expect(find.text('Close Nova?'), findsOneWidget);
      expect(find.text('Cancel'), findsOneWidget);
      // The actions are replaced, not stacked: the row's height must not jump, and the
      // two buttons land where the eye already is.
      expect(find.text('Send here'), findsNothing);

      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      expect(log.closed, ['Nova']);
    });
  });
}
