import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/agent/page_mode.dart';
import 'package:lotus_pocket/features/agent/widgets/agent_top_bar.dart';
import 'package:lotus_pocket/features/agent/widgets/changes_chip.dart';
import 'package:lotus_pocket/features/agent/widgets/header_action.dart';
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
  late int acted;

  setUp(() {
    shown = [];
    changesOpened = 0;
    stopped = [];
    acted = 0;
  });

  Future<void> bar(
    WidgetTester tester, {
    AgentSurface surface = AgentSurface.chat,
    bool canShow = true,
    bool canClose = false,
    int? changed,
    HeaderAction action = HeaderAction.none,
    bool offerClose = false,
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
            canClose: (_) => canClose,
          ),
          action: action,
          onAction: () => acted++,
          offerClose: offerClose,
          changedFiles: changed,
          onOpenChanges: () => changesOpened++,
        ),
      ),
    ));
    await tester.pumpAndSettle();
  }

  Finder segment(String label) => find.byKey(ValueKey('view-${label.toLowerCase()}'));

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
    await bar(tester, surface: AgentSurface.terminal);

    await tester.tap(segment('Terminal'));
    await tester.tap(segment('Chat'));

    expect(shown, [AgentSurface.chat]);
  });

  testWidgets('the switch is two icons in the header, on Chat too', (tester) async {
    await bar(tester);
    expect(find.byType(ViewSwitch), findsOne);
    expect(find.text('Chat'), findsNothing, reason: 'icons, not words');
    expect(find.text('Terminal'), findsNothing);
    await tester.tap(segment('Terminal'));
    expect(shown, [AgentSurface.terminal]);
  });

  group('the one text slot', () {
    testWidgets('says Stop, Done, or nothing — never two', (tester) async {
      await bar(tester);
      expect(find.text('Stop'), findsNothing);
      expect(find.text('Done'), findsNothing);

      await bar(tester, action: HeaderAction.stop);
      expect(find.text('Stop'), findsOne);
      expect(find.text('Done'), findsNothing);

      await bar(tester, action: HeaderAction.done);
      expect(find.text('Done'), findsOne);
      expect(find.text('Stop'), findsNothing);
    });

    testWidgets('is plain text on a 48dp target, and taps through', (tester) async {
      await bar(tester, action: HeaderAction.done);
      final hit = find.ancestor(of: find.text('Done'), matching: find.byType(InkWell));
      expect(tester.getSize(hit).height, greaterThanOrEqualTo(48));
      expect(find.descendant(of: hit, matching: find.byType(DecoratedBox)), findsNothing,
          reason: 'no border or fill');
      await tester.tap(find.text('Done'));
      expect(acted, 1);
    });

    testWidgets('is not drawn on Terminal', (tester) async {
      await bar(tester, surface: AgentSurface.terminal, action: HeaderAction.stop);
      expect(find.text('Stop'), findsNothing);
    });
  });

  testWidgets('⋯ offers Close agent only when the header is not showing Done', (tester) async {
    await bar(tester, canClose: true, offerClose: false);
    await tester.tap(find.byTooltip('More actions'));
    await tester.pumpAndSettle();
    expect(find.text('Close agent'), findsNothing);
    expect(find.text('Close'), findsNothing);

    await tester.pumpWidget(const SizedBox());
    await bar(tester, canClose: true, offerClose: true);
    await tester.tap(find.byTooltip('More actions'));
    await tester.pumpAndSettle();
    expect(find.text('Close agent'), findsOne);
  });

  testWidgets('each segment is at least a thumb tall, though the track is not', (tester) async {
    await bar(tester, surface: AgentSurface.terminal);

    expect(tester.getSize(find.byType(ViewSwitch)).height, greaterThanOrEqualTo(44));
    // The top edge of the 44px box, outside the drawn track, still counts as Chat.
    final box = tester.getRect(find.byType(ViewSwitch));
    await tester.tapAt(Offset(box.left + 10, box.top + 1));
    expect(shown, [AgentSurface.chat]);
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
