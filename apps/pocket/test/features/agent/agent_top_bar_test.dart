import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/agent/page_mode.dart';
import 'package:lotus_pocket/features/agent/widgets/agent_top_bar.dart';
import 'package:lotus_pocket/features/agent/widgets/changes_chip.dart';
import 'package:lotus_pocket/features/agent/widgets/view_switch.dart';
import 'package:lotus_pocket/features/shared/cell_actions.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';

const Cell atlas = Cell(
  host: HostId('mac'),
  paneId: 'p-1',
  workspaceId: 'CNVS',
  workspaceLabel: 'CNVS',
  agentType: 'claude',
  title: 'Atlas',
  status: 'live',
  isAlive: true,
  turn: 'running',
  turnAgeMs: 120000,
);

void main() {
  late List<AgentSurface> shown;
  late int changesOpened;
  late List<String> stopped;

  setUp(() {
    shown = [];
    changesOpened = 0;
    stopped = [];
  });

  Future<void> bar(
    WidgetTester tester, {
    AgentSurface surface = AgentSurface.chat,
    bool canShow = true,
    int? changed,
  }) async {
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(
        body: AgentTopBar(
          cell: atlas,
          index: 0,
          total: 2,
          waitingAt: const {},
          hostLabel: 'mac',
          shown: surface,
          onShow: canShow ? shown.add : null,
          onBack: () {},
          actions: CellActionHandlers(
            onStop: (c) => stopped.add(c.title),
            onClose: (_) {},
            canClose: (_) => false,
          ),
          changedFiles: changed,
          onOpenChanges: () => changesOpened++,
        ),
      ),
    ));
    await tester.pumpAndSettle();
  }

  Finder segment(String label) =>
      find.descendant(of: find.byType(ViewSwitch), matching: find.text(label));

  testWidgets('tapping the title opens the drawer: context, CHANGED, and the actions',
      (tester) async {
    await bar(tester, changed: 2);
    expect(find.text('Stop turn'), findsNothing);
    expect(find.byType(ChangesChip), findsNothing);

    await tester.tap(find.text('Atlas'));
    await tester.pumpAndSettle();

    expect(find.text('CNVS · mac · claude · 2m'), findsOne);
    expect(find.text('Stop turn'), findsOne);

    await tester.tap(find.byType(ChangesChip));
    await tester.pumpAndSettle();
    expect(changesOpened, 1);

    await tester.tap(find.text('Stop turn'));
    expect(stopped, ['Atlas']);
  });

  testWidgets('no CHANGED chip when git has nothing to show', (tester) async {
    await bar(tester, changed: 0);
    await tester.tap(find.text('Atlas'));
    await tester.pumpAndSettle();

    expect(find.byType(ChangesChip), findsNothing);
  });

  testWidgets('the switch asks for the other view, and never for the one shown',
      (tester) async {
    await bar(tester);

    await tester.tap(segment('Chat'));
    await tester.tap(segment('Terminal'));

    expect(shown, [AgentSurface.terminal]);
  });

  testWidgets('each segment is at least a thumb tall, though the track is not', (tester) async {
    await bar(tester);

    expect(tester.getSize(find.byType(ViewSwitch)).height, greaterThanOrEqualTo(44));
    // The top edge of the 44px box, outside the drawn track, still counts as Terminal.
    final box = tester.getRect(find.byType(ViewSwitch));
    await tester.tapAt(Offset(box.right - 10, box.top + 1));
    expect(shown, [AgentSurface.terminal]);
  });

  testWidgets('the selected segment says so to a screen reader', (tester) async {
    final handle = tester.ensureSemantics();
    await bar(tester, surface: AgentSurface.terminal);

    expect(
      tester.getSemantics(segment('Terminal')),
      matchesSemantics(label: 'Terminal', isButton: true, isSelected: true, hasSelectedState: true,
          hasTapAction: false),
    );
    expect(
      tester.getSemantics(segment('Chat')),
      matchesSemantics(label: 'Chat', isButton: true, hasSelectedState: true, hasTapAction: true),
    );
    handle.dispose();
  });

  testWidgets('no switch while there is no terminal to show', (tester) async {
    await bar(tester, canShow: false);

    expect(find.byType(ViewSwitch), findsNothing);
  });
}
