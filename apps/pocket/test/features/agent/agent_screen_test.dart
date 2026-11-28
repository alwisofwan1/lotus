import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show SemanticsNode;
import 'package:flutter/services.dart' show SystemChannels;
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/transcript_pager.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/agent/agent_screen.dart';
import 'package:lotus_pocket/features/agent/widgets/agent_top_bar.dart';
import 'package:lotus_pocket/features/agent/widgets/immersive_controls.dart';
import 'package:lotus_pocket/features/agent/widgets/sessions_sheet.dart';
import 'package:lotus_pocket/features/agent/widgets/terminal_dock.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/data/draft_keeper.dart';
import 'package:xterm/xterm.dart';

import '../../support/pager_harness.dart';
import '../../support/upright.dart';
import '../../support/fake_security.dart';

const HostId mac = HostId('mac');
const HostId vps = HostId('vps');

final Directory fixtures = Directory('../../contract/fixtures');
String fixture(String name) => File('${fixtures.path}/$name.json').readAsStringSync();

/// The `userPrompt` every entry in `rest-transcript` carries, and therefore the one
/// string that proves a page seeded from the host's snapshot.
const String seededLine = 'clean up the legacy files';

/// The pager, which is the seam none of the other Agent tests cover.
///
/// `agent_page_test.dart` mounts **one** [AgentPage] in a bare `Scaffold`. One page is
/// one owner, so the class of defect `issues/12` describes — two live pages writing to
/// one shared, single-cell store — is invisible there by construction. That is why the
/// whole suite stayed green while switching agents rendered a blank transcript on a real
/// phone.
///
/// So these tests exist at the only altitude that can see it: a real `AgentScreen` over
/// a real `AgentRepository`, `HostRegistry` and `FleetStore`, with a fleet of four and
/// nothing faked below the transport and the lock.
void main() {
  late PagerHarness harness;

  setUp(() async {
    harness = await PagerHarness.paired(hosts: const [mac, vps]);
    harness.http
      ..transcript = fixture('rest-transcript')
      ..permission = '{"paneId":"p-1","awaiting":false,"prompt":null}';
    // Four, not two. Three of them fit inside the pager's reachable neighbourhood and
    // the fourth deliberately does not — which is what test 5 needs in order to assert
    // that widening the store did not widen it to everything.
    harness.withCells(mac, [
      pagerCell('p-1', 'Atlas'),
      pagerCell('p-2', 'Borea'),
      pagerCell('p-3', 'Cirrus'),
      pagerCell('p-4', 'Dorado'),
    ]);
  });

  tearDown(() => harness.dispose());

  /// Opened the way Home opens it: from the cell that was tapped, which carries both
  /// the ref and the project the pager may reach.
  Widget pagerOn(Cell cell) => MaterialApp(
        theme: buildAppTheme(),
        home: AgentScreen(
          key: ValueKey(cell.ref),
          fleet: harness.fleet,
          repository: harness.repository,
          live: harness.live,
          pager: TranscriptPager(fetch: (_, _) async => null),
          snippets: harness.snippets,
          drafts: DraftKeeper(InMemorySecureStore(), sleep: (_) async {}),
          hostLabel: (h) => h.value,
          initial: cell.ref,
          project: cell.project,
        ),
      );

  Future<void> open(
    WidgetTester tester, {
    CellRef on = const CellRef(mac, 'p-1'),
    bool upright = true,
  }) async {
    if (upright) holdUpright(tester);
    final cell = harness.fleet.cells.firstWhere((c) => c.ref == on);
    await tester.pumpWidget(pagerOn(cell));
    await tester.pumpAndSettle();
  }

  /// One page to the left or right. Negative dx goes forward, the way a thumb does.
  Future<void> swipe(WidgetTester tester, {required bool forward}) async {
    // From the header, not the middle of the pager: the middle is wherever the transcript
    // happens to put a line of prose, and a drag that starts on `SelectionArea` prose is
    // taken by the selection rather than the pager — true before v4 too, which only moved
    // the prose under the old centre by shortening the header.
    final from = tester.getCenter(find.byType(AgentTopBar).hitTestable().first);
    await tester.flingFrom(from, Offset(forward ? -400 : 400, 0), 1000);
    await tester.pumpAndSettle();
    // C2 is test 6's subject. Drained here so the other tests fail for their own
    // reason rather than inheriting it — an exception left standing is reported as
    // "multiple exceptions" and says nothing about what this test was asking.
    tester.takeException();
  }

  group('switching agents renders the agent you switched to', () {
    testWidgets('1. the host answers after the swipe has already landed', (tester) async {
      await open(tester);
      expect(find.text(seededLine), findsOne, reason: 'the first page seeded');

      // The shape a tailnet actually has: the read for the page being entered is still
      // in flight when the gesture finishes. Nothing contrived — one HTTP round trip is
      // longer than one page-settle animation on every real network.
      harness.http.holdTranscript = true;
      await swipe(tester, forward: true);
      expect(find.text('Borea'), findsOne, reason: 'the header already changed');

      harness.http.holdTranscript = false;
      harness.http.release();
      await tester.pumpAndSettle();

      expect(find.text(seededLine), findsOne,
          reason: 'the second agent must render the transcript its own read returned');
    });

    testWidgets('2. a hook event arriving after the swipe reaches the screen',
        (tester) async {
      await open(tester);
      await swipe(tester, forward: true);
      expect(find.text('Borea'), findsOne);

      // Asserted through behaviour rather than through `live.watching`, so this test
      // keeps its meaning when the store stops having a single pointer to inspect.
      harness.emitReply(paneId: 'p-2', body: 'lib/search.dart');
      await tester.pumpAndSettle();

      expect(find.text('lib/search.dart'), findsOne,
          reason: 'the store must still be following the cell that is on screen');
    });

    testWidgets('3. coming back shows the agent you left, not an empty page',
        (tester) async {
      await open(tester);
      expect(find.text(seededLine), findsOne);

      await swipe(tester, forward: true);
      await swipe(tester, forward: false);

      expect(find.text('Atlas'), findsOne, reason: 'back on the first agent');
      expect(find.text(seededLine), findsOne,
          reason: 'the transcript is there again without a trip through Home');

      // **The line above is not sufficient evidence, and that is worth knowing.** The
      // wipe that empties the store happens in the outgoing page's `dispose`, where the
      // widget tree is locked — so its `notifyListeners()` cannot mark anything dirty
      // and the text stays painted from the frame before. The store is already wrong;
      // the screen simply has not been told. Asking for a *new* step is what makes the
      // difference observable, because a store pointed at nothing drops every frame.
      harness.emitReply(paneId: 'p-1', body: 'lib/renamed.dart');
      await tester.pumpAndSettle();
      expect(find.text('lib/renamed.dart'), findsOne,
          reason: 'the page you came back to is genuinely live, not a stale painting');
    });

    testWidgets('4. a reply that lands while its agent is off screen is not lost',
        (tester) async {
      await open(tester);
      await swipe(tester, forward: true);
      expect(find.text('Borea'), findsOne);

      // Atlas keeps working while Borea is the one being looked at. The host broadcasts
      // this frame unconditionally (`stream-hub.ts`), so keeping it costs nothing on the
      // wire — throwing it away is what costs the operator the step.
      harness.emitReply(paneId: 'p-1', body: 'lib/offscreen.dart');
      await tester.pumpAndSettle();
      expect(find.text('lib/offscreen.dart'), findsNothing,
          reason: 'not on the page it does not belong to');

      await swipe(tester, forward: false);
      expect(find.text('lib/offscreen.dart'), findsOne,
          reason: 'the step Atlas took while off screen is waiting on its own page');
    });
  });

  group('the pager reaches this project, and stops there', () {
    /// Home's own shape, reported 2026-08-09: `codespace-demo` holds one agent, and
    /// swiping inside it arrives at an agent belonging to another project entirely.
    Future<void> openTwoProjects(WidgetTester tester) async {
      harness.withCells(mac, [
        pagerCell('p-1', 'Atlas'),
        pagerCell('p-2', 'Borea'),
        pagerCell('p-9', 'Nova', project: 'DEMO'),
      ]);
      await open(tester, on: const CellRef(mac, 'p-9'));
    }

    testWidgets('9. an agent from another project is not one swipe away',
        (tester) async {
      await openTwoProjects(tester);
      expect(find.text('Nova'), findsOne);

      await swipe(tester, forward: false);

      expect(find.text('Nova'), findsOne,
          reason: 'DEMO holds one agent, so there is nowhere to swipe to');
      expect(find.text('Atlas'), findsNothing,
          reason: "CNVS's agents are not reachable from inside DEMO");
    });

    testWidgets('10. the pips count this project, not the whole fleet', (tester) async {
      await openTwoProjects(tester);

      // The pips are the pager's only statement of how far it goes. Counting the fleet
      // while Home counts a project is the screenshot's `— • •` under a one-agent project.
      final header = tester.widget<AgentTopBar>(find.byType(AgentTopBar));
      expect(header.total, 1);
    });
  });

  group('widening what is kept does not widen what is believed', () {
    testWidgets('5. a frame from outside the neighbourhood is still dropped',
        (tester) async {
      await open(tester);

      // Far enough down the frozen order that no single gesture reaches it.
      harness.emitHook(paneId: 'p-4', toolTarget: 'lib/far_away.dart');
      // The identity trap R-10 names: two machines can each run a `p-1`, and the wrong
      // machine's step rendered here would look exactly like this one's.
      harness.emitHook(host: vps, paneId: 'p-1', toolTarget: 'lib/wrong_machine.dart');
      await tester.pumpAndSettle();

      expect(find.text('lib/far_away.dart'), findsNothing);
      expect(find.text('lib/wrong_machine.dart'), findsNothing);
      expect(find.text(seededLine), findsOne, reason: 'and Atlas is undisturbed');
    });

    testWidgets('6. a swipe throws nothing — no notification during build',
        (tester) async {
      await open(tester);

      await tester.fling(find.byType(PageView), const Offset(-400, 0), 1000);
      await tester.pumpAndSettle();

      // `LiveTranscript.watch` notifies synchronously, and the page that calls it is
      // built by `PageView` inside a layout callback — so the framework is already
      // building when a listener is marked dirty. In release the assertion is gone and
      // the rebuild is simply skipped, which is the second reason the screen does not
      // catch up with its own data.
      expect(tester.takeException(), isNull,
          reason: 'setState() or markNeedsBuild() called during build');
    });

    testWidgets('8. the agent you come back to is already there, unread', (tester) async {
      await open(tester);
      await swipe(tester, forward: true);
      final readsSoFar = harness.http.callsTo('transcript');

      // Nothing this pager asks for can arrive from here on. So whatever is on screen
      // after the swipe back was kept, not fetched — which is the difference between a
      // page that fills in front of the operator and one that is simply current.
      harness.http.holdTranscript = true;
      await swipe(tester, forward: false);

      expect(find.text('Atlas'), findsOne);
      expect(find.text(seededLine), findsOne,
          reason: 'no blank frame while a read that cannot land is waited for');
      expect(harness.http.callsTo('transcript'), readsSoFar,
          reason: 'the page was never torn down, so there was nothing to re-read');

      harness.http.holdTranscript = false;
      harness.http.release();
      await tester.pumpAndSettle();
    });

    testWidgets('7. leaving the pager leaves nothing behind for the next one',
        (tester) async {
      await open(tester);
      expect(find.text(seededLine), findsOne);

      // Home, then a different agent — the operator's own workaround, and the path that
      // would expose one pager's entries rendered under another agent's name.
      await tester.pumpWidget(MaterialApp(theme: buildAppTheme(), home: const SizedBox()));
      await tester.pumpAndSettle();

      // Held, so nothing this pager reads can arrive and account for what is on screen.
      harness.http.holdTranscript = true;
      await open(tester, on: const CellRef(mac, 'p-3'));

      expect(find.text('Cirrus'), findsOne);
      expect(find.text(seededLine), findsNothing,
          reason: "Atlas's transcript must not be showing under Cirrus's name");

      harness.http.holdTranscript = false;
      harness.http.release();
      await tester.pumpAndSettle();
    });
  });

  group('the terminal belongs to the page, and the tail to the page in front', () {
    /// Lets a stream event reach `OutputBuffer`, then redraws. `runAsync` because the
    /// terminal's cursor-blink timer keeps the fake clock's event queue from ever draining.
    Future<void> drain(WidgetTester tester) async {
      await tester.runAsync(() => Future<void>.delayed(Duration.zero));
      await tester.pump();
      await tester.pump();
    }

    Finder front(String label) => find.byKey(ValueKey('view-${label.toLowerCase()}')).hitTestable();

    String drawn(WidgetTester tester) {
      final lines = tester.widget<TerminalView>(find.byType(TerminalView)).terminal.buffer.lines;
      return [for (var y = 0; y < lines.length; y++) lines[y].toString()].join('|');
    }

    final long = List.generate(200, (i) => 'row $i').join('\r\n');

    testWidgets('scroll position survives Terminal -> Chat -> Terminal, on one tail',
        (tester) async {
      await open(tester);
      await tester.tap(front('Terminal'));
      await tester.pumpAndSettle();
      final tails = harness.output.epoch;

      harness.emitOutput(long);
      await drain(tester);

      final scrollable = find.descendant(
        of: find.byType(TerminalView),
        matching: find.byType(Scrollable),
      );
      await tester.drag(find.byType(TerminalView), const Offset(0, 300));
      await tester.pumpAndSettle();
      final scrolled = tester.state<ScrollableState>(scrollable.first).position.pixels;
      expect(scrolled, greaterThan(0), reason: 'the probe has to have moved off the origin');

      await tester.tap(front('Chat'));
      await tester.pumpAndSettle();
      await tester.tap(front('Terminal'));
      await tester.pumpAndSettle();

      expect(tester.state<ScrollableState>(scrollable.first).position.pixels, scrolled);
      // Closing the sheet no longer lets go of the tail, so nothing was replayed.
      expect(harness.output.epoch, tails, reason: 'tail was called once, not again');
      expect(harness.output.watching, const CellRef(mac, 'p-1'));
    });

    testWidgets('a neighbour on the same host becoming active takes the tail over',
        (tester) async {
      await open(tester);
      await tester.tap(front('Terminal'));
      await tester.pumpAndSettle();
      expect(harness.output.watching, const CellRef(mac, 'p-1'));

      // Borea never opened its terminal, so it has no claim on the stream — and Atlas,
      // no longer in front, has none either.
      await swipe(tester, forward: true);
      expect(harness.output.watching, isNull);

      await tester.tap(front('Terminal'));
      await tester.pumpAndSettle();
      expect(harness.output.watching, const CellRef(mac, 'p-2'));

      // And back: Atlas opened its terminal once, so being in front is enough.
      await swipe(tester, forward: false);
      expect(harness.output.watching, const CellRef(mac, 'p-1'));

      harness.emitOutput('atlas ring');
      await drain(tester);
      expect('atlas ring'.allMatches(drawn(tester)), hasLength(1));
    });

    testWidgets('a page swiped past without ever opening its terminal never tails',
        (tester) async {
      await open(tester);
      await swipe(tester, forward: true);
      await swipe(tester, forward: true);
      expect(harness.output.watching, isNull);
    });
  });

  group('the Sessions sheet moves the pager, and hands New back (v4 tiket 08)', () {
    Finder front(String label) => find.byKey(ValueKey('view-${label.toLowerCase()}')).hitTestable();

    Future<void> openSessions(WidgetTester tester) async {
      await tester.tap(front('Terminal'));
      await tester.pumpAndSettle();
      await tester.tap(find.bySemanticsLabel('Sessions').hitTestable());
      await tester.pumpAndSettle();
    }

    testWidgets('lists this pager under its machine, current one selected', (tester) async {
      await open(tester);
      await openSessions(tester);

      final sheet = find.byType(SessionsSheet);
      expect(find.descendant(of: sheet, matching: find.text('MAC')), findsOneWidget);
      for (final name in ['Atlas', 'Borea', 'Cirrus', 'Dorado']) {
        expect(find.descendant(of: sheet, matching: find.text(name)), findsOneWidget);
      }
      SemanticsNode row(String name) =>
          tester.getSemantics(find.descendant(of: sheet, matching: find.text(name)));
      expect(row('Atlas'), isSemantics(isSelected: true));
      expect(row('Borea'), isSemantics(isSelected: false));
      // The harness host does not advertise `spawn`, so there is nothing to start (ADR-14).
      expect(find.bySemanticsLabel('New session'), findsNothing);
    });

    testWidgets('a row jumps the pager there, as a swipe would', (tester) async {
      await open(tester);
      await openSessions(tester);

      await tester.tap(find.descendant(of: find.byType(SessionsSheet), matching: find.text('Cirrus')));
      await tester.pumpAndSettle();
      tester.takeException();

      expect(find.byType(SessionsSheet), findsNothing);
      expect(
        find.descendant(of: find.byType(AgentTopBar).hitTestable(), matching: find.text('Cirrus')),
        findsOneWidget,
      );
      // Cirrus never opened its terminal, and Atlas is no longer in front: nobody tails.
      expect(harness.output.watching, isNull);
    });

    testWidgets('New closes the pager with true, for its opener to start one', (tester) async {
      harness.dispose();
      harness = await PagerHarness.paired(hosts: const [mac, vps], canSpawn: true);
      harness.http
        ..transcript = fixture('rest-transcript')
        ..permission = '{"paneId":"p-1","awaiting":false,"prompt":null}';
      harness.withCells(mac, [pagerCell('p-1', 'Atlas'), pagerCell('p-2', 'Borea')]);
      final cell = harness.fleet.cells.first;

      bool? result;
      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: Builder(
          builder: (context) => TextButton(
            onPressed: () async {
              result = await Navigator.of(context).push<bool>(
                MaterialPageRoute(builder: (_) => (pagerOn(cell) as MaterialApp).home!),
              );
            },
            child: const Text('go'),
          ),
        ),
      ));
      await tester.tap(find.text('go'));
      await tester.pumpAndSettle();
      await openSessions(tester);

      await tester.tap(find.bySemanticsLabel('New session'));
      await tester.pumpAndSettle();
      expect(result, isTrue);
      expect(find.byType(AgentScreen), findsNothing);
    });
  });

  group('turning the phone on Terminal goes full screen (v4 tiket 10)', () {
    Finder front(String label) => find.byKey(ValueKey('view-${label.toLowerCase()}')).hitTestable();
    final chrome = <String>[];

    void hold(WidgetTester tester, {required bool landscape}) {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = landscape ? const Size(844, 390) : const Size(390, 844);
    }

    setUp(chrome.clear);

    Future<void> openLandscapeTerminal(WidgetTester tester) async {
      hold(tester, landscape: true);
      addTearDown(tester.view.reset);
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(SystemChannels.platform,
          (call) async {
        if (call.method == 'SystemChrome.setEnabledSystemUIMode') chrome.add('${call.arguments}');
        return null;
      });
      addTearDown(() => tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null));
      await open(tester, upright: false);
      await tester.tap(front('Terminal'));
      await tester.pumpAndSettle();
    }

    testWidgets('no header, no dock, floating controls, status bar hidden', (tester) async {
      await openLandscapeTerminal(tester);

      expect(find.byType(AgentTopBar).hitTestable(), findsNothing);
      expect(find.byType(TerminalDock), findsNothing);
      expect(find.byType(ImmersiveControls), findsOneWidget);
      expect(chrome, ['SystemUiMode.immersiveSticky']);
    });

    testWidgets('the controls fade after 3 s and a touch brings them back', (tester) async {
      await openLandscapeTerminal(tester);
      double opacity() => tester
          .widget<AnimatedOpacity>(
              find.descendant(of: find.byType(ImmersiveControls), matching: find.byType(AnimatedOpacity)))
          .opacity;
      expect(opacity(), 1);

      await tester.pump(const Duration(seconds: 3));
      await tester.pump(const Duration(milliseconds: 300));
      expect(opacity(), 0);

      await tester.tapAt(tester.getCenter(find.byType(TerminalView)));
      await tester.pump();
      expect(opacity(), 1);
      // The tap leaves a short gesture timer behind (under 1 s); let it run out.
      await tester.pump(const Duration(seconds: 1));
    });

    testWidgets('Chat leaves full screen and gives the status bar back', (tester) async {
      await openLandscapeTerminal(tester);
      await tester.tap(find.bySemanticsLabel('Chat').hitTestable());
      await tester.pumpAndSettle();

      expect(find.byType(ImmersiveControls), findsNothing);
      expect(find.byType(AgentTopBar).hitTestable(), findsOneWidget);
      expect(chrome, ['SystemUiMode.immersiveSticky', 'SystemUiMode.edgeToEdge']);
    });

    testWidgets('⤡ brings the header back and stays on Terminal; upright and back re-enters',
        (tester) async {
      await openLandscapeTerminal(tester);
      await tester.tap(find.bySemanticsLabel('Leave full screen'));
      await tester.pumpAndSettle();
      expect(find.byType(ImmersiveControls), findsNothing);
      expect(find.byType(TerminalDock), findsOneWidget);

      hold(tester, landscape: false);
      await tester.pumpAndSettle();
      hold(tester, landscape: true);
      await tester.pumpAndSettle();
      expect(find.byType(ImmersiveControls), findsOneWidget);
    });

    testWidgets('upright again leaves full screen by itself', (tester) async {
      await openLandscapeTerminal(tester);
      hold(tester, landscape: false);
      await tester.pumpAndSettle();

      expect(find.byType(ImmersiveControls), findsNothing);
      expect(find.byType(TerminalDock), findsOneWidget);
      expect(chrome.last, 'SystemUiMode.edgeToEdge');
    });
  });
}
