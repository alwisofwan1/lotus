import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/core/transport.dart';
import 'package:lotus_pocket/data/dictation.dart';
import 'package:lotus_pocket/data/fleet_repository.dart';
import 'package:lotus_pocket/data/fleet_store.dart';
import 'package:lotus_pocket/features/home/home_screen.dart';
import 'package:lotus_pocket/features/home/widgets/home_composer.dart';
import 'package:lotus_pocket/features/home/widgets/target_picker.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_event.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/server_event.dart';
import 'package:lotus_pocket/features/shared/send_button.dart';

import '../../support/agent_harness.dart';
import '../../support/fake_recorder.dart';

const HostId mac = HostId('mac');

Cell cell(
  String paneId, {
  required String title,
  String workspace = 'CNVS',
  String? turn,
}) =>
    Cell(
      host: mac,
      paneId: paneId,
      workspaceId: workspace,
      workspaceLabel: workspace,
      agentType: 'claude',
      title: title,
      status: 'live',
      isAlive: true,
      turn: turn,
    );

void main() {
  late StreamController<HostEvent> events;
  late FleetStore fleet;
  late AgentHarness harness;

  setUp(() async {
    harness = await AgentHarness.paired();
    events = StreamController<HostEvent>.broadcast();
    fleet = FleetStore(events.stream);
  });

  tearDown(() async {
    harness.dispose();
    fleet.dispose();
    await events.close();
  });

  Future<void> show(WidgetTester tester) => tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: HomeScreen(
          fleet: fleet,
          project: const ProjectRef(mac, 'CNVS'),
          hostLabel: (h) => h.value,
          onOpenCell: (_) async => false,
          onBack: () {},
          onRefresh: () async => const HydrationReport(answered: [], failed: {}),
          agents: harness.repository,
        ),
      ));

  Future<void> push(WidgetTester tester, List<Cell> cells) async {
    events.add((mac, FleetChangedEvent(cells: cells)));
    await tester.pumpAndSettle();
  }

  /// Atlas waiting, Chess working — so `FleetStore` puts Atlas first.
  Future<void> showFleet(WidgetTester tester) async {
    await show(tester);
    await push(tester, [
      cell('p-1', title: 'Atlas', turn: 'needs-input'),
      cell('p-2', title: 'Chess', turn: 'running'),
    ]);
  }

  List<Uri> dispatches() => harness.http.sent
      .where((r) => r.uri.path.endsWith('/dispatch'))
      .map((r) => r.uri)
      .toList();

  Future<void> type(WidgetTester tester, String text) async {
    await tester.enterText(find.byType(TextField), text);
    await tester.pump();
    await tester.tap(find.byType(SendButton));
    await tester.pumpAndSettle();
  }

  group('who it is aimed at', () {
    testWidgets('defaults to the agent that needs the operator', (tester) async {
      await showFleet(tester);

      // Not an arbitrary default: `FleetStore` orders waiting-first, so the composer
      // opens pointed at the agent the whole screen is about — which makes the common
      // case type-and-send, with no tap spent choosing.
      expect(find.text('→'), findsOne);
      expect(find.text('Reply to Atlas'), findsOne);
    });

    testWidgets('the target is amber while that agent is the one waiting',
        (tester) async {
      await showFleet(tester);

      final chip = tester.widgetList<Text>(find.text('Atlas')).last;
      expect(chip.style!.color, AppTokens.dark.waiting);
    });

    testWidgets('names the target even after typing hides the placeholder',
        (tester) async {
      await showFleet(tester);

      await tester.enterText(find.byType(TextField), 'go on');
      await tester.pump();

      // The target is named by the chip, not only by the placeholder — so it is still
      // on screen with text in the field. What must not happen is the destination being
      // visible only until the operator starts typing (R-10).
      //
      // Asserted on the chip rather than on the placeholder's absence: Material keeps
      // the hint in the tree and fades it, so "the placeholder is gone" is not a
      // property this framework has.
      expect(
        find.descendant(of: find.byType(HomeComposer), matching: find.text('Atlas')),
        findsOne,
      );
    });

    testWidgets('the picker changes it, and the composer follows', (tester) async {
      await showFleet(tester);

      await tester.tap(find.text('Atlas').last);
      await tester.pumpAndSettle();
      expect(find.byType(TargetPicker), findsOne);

      await tester.tap(find.descendant(
        of: find.byType(TargetPicker),
        matching: find.text('Chess'),
      ));
      await tester.pumpAndSettle();

      expect(find.text('Reply to Chess'), findsOne);
    });

    testWidgets('dismissing the picker leaves the target alone', (tester) async {
      await showFleet(tester);
      await tester.tap(find.text('Atlas').last);
      await tester.pumpAndSettle();

      await tester.tapAt(const Offset(10, 10));
      await tester.pumpAndSettle();

      expect(find.text('Reply to Atlas'), findsOne);
    });

    testWidgets('a target that leaves the project falls back rather than lingering',
        (tester) async {
      await showFleet(tester);
      await tester.tap(find.text('Atlas').last);
      await tester.pumpAndSettle();
      await tester.tap(find.descendant(
        of: find.byType(TargetPicker),
        matching: find.text('Chess'),
      ));
      await tester.pumpAndSettle();

      // A snapshot arrives three seconds later, as they do, and Chess is gone.
      await push(tester, [cell('p-1', title: 'Atlas', turn: 'needs-input')]);

      expect(find.text('Reply to Atlas'), findsOne);
    });
  });

  group('sending', () {
    testWidgets('dispatches to the chosen pane, through the gate', (tester) async {
      await showFleet(tester);

      await type(tester, 'clean up the legacy files');

      expect(dispatches(), hasLength(1));
      expect(dispatches().single.path, '/m/cell/p-1/dispatch');
      // The gate is real here: `AgentRepository` runs it, and this asserts it ran
      // rather than that the screen remembered to ask.
      expect(harness.biometrics.prompts, 1);
    });

    testWidgets('after switching target, it goes to the new one', (tester) async {
      await showFleet(tester);
      await tester.tap(find.text('Atlas').last);
      await tester.pumpAndSettle();
      await tester.tap(find.descendant(
        of: find.byType(TargetPicker),
        matching: find.text('Chess'),
      ));
      await tester.pumpAndSettle();

      await type(tester, 'run the suite');

      expect(dispatches().single.path, '/m/cell/p-2/dispatch');
    });

    testWidgets('a refused gate sends nothing at all', (tester) async {
      await showFleet(tester);
      harness.biometrics.answer = false;

      await type(tester, 'delete everything');

      // The stronger assertion: not that it reported a refusal, but that nothing left
      // the phone.
      expect(dispatches(), isEmpty);
      expect(find.textContaining('cancelled'), findsOne);
    });

    /// Temuan §9 no. 4 di `design/revamp-audit.html`, yang dokumen itu sendiri tandai
    /// sebagai **hipotesis, bukan pengamatan**: target default bisa berpindah agen
    /// sementara operator mengetik. Ini putaran buktinya.
    ///
    /// Auditnya meminta instrumentasi. Tes lebih tajam: ia tidak cuma menunjukkan bahwa
    /// chip-nya berubah, ia memeriksa **ke mana pesannya mendarat** — dan itu yang membuat
    /// temuan ini soal salah-kirim, bukan soal tampilan.
    ///
    /// Mekanismenya jelas dari kodenya: `_target()` jatuh ke `cells.first` selama operator
    /// belum memilih, dan `FleetStore` mengurutkan menunggu-dulu (ADR-12 no. 1). Snapshot
    /// datang tiap tiga detik.
    testWidgets('sebuah snapshot tidak boleh memindahkan tujuan di tengah mengetik',
        (tester) async {
      await showFleet(tester);
      expect(find.text('Reply to Atlas'), findsOne);

      // Operator mengetik, belum mengirim. Ia melihat `→ Atlas`.
      await tester.enterText(find.byType(TextField), 'ya, hapus saja');
      await tester.pump();

      // Tiga detik kemudian: Atlas selesai bertanya, Chess yang mulai menunggu. Urutan
      // fleet berbalik, dan `cells.first` sekarang Chess.
      await push(tester, [
        cell('p-1', title: 'Atlas', turn: 'running'),
        cell('p-2', title: 'Chess', turn: 'needs-input'),
      ]);

      expect(find.text('Reply to Atlas'), findsOne,
          reason: 'tujuan yang sudah dilihat operator tidak boleh berpindah sendiri');

      // Pumped first: the button only goes live once the field has told the composer it
      // has words, which is a frame after `enterText`.
      await tester.pump();
      await tester.tap(find.byType(SendButton));
      await tester.pumpAndSettle();

      // Yang paling mahal: bukan chip-nya, tapi pane mana yang menerima kalimatnya.
      expect(dispatches().single.path, '/m/cell/p-1/dispatch');
    });

    testWidgets('field yang kosong tetap mengikuti siapa yang menunggu', (tester) async {
      // Sisi lain dari tes di atas, supaya perbaikannya tidak boleh berupa “kunci target
      // selamanya”: selama belum ada yang diketik, default menunggu-dulu itu justru yang
      // membuat kasus umum jadi ketik-lalu-kirim tanpa satu ketukan memilih.
      await showFleet(tester);

      await push(tester, [
        cell('p-1', title: 'Atlas', turn: 'running'),
        cell('p-2', title: 'Chess', turn: 'needs-input'),
      ]);

      expect(find.text('Reply to Chess'), findsOne);
    });

    testWidgets('an empty message is not a dispatch', (tester) async {
      await showFleet(tester);

      await type(tester, '   ');

      expect(dispatches(), isEmpty);
      expect(harness.biometrics.prompts, 0);
    });

    testWidgets('the field clears on send, so the next message starts empty',
        (tester) async {
      await showFleet(tester);

      await type(tester, 'go on');

      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        isEmpty,
      );
    });

    testWidgets('a dispatch that never arrived gives the words back', (tester) async {
      // Home has no transcript to hold a refused line the way the agent page does, so
      // clearing regardless deleted whatever was typed. Seen for real on 2026-08-09: a
      // MacBook asleep behind a closed lid, a paragraph gone, and a notice underneath
      // claiming it would be delivered later.
      await showFleet(tester);
      harness.http.failWith =
          const TransportUnavailable('timed out', cause: TransportCause.timedOut);

      await type(tester, 'the long paragraph I do not want to retype');

      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'the long paragraph I do not want to retype',
      );
    });

    testWidgets('the words come back with the caret after them, ready to send again',
        (tester) async {
      // Restored to the end rather than the start: the operator's next move is to send
      // it again once the machine is awake, not to edit from the front.
      await showFleet(tester);
      harness.http.failWith =
          const TransportUnavailable('timed out', cause: TransportCause.timedOut);

      await type(tester, 'again');

      final controller = tester.widget<TextField>(find.byType(TextField)).controller!;
      expect(controller.selection.baseOffset, 'again'.length);
    });

    testWidgets('a refusal by the host also keeps the words', (tester) async {
      // Not only unreachable hosts. A 400 is the case where the operator most needs the
      // text back — they are about to edit it and send it again.
      await showFleet(tester);
      harness.http.enqueue('{"error":"text is required"}', status: 400);

      await type(tester, 'something the host disliked');

      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'something the host disliked',
      );
    });
  });

  group('dictating', () {
    late FakeRecorder recorder;
    late Dictation dictation;

    /// Both dictation rows animate on purpose — the pulse while listening, the hairline
    /// while transcribing — so `pumpAndSettle` would wait for animations designed never
    /// to end. Frames are pumped by hand instead.
    Future<void> beat(WidgetTester tester) async {
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(milliseconds: 20));
      }
    }

    Future<void> showWithMic(WidgetTester tester, {bool hostCanTranscribe = true}) async {
      recorder = FakeRecorder();
      dictation = Dictation(
        recorder: recorder,
        repository: harness.repository,
        ticker: (_) => const Stream<void>.empty(),
      );
      addTearDown(dictation.dispose);
      harness.registry.add(harness.host(
        mac,
        features: hostCanTranscribe
            ? const ['fleet', 'dispatch', 'stt']
            : const ['fleet', 'dispatch'],
      ));

      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: HomeScreen(
          fleet: fleet,
          project: const ProjectRef(mac, 'CNVS'),
          hostLabel: (h) => h.value,
          onOpenCell: (_) async => false,
          onBack: () {},
          onRefresh: () async => const HydrationReport(answered: [], failed: {}),
          agents: harness.repository,
          dictation: dictation,
        ),
      ));
      await push(tester, [cell('p-1', title: 'Atlas', turn: 'needs-input')]);
    }

    testWidgets('an empty field offers the microphone, never a dead send button',
        (tester) async {
      await showWithMic(tester);

      // Found by what it *is*, not by the character it used to be. This asserted
      // `find.text('◍')` until the microphone became a painted shape — and a test
      // pinned to a glyph fails every time the drawing improves, while telling you
      // nothing about whether the control is still there. The semantic label is the
      // same thing a screen reader reads, so it survives the next redraw too.
      expect(find.bySemanticsLabel('Dictate'), findsOne);
      // The old bar drew a filled 44×44 circle that could not be pressed. One slot,
      // one control — and the filled shape exists only when there is something to send.
      expect(find.byType(SendButton), findsNothing);
    });

    testWidgets('typing swaps the microphone for send', (tester) async {
      await showWithMic(tester);

      await tester.enterText(find.byType(TextField), 'hello');
      await tester.pumpAndSettle();

      expect(find.byType(SendButton), findsOne);
      expect(find.bySemanticsLabel('Dictate'), findsNothing);
    });

    testWidgets('a host that cannot transcribe shows no microphone at all',
        (tester) async {
      await showWithMic(tester, hostCanTranscribe: false);

      // The rule this app follows everywhere: hide what a host does not advertise. On a
      // Standalone Host `stt` is absent, and a mic that could only fail is worse than
      // none.
      expect(find.bySemanticsLabel('Dictate'), findsNothing);
    });

    testWidgets('tapping it takes over the bar, with cancel and accept', (tester) async {
      await showWithMic(tester);

      await tester.tap(find.bySemanticsLabel('Dictate'));
      await beat(tester);

      expect(find.text('×'), findsOne);
      expect(find.text('✓'), findsOne);
      // The field is gone while listening — the row is the indicator, not a second one.
      expect(find.byType(TextField), findsNothing);
    });

    testWidgets('what was heard lands in the field, unsent', (tester) async {
      await showWithMic(tester);
      harness.http.enqueue('{"text":"run the suite","provider":"openai"}');

      await tester.tap(find.bySemanticsLabel('Dictate'));
      await beat(tester);
      await tester.tap(find.text('✓'));
      await beat(tester);
      await beat(tester);

      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'run the suite',
      );
      // Nothing was dispatched. Recognition mishears, and the send stays the operator's.
      expect(dispatches(), isEmpty);
    });

    testWidgets('dictation joins what was already typed rather than replacing it',
        (tester) async {
      await showWithMic(tester);
      harness.http.enqueue('{"text":"and run the tests","provider":"openai"}');

      await tester.enterText(find.byType(TextField), 'fix the bug');
      await tester.pumpAndSettle();
      // The mic is gone once there is text, so this models the real sequence: speak
      // first, then type — the composer keeps both halves either way.
      await tester.enterText(find.byType(TextField), '');
      await tester.pumpAndSettle();
      await tester.tap(find.bySemanticsLabel('Dictate'));
      await beat(tester);
      await tester.tap(find.text('✓'));
      await beat(tester);
      await beat(tester);

      expect(
        tester.widget<TextField>(find.byType(TextField)).controller!.text,
        'and run the tests',
      );
    });

    testWidgets('cancelling gives the bar back and sends nothing', (tester) async {
      await showWithMic(tester);

      await tester.tap(find.bySemanticsLabel('Dictate'));
      await beat(tester);
      await tester.tap(find.text('×'));
      await beat(tester);

      expect(find.byType(TextField), findsOne);
      expect(recorder.cancels, 1);
      expect(harness.http.sent, isEmpty);
    });
  });

  testWidgets('no composer at all before any cell has arrived', (tester) async {
    await show(tester);

    // Nothing to aim at. An input with no possible destination is worse than empty
    // space, which is the same reason this control waited for a target decision at all.
    // On a host that advertises `spawn` there *is* something to aim at, and `QuietProject`
    // shows the composer in its new-agent mode — this harness pairs a host without it.
    expect(find.byType(TextField), findsNothing);
    expect(find.text('No agents are running in this project.'), findsOne);
  });
}
