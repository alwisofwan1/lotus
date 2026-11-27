import 'dart:async';
import 'dart:io';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/registry.dart';
import 'package:lotus_pocket/app/theme/theme.dart';
import 'package:lotus_pocket/app/theme/theme_variant.dart';
import 'package:lotus_pocket/data/output_buffer.dart';
import 'package:lotus_pocket/features/agent/widgets/raw_terminal.dart';
import 'package:lotus_pocket/features/agent/widgets/key_bar.dart';
import 'package:lotus_pocket/features/agent/widgets/arrow_pad.dart';
import 'package:lotus_pocket/features/agent/sticky_keys.dart';
import 'package:lotus_pocket/features/agent/widgets/selection_menu.dart';
import 'package:lotus_pocket/features/agent/widgets/flow_surface.dart';
import 'package:lotus_pocket/features/agent/widgets/terminal_dock.dart';
import 'package:lotus_pocket/features/agent/widgets/terminal_metrics.dart';
import 'package:lotus_pocket/features/agent/widgets/terminal_surface.dart';
import 'package:lotus_pocket/models/host_event.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/server_event.dart';
import 'package:lotus_pocket/features/shared/field_glyphs.dart';
import 'package:xterm/xterm.dart';

const HostId mac = HostId('mac');
const macPane = CellRef(mac, 'p-1');

/// What a screen-painter keeps doing: erase a region, then address the cursor.
///
/// Not `CSI ? 1049 h`. That is announced once at session start and the host replays only
/// a 64 KB ring, so it is long gone by the time a phone attaches to a working agent —
/// a detector built on it calls every real TUI line-based. These recur on every frame.
const String paintsScreen = '\x1b[2J\x1b[12;1H';

/// Several long lines, the last of them **without** a trailing newline — so the bottom
/// row a flow surface shows is text rather than the cursor's empty line.
final String wordy =
    List.filled(6, 'the quick brown fox jumps over the lazy dog').join('\r\n');

void main() {
  late StreamController<HostEvent> events;
  var live = false;
  late OutputBuffer buffer;

  /// The page's own `⌨̸` (in its mini bar), reduced to the one thing it does here.
  late StateSetter rebuild;

  setUp(() {
    live = false;
    events = StreamController<HostEvent>.broadcast();
    buffer = OutputBuffer(events.stream)..watch(macPane);
  });

  tearDown(() async {
    buffer.dispose();
    await events.close();
  });

  Future<void> show(
    WidgetTester tester, {
    ValueChanged<String>? onPick,
    Future<void> Function(String)? onInput,
    String? provider,
    ValueChanged<String>? onAsk,
    ValueChanged<bool>? onFinding,
    String agent = 'Atlas',
    ThemeData? theme,
  }) =>
      tester.pumpWidget(MaterialApp(
        theme: theme ?? buildAppTheme(),
        home: Scaffold(
          // `live` belongs to the page, not to the terminal: the composer has to stand
          // down when the pane takes the keyboard. A `StatefulBuilder` is the smallest
          // stand-in for that owner.
          body: StatefulBuilder(
            builder: (context, setState) {
              rebuild = setState;
              return RawTerminal(
              buffer: buffer,
              cell: macPane,
              onPick: onPick,
              onAsk: onAsk,
              onFinding: onFinding,
              agent: agent,
              onInput: onInput,
              provider: provider,
              live: live,
              onToggleLive: () => setState(() => live = !live),
            );
            },
          ),
        ),
      ));


  /// A control in the work bar, sized by the box that actually receives the tap — which
  /// is the number that matters, not the glyph's.
  Finder control(String label) => find.widgetWithText(InkWell, label);

  /// Sakelar tombol-tombol, dipegang lewat bentuknya alih-alih lewat sebuah codepoint.
  ///
  /// Dulu `control('⌨')`. Pelajaran yang sama dengan `⌕` di bawah ini, dan kali ini
  /// terukur: U+2328 dilayani font emoji, jadi ia berwarna dan membuang warna yang
  /// diberikan. Labelnya berbalik antara `Keys on` dan `Keys off`, jadi bentuknya yang
  /// jadi pegangan tetap — bukan salah satu dari dua kalimat itu.
  ///
  /// Since v4 tiket 04 the glyph sits on the dock's `Type to session`, which only turns
  /// keys **on**: once they are, the dock gives its row to the key bar, and the way off is
  /// the page's mini bar — [keysOff] here.
  Finder keysToggle() => find.byType(KeyboardGlyph);

  Future<void> keysOff(WidgetTester tester) async {
    rebuild(() => live = false);
    await tester.pump();
  }

  /// The same thing, held by what the control *is* rather than by the shape drawn on it.
  ///
  /// `Find in output` used to be reached through `find.text('⌕')`, which made the test a
  /// hostage of a codepoint: the glyph became a painted [SearchGlyph] on 2026-08-12 —
  /// because `U+2315` is named `TELEPHONE RECORDER` — and five tests broke without a single
  /// behaviour changing. The semantics label is the handle a screen reader uses too, so it
  /// is the one worth depending on.
  /// `Semantics` membungkus `InkWell`-nya, jadi tombolnya **turunan** dari label itu.
  /// Membuka panel setelan tampilan, tempat `FIT`, `1:1`, `A−`, dan `A+` tinggal sejak
  /// 2026-08-12 — set kontrol lengkap meluap 44px di layar 360dp, diukur oleh
  /// `terminal_bar_test.dart`. Kemampuannya tidak hilang, ia satu ketukan lebih dalam, dan
  /// tes di bawah ini yang membuktikannya.
  Future<void> openLook(WidgetTester tester) async {
    if (find.text('A+').evaluate().isEmpty) {
      await tester.tap(control('Aa'));
      await tester.pumpAndSettle();
    }
  }

  /// `Semantics` membungkus `InkWell`-nya, jadi tombolnya **turunan** dari label itu.
  Finder byLabel(String label) => find.descendant(
        of: find.bySemanticsLabel(label),
        matching: find.byType(InkWell),
      );

  void emit(String chunk, {int offset = 0}) => events
      .add((mac, CellOutputEvent(paneId: 'p-1', chunk: chunk, byteOffset: offset)));

  /// Lets a stream event actually reach [OutputBuffer], then rebuilds.
  ///
  /// `pumpEventQueue()` cannot be used here: `TerminalView` runs a periodic cursor-blink
  /// timer, which keeps re-arming the event queue so the drain never completes and the
  /// test hangs rather than fails. `runAsync` steps outside the fake-async zone for
  /// exactly as long as the delivery needs, which is the supported way to await real
  /// async work.
  ///
  /// Pumped twice: switching mode replaces the emulator, and that is deferred to after
  /// the frame because it can be triggered from inside a write Flutter is already
  /// painting.
  Future<void> settle(WidgetTester tester) async {
    await tester.runAsync(() => Future<void>.delayed(Duration.zero));
    await tester.pump();
    await tester.pump();
  }

  /// Holds a thumb on a word and drags along it — the binding `xterm` actually uses for
  /// touch, and the only one that produces a selection.
  ///
  /// **Pressed near the top, and that is measured rather than assumed.** `selectWord` on
  /// a blank cell selects nothing, and a buffer smaller than the screen sits at the
  /// **top** of it: this harness draws 41 rows and only the first six hold text, so the
  /// centre and the bottom are empty. Three hardcoded offsets missed before a probe was
  /// written to print where the words actually are.
  Future<void> holdOverText(WidgetTester tester) async {
    final finder = find.byType(TerminalView);
    final rect = tester.getRect(finder);
    final press = await tester.startGesture(rect.topLeft + const Offset(30, 14));
    await tester.pump(const Duration(milliseconds: 900));
    await press.moveBy(const Offset(90, 0));
    await tester.pump(const Duration(milliseconds: 40));
    await press.up();
    await settle(tester);
  }

  TerminalView viewOf(WidgetTester tester) =>
      tester.widget<TerminalView>(find.byType(TerminalView));

  /// One character from the phone's own keyboard, the way it really arrives: the IME
  /// edits a field that `CustomTextEdit` keeps primed with two spaces (`deleteDetection`),
  /// and the emulator takes whatever follows them.
  Future<void> phoneTypes(WidgetTester tester, String char) async {
    tester.testTextInput.updateEditingValue(TextEditingValue(
      text: '  $char',
      selection: TextSelection.collapsed(offset: 2 + char.length),
    ));
    await settle(tester);
  }

  group('line-based output is wrapped to the phone, not panned across', () {
    testWidgets('that is the default, because most output is not a TUI', (tester) async {
      await show(tester);
      emit('commit 45364184 fix(pocket): a subject line long enough to need wrapping\n');
      await settle(tester);

      // `issues/03` banned reflow for a screen addressed by coordinates, and the ban was
      // then applied to everything — so `git log` was pinned to 120 columns and panned
      // too. This is the half that was being punished for the other half's problem.
      expect(viewOf(tester).autoResize, isTrue);
      expect(viewOf(tester).terminal.reflowEnabled, isTrue);
      // Nothing to pan: the surface is the screen.
      expect(find.byType(InteractiveViewer), findsNothing);
    });

    testWidgets('read-first holds in every mode', (tester) async {
      await show(tester);
      await settle(tester);

      // ADR-6, guaranteed by the library rather than by our discipline.
      expect(viewOf(tester).readOnly, isTrue);
    });
  });

  // The cells are measured unscaled (`terminal_metrics.dart`), so they must be drawn so too.
  // A phone at font scale 0.85 drew a 59-column pane in 85% of the width (2026-10-05).
  testWidgets('both surfaces ignore the phone\'s font-size setting', (tester) async {
    tester.platformDispatcher.textScaleFactorTestValue = 0.85;
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    await show(tester);
    emit('plain line\n');
    await settle(tester);
    expect(viewOf(tester).textScaler, TextScaler.noScaling);

    emit('$paintsScreen\x1b[2J');
    await settle(tester);
    expect(viewOf(tester).autoResize, isFalse, reason: 'now the pinned surface');
    expect(viewOf(tester).textScaler, TextScaler.noScaling);
  });

  group('a TUI is drawn at the host\'s own width and panned', () {
    testWidgets('addressing the cursor is what switches it', (tester) async {
      await show(tester);
      emit('$paintsScreen\x1b[2J\x1b[31mred\x1b[0m');
      await settle(tester);

      expect(viewOf(tester).autoResize, isFalse);
      expect(viewOf(tester).terminal.reflowEnabled, isFalse);
      expect(find.byType(InteractiveViewer), findsOne);
    });

    testWidgets('the surface keeps its own size rather than being squeezed',
        (tester) async {
      await show(tester);
      emit(paintsScreen);
      await settle(tester);

      final viewer = tester.widget<InteractiveViewer>(find.byType(InteractiveViewer));
      // `constrained: false` is what lets the child keep its own size — the squeeze is
      // what would narrow the terminal and undo the pinning.
      expect(viewer.constrained, isFalse);
      expect(viewer.maxScale, greaterThan(1));
    });

    /// Fase 0 counting (`plans/session-history-hardening/issues/01` no. 3).
    ///
    /// Added to this harness rather than a new one: the rebuild is scheduled with
    /// `addPostFrameCallback`, so it only runs where something is producing frames. A
    /// standalone `TerminalFeed` test was written first, and the callback simply never
    /// fired — the counter read zero and looked like a broken instrument instead of a
    /// harness with no widget in it.
    testWidgets('the rebuild is counted, with the bytes it replayed', (tester) async {
      await show(tester);
      await settle(tester);
      // The first build has nothing to lose — there was no emulator before it.
      expect(buffer.measurements.copyText(), isEmpty);

      emit('${paintsScreen}red');
      await settle(tester);

      final counted = buffer.measurements
          .copyText()
          .split('\n')
          .where((line) => line.isNotEmpty)
          .map((line) => jsonDecode(line) as Map<String, Object?>)
          .where((line) => line['metric'] == 'terminal.rebuild')
          .toList();
      expect(counted, hasLength(1));
      expect(counted.single['layer'], 'pocket');
      // Exactly what `OutputBuffer` still held — the number that answers whether the
      // 4000-line `maxLines` ceiling is ever actually reachable.
      expect(counted.single['value'], buffer.replay.length);
      expect(counted.single['labels'], {'paneId': 'p-1'});
    });

    testWidgets('the bytes survive the switch, because the buffer is replayed',
        (tester) async {
      await show(tester);
      emit('${paintsScreen}red');
      await settle(tester);

      // Changing mode builds a new emulator; everything held is written into it, so the
      // operator does not watch the screen empty itself to change how it is drawn.
      // Searched across the buffer rather than at line 0, because the sequence above
      // parks the cursor on row 12 — which is the point of calling it screen-painting.
      final buffer = viewOf(tester).terminal.buffer;
      final drawn = [
        for (var y = 0; y < buffer.lines.length; y++) buffer.lines[y].toString(),
      ].join();
      expect(drawn, contains('red'));
    });
  });

  group('the zoom control, which is the only choice offered', () {
    testWidgets('a wrapped pane offers none, because there is nothing to choose',
        (tester) async {
      await show(tester);
      emit('plain line-based output\n');
      await settle(tester);

      // The mode toggle that used to sit here let the operator reflow a screen-painter,
      // which `issues/03` proved destroys it. A control that can only break the render
      // is not a control.
      expect(find.text('FIT'), findsNothing);
      expect(find.text('WRAP'), findsNothing);
      expect(find.text('HOST'), findsNothing);
    });

    testWidgets('a pinned pane opens fitted, and 1:1 is one tap away', (tester) async {
      await show(tester);
      emit(paintsScreen);
      await settle(tester);

      await openLook(tester);
      expect(find.text('FIT'), findsOne);
      expect(find.text('1:1'), findsOne);

      await tester.tap(find.text('1:1'));
      await settle(tester);

      // Still the same emulator and the same bytes — only the viewport moved.
      expect(viewOf(tester).terminal.reflowEnabled, isFalse);
      expect(find.byType(InteractiveViewer), findsOne);
    });

    testWidgets('the geometry is stated, so panning reads as deliberate', (tester) async {
      await show(tester);
      emit(paintsScreen);
      await settle(tester);

      expect(find.text('FIXED WIDTH'), findsOne);
      // The raw `160×48` was jargon on a phone (LOT2-104); the words say the same thing.
      expect(find.textContaining('×'), findsNothing);
    });
  });

  group('how large the cells are drawn, which is the other half of legibility', () {
    double sizeOf(WidgetTester tester) => viewOf(tester).textStyle.fontSize;

    testWidgets('opens at the size this screen has always used', (tester) async {
      await show(tester);
      await settle(tester);

      expect(sizeOf(tester), terminalFontSteps[terminalFontDefault]);
    });

    // Claude's status line printed `□□` where it draws `⏵⏵`: no font on the phone had
    // the glyph (LOT2-104). The app carries one, last in line so it only fills gaps.
    for (final paints in [false, true]) {
      testWidgets('falls back to the bundled symbols (${paints ? 'pinned' : 'wrapped'})',
          (tester) async {
        await show(tester);
        if (paints) emit(paintsScreen);
        await settle(tester);

        final fallback = viewOf(tester).textStyle.fontFamilyFallback;
        expect(fallback.last, terminalSymbolFont);
      });
    }

    test('the bundled symbols are declared, and the file is there', () {
      final pubspec = File('pubspec.yaml').readAsStringSync();
      final asset = RegExp('family: $terminalSymbolFont\\s+fonts:\\s+- asset: (\\S+)')
          .firstMatch(pubspec)
          ?.group(1);
      expect(asset, isNotNull);
      expect(File(asset!).existsSync(), isTrue, reason: asset);
    });

    testWidgets('A+ grows the text, and A− takes it back', (tester) async {
      await show(tester);
      emit(paintsScreen);
      await settle(tester);

      await openLook(tester);
      final opened = sizeOf(tester);
      await tester.tap(control('A+'));
      await settle(tester);
      expect(sizeOf(tester), greaterThan(opened));

      await tester.tap(control('A−'));
      await settle(tester);
      expect(sizeOf(tester), opened);
    });

    testWidgets('the pannable surface is re-measured, not just the glyphs',
        (tester) async {
      await show(tester);
      emit(paintsScreen);
      await settle(tester);

      await openLook(tester);
      final before = tester.widget<PinnedSurface>(find.byType(PinnedSurface));
      await tester.tap(control('A+'));
      await settle(tester);
      final after = tester.widget<PinnedSurface>(find.byType(PinnedSurface));

      // Both metrics move or the pan surface is the wrong size for the text inside it:
      // the line box is derived, the advance width is measured off the platform font.
      expect(after.lineHeight, greaterThan(before.lineHeight));
      expect(after.cellWidth, greaterThan(before.cellWidth));
    });

    testWidgets('a control at the end of its range stays put and stops responding',
        (tester) async {
      await show(tester);
      await settle(tester);

      await openLook(tester);
      // A bar whose buttons move as they are used has to be re-read on every press.
      for (var i = 0; i < terminalFontSteps.length + 2; i++) {
        await tester.tap(control('A+'));
        await settle(tester);
      }

      expect(control('A+'), findsOne);
      expect(sizeOf(tester), terminalFontSteps.last);
    });

    testWidgets('every control clears the minimum hit target', (tester) async {
      await show(tester);
      emit(paintsScreen);
      await settle(tester);

      // This app has already shipped a control too small to hit — `READ IT IN FULL` at
      // ~17px, the escape hatch for reading a destructive prompt before approving it.
      await openLook(tester);
      // `Aa` ikut diperiksa: ia kontrol baru, dan kontrol yang terlalu kecil untuk ditekan
      // adalah kesalahan yang app ini sudah pernah kirim sekali.
      for (final label in ['Aa', 'A+', 'A−', 'FIT', '1:1']) {
        final size = tester.getSize(control(label));
        expect(size.width, greaterThanOrEqualTo(kMinHitTarget), reason: label);
        expect(size.height, greaterThanOrEqualTo(kMinHitTarget), reason: label);
      }
    });
  });

  group('the work bar replaces two labels that did nothing', () {
    testWidgets('a wrapped pane says so, and offers no zoom to choose', (tester) async {
      await show(tester);
      emit('plain line-based output\n');
      await settle(tester);

      expect(find.text('WRAPPED'), findsOne);
      // Bahkan sesudah panelnya dibuka: tidak ada yang bisa dipilih selama pane-nya
      // dibungkus ke layar, dan aturan itu ikut pindah bersama kontrolnya.
      await openLook(tester);
      expect(control('FIT'), findsNothing);
    });

    testWidgets('di 360dp barisnya muat, dan kata tombolnya didahulukan',
        (tester) async {
      // Kebalikan dari yang tes ini dulu jamin, dan itu **kemampuan yang didapat**. Dulu:
      // 360dp dengan set kontrol lengkap membuang label geometrinya, karena delapan target
      // 44px memakan seluruh baris — audit §9 no. 9 menyebut akibatnya, bahwa `92×24`
      // praktis tidak pernah terlihat di konfigurasi paling umum. Sesudah `FIT`/`1:1`/`A−`/
      // `A+` pindah ke `TerminalLook`, sisanya 116dp dan aturan “tampilkan hanya jika sisa
      // ≥44dp” terpenuhi.
      //
      // Aturan pembuangannya sendiri tidak dihapus: ia tetap benar untuk layar yang lebih
      // sempit lagi, dan `92×…` yang terpotong tetap bukan geometri melainkan tanda bahwa
      // sesuatu tidak muat.
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);

      await show(tester, onInput: (_) async {}, onPick: (_) {});
      emit(paintsScreen);
      await settle(tester);

      expect(tester.takeException(), isNull);
      // LOT2-104 changed what gives way: the words `FIXED WIDTH` replaced a 40dp size, and
      // beside them `Type to session` was cut short. The action keeps its words now and the
      // label shows only where both fit (`terminal_dock_test`), which at 360dp it may not.
      expect(find.text('Type to session'), findsOne);
    });

    testWidgets('Aa holds the look only — no palette, no full screen', (tester) async {
      await show(tester, onPick: (_) {});
      emit(paintsScreen);
      await settle(tester);
      await openLook(tester);

      // Dropped 2026-10-04 for a cleaner dock; full screen returns in tiket 10.
      expect(control('{}'), findsNothing);
      expect(control('⤢'), findsNothing);
    });
  });

  /// LOT2-103, measured on a device 2026-10-04: the emulator is 48 rows deep, a Claude
  /// pane draws only the top 21, and the surface showed 21 rows of it. `TerminalView`
  /// sticks to — and on every key jumps to — the **bottom** of its buffer, so typing
  /// showed rows 27–47: empty, with the line being typed scrolled out of sight above.
  group('typing into a short TUI keeps its screen in view', () {
    // The alternate screen, a line at the top and a prompt on row 17 — 21 rows used.
    const shortTui = '\x1b[?1049h\x1b[2J\x1b[1;1Htop line\x1b[17;1H> type here'
        '\x1b[21;1Hstatus\x1b[17;12H';

    ScrollPosition inner(WidgetTester tester) => tester
        .state<ScrollableState>(find.descendant(
          of: find.byType(TerminalView),
          matching: find.byType(Scrollable),
        // The last: `TerminalView` nests the buffer's own scroll inside an outer one.
        ).last)
        .position;

    testWidgets('the emulator draws its whole screen, so there is nothing to scroll',
        (tester) async {
      await show(tester, onInput: (_) async {});
      emit(shortTui);
      await settle(tester);
      expect(find.byType(InteractiveViewer), findsOne, reason: 'a pinned pane');

      expect(inner(tester).maxScrollExtent, 0);
    });

    testWidgets('a typed letter leaves the top of the screen where it was',
        (tester) async {
      await show(tester, onInput: (_) async {});
      emit(shortTui);
      await settle(tester);
      await tester.tap(keysToggle());
      await settle(tester);

      await phoneTypes(tester, 'x');

      expect(inner(tester).pixels, 0);
    });
  });

  group('keys reach the pane, once the operator asks for it', () {
    testWidgets('read-first is still the posture a terminal opens in', (tester) async {
      await show(tester, onInput: (_) async {});
      emit(wordy);
      await settle(tester);

      // ADR-6, and it stays true until the operator turns keys on: a stray tap on a
      // live terminal is a Ctrl-C through ten minutes of work.
      expect(viewOf(tester).readOnly, isTrue);
      expect(find.byType(KeyBar), findsNothing);
    });

    testWidgets('a pane with nowhere to send keys offers no switch at all',
        (tester) async {
      await show(tester);
      await settle(tester);

      expect(keysToggle(), findsNothing);
    });

    testWidgets('turning keys on opens the emulator and the key bar together',
        (tester) async {
      await show(tester, onInput: (_) async {});
      emit(wordy);
      await settle(tester);

      await tester.tap(keysToggle());
      await settle(tester);

      expect(viewOf(tester).readOnly, isFalse);
      expect(find.byType(KeyBar), findsOne);
    });

    testWidgets('a key is encoded by the emulator, not by us', (tester) async {
      final sent = <String>[];
      await show(tester, onInput: (data) async => sent.add(data));
      emit(wordy);
      await settle(tester);
      await tester.tap(keysToggle());
      await settle(tester);

      await tester.tap(find.widgetWithText(InkWell, 'esc'));
      await settle(tester);

      // The one byte ESC is, produced by the same emulator that is drawing the pane —
      // it knows the cursor-key mode because it parsed the stream that set it.
      expect(sent, ['\x1b']);
    });

    // `⇧⇥` and `␛␛` drew as two specks on a phone (LOT2-104): the glyphs are thin and the
    // phone has no font that draws them well. Words read; the bytes must not change.
    testWidgets('the Claude caps read as words and still send their keys', (tester) async {
      final sent = <String>[];
      await show(tester, onInput: (data) async => sent.add(data), provider: 'claude');
      emit(wordy);
      await settle(tester);
      await tester.tap(keysToggle());
      await settle(tester);

      expect(find.text('⇧⇥'), findsNothing);
      expect(find.text('␛␛'), findsNothing);

      await tester.tap(find.widgetWithText(InkWell, 'S-tab'));
      await settle(tester);
      expect(sent.join(), '\x1b[Z');

      sent.clear();
      await tester.tap(find.widgetWithText(InkWell, 'esc²'));
      await settle(tester);
      expect(sent.join(), '\x1b\x1b');
    });

    // Measured against the real `claude` CLI in a PTY (2026-10-05): the emulator's own
    // Shift+Return is `ESC O M`, and Claude read it as Enter — it **sent** the half-written
    // prompt. `ESC CR` (Option+Enter) and `^J` both broke the line and sent nothing; `^J`
    // runs the line in a shell, `ESC CR` does not, so the cap sends `ESC CR`.
    testWidgets('S-enter breaks the line in a Claude prompt, and sends nothing',
        (tester) async {
      final sent = <String>[];
      await show(tester, onInput: (data) async => sent.add(data), provider: 'claude');
      emit(wordy);
      await settle(tester);
      await tester.tap(keysToggle());
      await settle(tester);

      await tester.tap(find.widgetWithText(InkWell, 'S-enter'));
      await settle(tester);
      expect(sent.join(), '\x1b\r');
      expect(sent.join(), isNot(contains('\x1bOM')));
    });

    testWidgets('a held alt does not turn S-enter into something else', (tester) async {
      final sent = <String>[];
      await show(tester, onInput: (data) async => sent.add(data), provider: 'claude');
      emit(wordy);
      await settle(tester);
      await tester.tap(keysToggle());
      await settle(tester);

      // alt is meta, and meta is an `ESC` in front: `ESC ESC CR` is not a new line. The
      // cap already carries its modifier, the way `^T` does.
      await tester.tap(find.widgetWithText(InkWell, 'alt'));
      await settle(tester);
      await tester.tap(find.widgetWithText(InkWell, 'S-enter'));
      await settle(tester);
      expect(sent.join(), '\x1b\r');
    });

    testWidgets('a shell gets no S-enter: a new line there is the shell\'s business',
        (tester) async {
      await show(tester, onInput: (_) async {}, provider: 'shell');
      emit(wordy);
      await settle(tester);
      await tester.tap(keysToggle());
      await settle(tester);

      expect(find.widgetWithText(InkWell, 'S-enter'), findsNothing);
    });

    testWidgets('turning keys on puts the caret in the pane, without a second tap',
        (tester) async {
      await show(tester, onInput: (_) async {});
      emit(wordy);
      await settle(tester);

      FocusNode node() =>
          tester.widget<TerminalView>(find.byType(TerminalView)).focusNode!;
      expect(node().hasFocus, isFalse);

      await tester.tap(keysToggle());
      await settle(tester);

      // The whole point of the switch: `TerminalView` opens an input connection when it
      // gains focus, so this is what raises the phone's keyboard and lands the caret in
      // the PTY. Before this, the operator had to turn keys on *and then* tap the
      // surface, and nothing on screen said so.
      expect(node().hasFocus, isTrue);
    });

    testWidgets('turning them off hands the keyboard back', (tester) async {
      await show(tester, onInput: (_) async {});
      emit(wordy);
      await settle(tester);
      await tester.tap(keysToggle());
      await settle(tester);

      await keysOff(tester);
      await settle(tester);

      // Otherwise the phone keeps a keyboard open over a terminal that has stopped
      // listening — the worst kind of control, one that lies by staying put.
      final node = tester.widget<TerminalView>(find.byType(TerminalView)).focusNode!;
      expect(node.hasFocus, isFalse);
    });

    testWidgets('two rows of 40px keys and an arrow pad, nothing to scroll (v4 tiket 05)',
        (tester) async {
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);

      await show(tester, onInput: (_) async {}, provider: 'claude');
      emit(wordy);
      await settle(tester);
      await tester.tap(keysToggle());
      await settle(tester);

      final bar = find.byType(KeyBar);
      expect(find.descendant(of: bar, matching: find.byType(Scrollable)), findsNothing);
      expect(find.byType(ArrowPad), findsOne);

      // Row 1 and row 2, every cap on screen at 360dp.
      for (final label in ['esc', 'tab', 'ctrl', 'alt', 'S-tab', 'esc²', '^T', '^R', 'S-enter', 'paste']) {
        final cap = find.descendant(of: bar, matching: find.text(label));
        expect(cap, findsOne, reason: label);
        final box = tester.getRect(find.ancestor(of: cap, matching: find.byType(InkWell)).first);
        expect(box.height, greaterThanOrEqualTo(44), reason: '$label hit area');
        expect(box.right, lessThanOrEqualTo(360), reason: '$label on screen');
      }
      for (final cap in tester.widgetList<Container>(find.descendant(
        of: bar,
        matching: find.byKey(const ValueKey('cap')),
      ))) {
        expect(cap.constraints?.minHeight, 40);
      }
    });

    testWidgets('backspace exists at all', (tester) async {
      await show(tester, onInput: (_) async {});
      emit(wordy);
      await settle(tester);

      // Without this the key is dead: `CustomTextEdit` starts its editing state empty,
      // deleting from an empty field changes nothing, the IME sends no update, and
      // `onDelete` never fires. Measured on a device 2026-08-10.
      expect(viewOf(tester).deleteDetection, isTrue);
    });

    testWidgets('the pane keeps its keyboard free of prose', (tester) async {
      await show(tester, onInput: (_) async {});
      emit(wordy);
      await settle(tester);

      // `enableSuggestions: false` is a hint Android keyboards ignore — SwiftKey kept a
      // prediction strip over `clear`/`clearly` (device, 2026-08-10). This input type is
      // the one they honour.
      expect(viewOf(tester).keyboardType, TextInputType.visiblePassword);
    });

    testWidgets('while keys are on, the dock gives its row to the keys', (tester) async {
      await show(tester, onInput: (_) async {});
      emit(wordy);
      await settle(tester);
      expect(find.byType(TerminalDock), findsOne);

      await tester.tap(keysToggle());
      await settle(tester);

      // The way back to Chat, and the way to lower the keyboard, are the page's mini bar.
      expect(find.byType(TerminalDock), findsNothing);
      expect(find.byType(KeyBar), findsOne);
    });

    testWidgets('a write of nothing never leaves the phone', (tester) async {
      final sent = <String>[];
      await show(tester, onInput: (data) async => sent.add(data));
      emit(wordy);
      await settle(tester);
      await tester.tap(keysToggle());
      await settle(tester);

      // What the soft keyboard actually does: `CustomTextEdit` computes its delta as
      // `text.substring(initLength, length)`, so an editing-state update that changes
      // nothing — a cursor move, the state echoed back after a reset, the sync when the
      // keyboard opens — arrives here as `''`. Sent on, the host answers 400 *data is
      // required* and the phone shows that on every keystroke (device, 2026-08-10).
      viewOf(tester).terminal.textInput('');
      await settle(tester);

      expect(sent, isEmpty);

      // And a real one still goes.
      viewOf(tester).terminal.textInput('l');
      await settle(tester);
      expect(sent, ['l']);
    });

    testWidgets('a key that names its modifier carries it', (tester) async {
      final sent = <String>[];
      await show(tester, onInput: (data) async => sent.add(data));
      emit(wordy);
      await settle(tester);
      await tester.tap(keysToggle());
      await settle(tester);

      await tester.tap(find.widgetWithText(InkWell, '^C'));
      await settle(tester);

      // The interrupt byte, encoded by the emulator. `^C` means Ctrl-C whether or not
      // the sticky Ctrl is lit — a key labelled with a modifier that then needed the
      // modifier would be a riddle.
      expect(sent, ['\x03']);
    });

    testWidgets('a combination the keytab cannot encode still arrives as itself',
        (tester) async {
      final sent = <String>[];
      await show(tester, onInput: (data) async => sent.add(data));
      emit(wordy);
      await settle(tester);
      await tester.tap(keysToggle());
      await settle(tester);

      await tester.tap(find.widgetWithText(InkWell, 'ctrl'));
      await settle(tester);
      await phoneTypes(tester, '|');

      // Measured rather than assumed: Ctrl-`|` has no encoding. Sending the bare character
      // beats swallowing the press — and the ctrl it could not use is let go, not kept.
      expect(sent.join(), '|');
      await phoneTypes(tester, 'c');
      expect(sent.join(), '|c');
    });

    group('ctrl reaches the phone keyboard (v4 tiket 05)', () {
      Future<List<String>> keyed(WidgetTester tester, {String? provider}) async {
        final sent = <String>[];
        await show(tester, onInput: (data) async => sent.add(data), provider: provider);
        emit(wordy);
        await settle(tester);
        await tester.tap(keysToggle());
        await settle(tester);
        return sent;
      }

      Future<void> ctrl(WidgetTester tester) async {
        await tester.tap(find.widgetWithText(InkWell, 'ctrl'));
        await tester.pump();
      }

      testWidgets('ctrl, then c on the phone keyboard, is ^C', (tester) async {
        final sent = await keyed(tester);

        await ctrl(tester);
        await phoneTypes(tester, 'c');

        expect(sent.join(), '\x03');
      });

      testWidgets('one tap holds it for one key only', (tester) async {
        final sent = await keyed(tester);

        await ctrl(tester);
        await phoneTypes(tester, 'c');
        await phoneTypes(tester, 'd');

        expect(sent.join(), '\x03d');
      });

      testWidgets('two taps lock it across keys, until it is tapped again', (tester) async {
        final sent = await keyed(tester);

        await ctrl(tester);
        await ctrl(tester);
        await phoneTypes(tester, 'c');
        await phoneTypes(tester, 'd');
        expect(sent.join(), '\x03\x04');

        await tester.pump(const Duration(seconds: 1));
        await ctrl(tester);
        await phoneTypes(tester, 'l');
        expect(sent.join(), '\x03\x04l');
      });

      testWidgets('while ctrl is held, row 2 is the control keys', (tester) async {
        await keyed(tester, provider: 'claude');
        expect(find.widgetWithText(InkWell, '^L'), findsNothing);
        expect(find.widgetWithText(InkWell, '^T'), findsOne);

        await ctrl(tester);

        for (final label in ['^C', '^D', '^R', '^L', '^Z']) {
          expect(find.widgetWithText(InkWell, label), findsOne, reason: label);
        }
        expect(find.widgetWithText(InkWell, '^T'), findsNothing);
      });

      testWidgets('a control key carries its own ctrl and lets the held one go',
          (tester) async {
        final sent = await keyed(tester, provider: 'claude');

        await ctrl(tester);
        await tester.tap(find.widgetWithText(InkWell, '^L'));
        await settle(tester);
        await phoneTypes(tester, 'l');

        expect(sent.join(), '\x0cl');
      });

      /// Review 2026-10-04: the emulator speaks by itself too — replies to the host's
      /// queries, mouse reports. Those are not keys the operator pressed.
      testWidgets('a reply the emulator sends by itself does not spend the held ctrl',
          (tester) async {
        final sent = await keyed(tester);

        await ctrl(tester);
        // Device attributes: the emulator answers on its own, through the same door.
        emit('\x1b[c', offset: wordy.length);
        await settle(tester);
        expect(sent.join(), isNotEmpty, reason: 'the reply did go out');
        await phoneTypes(tester, 'c');

        expect(sent.join(), endsWith('\x03'));
      });

      testWidgets('alt, then b on the phone keyboard, is meta-b — lowercase', (tester) async {
        final sent = await keyed(tester);

        await tester.tap(find.widgetWithText(InkWell, 'alt'));
        await tester.pump();
        await phoneTypes(tester, 'b');

        // xterm's own alt handler upper-cases the letter (`\x1bB`, meta-shift-b).
        expect(sent.join(), '\x1bb');
      });

      testWidgets('ctrl and alt together reach the letter as both', (tester) async {
        final sent = await keyed(tester);

        await ctrl(tester);
        await tester.tap(find.widgetWithText(InkWell, 'alt'));
        await tester.pump();
        await phoneTypes(tester, 'z');

        expect(sent.join(), '\x1b\x1a');
      });

      testWidgets('the lock is named once a session, not every time', (tester) async {
        StickyKeys.debugResetHint();
        await keyed(tester);

        await ctrl(tester);
        await ctrl(tester);
        expect(find.text('ctrl locked · tap ctrl to release'), findsOne);

        await tester.pump(const Duration(seconds: 1));
        await ctrl(tester);
        await tester.pump(const Duration(seconds: 1));
        await ctrl(tester);
        await ctrl(tester);
        expect(find.text('ctrl locked · tap ctrl to release'), findsNothing);
      });
    });

    group('the arrow pad (v4 tiket 05)', () {
      testWidgets('a tap is one arrow, toward where it landed', (tester) async {
        final sent = <String>[];
        await show(tester, onInput: (data) async => sent.add(data));
        emit(wordy);
        await settle(tester);
        await tester.tap(keysToggle());
        await settle(tester);

        final pad = tester.getRect(find.byType(ArrowPad));
        await tester.tapAt(pad.center + Offset(pad.width / 3, 0));
        await settle(tester);
        await tester.tapAt(pad.center - Offset(0, pad.height / 3));
        await settle(tester);

        expect(sent.join(), '\x1b[C\x1b[A');
      });

      testWidgets('a drag repeats the arrow, and letting go stops it', (tester) async {
        final sent = <String>[];
        await show(tester, onInput: (data) async => sent.add(data));
        emit(wordy);
        await settle(tester);
        await tester.tap(keysToggle());
        await settle(tester);

        final pad = tester.getCenter(find.byType(ArrowPad));
        final thumb = await tester.startGesture(pad);
        await thumb.moveBy(const Offset(20, 0));
        await tester.pump();
        await thumb.moveBy(const Offset(20, 0));
        for (var i = 0; i < 4; i++) {
          await tester.pump(const Duration(milliseconds: 60));
        }
        await thumb.up();
        await settle(tester);

        int rights() => '\x1b[C'.allMatches(sent.join()).length;
        final held = rights();
        expect(held, greaterThanOrEqualTo(3));
        // Never past 20 a second: 240ms of holding is at most five, plus the first.
        expect(held, lessThanOrEqualTo(6));
        expect(sent.join().replaceAll('\x1b[C', ''), isEmpty);

        await tester.pump(const Duration(milliseconds: 500));
        await settle(tester);
        expect(rights(), held);
      });
    });

    testWidgets('the second row follows the runner', (tester) async {
      await show(tester, onInput: (_) async {}, provider: 'claude');
      emit(wordy);
      await settle(tester);
      await tester.tap(keysToggle());
      await settle(tester);

      // A Claude pane gets the keys its TUI reads; a shell would get ^C ^D ^Z instead,
      // and a single fixed row would spend half its width on keys that do nothing here.
      // A Claude pane leads with the mode cycle rather than with an interrupt.
      expect(find.widgetWithText(InkWell, 'S-tab'), findsOne);
      expect(find.widgetWithText(InkWell, '^C'), findsNothing);
    });

    testWidgets('a shell pane gets a shell row', (tester) async {
      await show(tester, onInput: (_) async {}, provider: 'shell');
      emit(wordy);
      await settle(tester);
      await tester.tap(keysToggle());
      await settle(tester);

      expect(find.widgetWithText(InkWell, '^C'), findsOne);
      expect(find.widgetWithText(InkWell, '^T'), findsNothing);
      expect(find.widgetWithText(InkWell, 'S-tab'), findsNothing);
    });

    testWidgets('turning keys off closes the pane to them again', (tester) async {
      final sent = <String>[];
      await show(tester, onInput: (data) async => sent.add(data));
      emit(wordy);
      await settle(tester);
      await tester.tap(keysToggle());
      await settle(tester);
      await keysOff(tester);
      await settle(tester);

      expect(viewOf(tester).readOnly, isTrue);
      expect(find.byType(KeyBar), findsNothing);
      expect(sent, isEmpty);
    });
  });

  group('finding a word in what the pane printed', () {
    Future<void> openFind(WidgetTester tester, String query) async {
      await tester.tap(byLabel('Find in output'));
      await settle(tester);
      await tester.enterText(find.byType(TextField), query);
      await settle(tester);
    }

    testWidgets('the bar is absent until it is asked for', (tester) async {
      await show(tester);
      emit(wordy);
      await settle(tester);

      expect(find.byType(TextField), findsNothing);
      expect(byLabel('Find in output'), findsOne);
    });

    testWidgets('it counts what it found, and says so when there is none',
        (tester) async {
      await show(tester);
      emit(wordy);
      await settle(tester);

      await openFind(tester, 'fox');
      // Six identical lines, one `fox` each — counted rather than merely marked, so the
      // operator knows whether walking the rest is worth it.
      expect(find.text('1 / 6'), findsOne);

      await tester.enterText(find.byType(TextField), 'zebra');
      await settle(tester);
      expect(find.text('NONE'), findsOne);
    });

    testWidgets('matching ignores case, because a terminal does not', (tester) async {
      await show(tester);
      emit(wordy);
      await settle(tester);

      await openFind(tester, 'FOX');

      expect(find.text('1 / 6'), findsOne);
    });

    testWidgets('the two directions walk the matches, and wrap', (tester) async {
      await show(tester);
      emit(wordy);
      await settle(tester);
      await openFind(tester, 'fox');

      await tester.tap(byLabel('Next match'));
      await settle(tester);
      expect(find.text('2 / 6'), findsOne);

      // Wraps rather than dead-ending: a phone screen holds a dozen lines and the
      // buffer holds four thousand.
      await tester.tap(byLabel('Previous match'));
      await settle(tester);
      await tester.tap(byLabel('Previous match'));
      await settle(tester);
      expect(find.text('6 / 6'), findsOne);
    });

    testWidgets('every hit is painted, and the current one differently', (tester) async {
      await show(tester);
      emit(wordy);
      await settle(tester);
      await openFind(tester, 'fox');

      final controller = viewOf(tester).controller!;
      expect(controller.highlights, hasLength(6));
      // The two weights are the app's own ink, not a third colour: this product allows
      // amber and red to mean something, and a search hit is neither.
      final current =
          controller.highlights.where((h) => h.color == themeRegistry.first.dark.terminal[TermRole.findHitCurrent]);
      expect(current, hasLength(1));
    });

    testWidgets('a theme change repaints open highlights in the new palette', (tester) async {
      await show(tester);
      emit(wordy);
      await settle(tester);
      await openFind(tester, 'fox');

      const current = Color(0x66123456);
      const other = Color(0x33123456);
      final base = themeRegistry.first.dark;
      await show(tester, theme: buildAppTheme(ThemeVariant(
        brightness: base.brightness,
        tokens: base.tokens,
        terminal: base.terminal.copyWith({TermRole.findHitCurrent: current, TermRole.findHit: other}),
        shape: base.shape,
        elevation: base.elevation,
      )));
      await tester.pump(const Duration(milliseconds: 400)); // past MaterialApp's theme lerp

      final colours = viewOf(tester).controller!.highlights.map((h) => h.color).toList();
      expect(colours, hasLength(6));
      expect(colours.where((c) => c == current), hasLength(1));
      expect(colours.where((c) => c == other), hasLength(5));
    });

    testWidgets('closing it takes the highlights with it', (tester) async {
      await show(tester);
      emit(wordy);
      await settle(tester);
      await openFind(tester, 'fox');
      expect(viewOf(tester).controller!.highlights, isNotEmpty);

      await tester.tap(byLabel('Done'));
      await settle(tester);

      // A highlight is removed by disposing it, so a bar that closed without doing that
      // would leave stripes nothing could clear.
      expect(viewOf(tester).controller!.highlights, isEmpty);
      expect(find.byType(TextField), findsNothing);
    });

    /// v4 tiket 07: the bar takes the page header's place, so the page is told.
    testWidgets('tells the page while it is open, so the header can step aside',
        (tester) async {
      final finding = <bool>[];
      await show(tester, onFinding: finding.add);
      emit(wordy);
      await settle(tester);

      await openFind(tester, 'fox');
      await tester.tap(byLabel('Done'));
      await settle(tester);

      expect(finding, [true, false]);
    });

    testWidgets('the field is 40px, the steps 36 by 40', (tester) async {
      await show(tester);
      emit(wordy);
      await settle(tester);
      await openFind(tester, 'fox');

      expect(tester.getSize(find.byKey(const ValueKey('find-field'))).height, 40);
      for (final label in ['Previous match', 'Next match']) {
        expect(tester.getSize(byLabel(label)), const Size(36, 40), reason: label);
      }
    });

    testWidgets('a pinned pane is aimed at the match, not at the cursor',
        (tester) async {
      await show(tester);
      emit('$paintsScreen$wordy');
      await settle(tester);
      await openFind(tester, 'fox');

      final surface = tester.widget<PinnedSurface>(find.byType(PinnedSurface));
      expect(surface.focusLine, isNotNull);
    });
  });

  group('a selection can finally be read, and so acted on', () {
    testWidgets('nothing is offered until something is held', (tester) async {
      await show(tester, onPick: (_) {});
      emit(wordy);
      await settle(tester);

      expect(find.text('Copy'), findsNothing);
    });

    /// v4 tiket 07: a menu by the selection, not a bar at the foot — the thumb that made
    /// the selection is already there.
    testWidgets('holding a word floats copy, to chat and ask over the output',
        (tester) async {
      await show(tester, onPick: (_) {}, onAsk: (_) {});
      emit(wordy);
      await settle(tester);

      await holdOverText(tester);

      expect(find.text('Copy'), findsOne);
      expect(find.text('To chat'), findsOne);
      expect(find.text('Ask Atlas'), findsOne);
      final menu = tester.getRect(find.byType(SelectionMenu));
      final surface = tester.getRect(find.byType(TerminalView));
      expect(surface.contains(menu.center), isTrue, reason: 'floats over the output');
      // As wide as its words: `Ask` gives way when short of room, and must not grow when
      // there is plenty — it stretched the pill across the whole pane (LOT2-104).
      final pill = tester.getRect(
          find.ancestor(of: find.text('Copy'), matching: find.byType(Material)).first);
      expect(pill.width, lessThan(surface.width / 2));
      expect(find.byType(TerminalDock), findsOne, reason: 'the dock keeps its row');
    });

    testWidgets('copy puts the held text on the clipboard, verbatim', (tester) async {
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String?;
          }
          return null;
        },
      );
      addTearDown(() => tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null));

      await show(tester, onPick: (_) {});
      emit(wordy);
      await settle(tester);
      await holdOverText(tester);

      await tester.tap(find.text('Copy'));
      await settle(tester);

      expect(copied, isNotNull);
      expect('the quick brown fox jumps', contains(copied!.trim()));
      // Acting on it lets it go: a menu that stayed up would sit over the output the
      // operator copied it from.
      expect(find.text('Copy'), findsNothing);
    });

    testWidgets('to chat hands the text over, and sends nothing itself', (tester) async {
      final sent = <String>[];
      await show(tester, onPick: sent.add);
      emit(wordy);
      await settle(tester);
      await holdOverText(tester);

      await tester.tap(find.text('To chat'));
      await settle(tester);

      // This is what Termius cannot do: the agent is on the other side of the same
      // page, so a stack trace read here reaches it without being retyped on glass.
      expect(sent, hasLength(1));
      expect('the quick brown fox jumps', contains(sent.single.trim()));
    });

    testWidgets('ask hands the text over as a quote, to the page', (tester) async {
      final asked = <String>[];
      await show(tester, onPick: (_) {}, onAsk: asked.add);
      emit(wordy);
      await settle(tester);
      await holdOverText(tester);

      await tester.tap(find.text('Ask Atlas'));
      await settle(tester);

      expect(asked, hasLength(1));
      expect('the quick brown fox jumps', contains(asked.single.trim()));
      expect(find.text('Ask Atlas'), findsNothing);
    });

    testWidgets('a long agent name gives way, on a 360dp phone', (tester) async {
      tester.view
        ..physicalSize = const Size(360, 720)
        ..devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await show(tester,
          onPick: (_) {}, onAsk: (_) {}, agent: 'a persona with a very long name indeed');
      emit(wordy);
      await settle(tester);
      await holdOverText(tester);

      expect(tester.takeException(), isNull);
      expect(find.text('Copy'), findsOne);
      expect(find.text('To chat'), findsOne);
      expect(tester.getRect(find.byType(SelectionMenu)).right, lessThanOrEqualTo(360));
    });

    /// Review, 2026-10-04: every lift moved it, so a scroll carried it off the text.
    testWidgets('a later touch that selects nothing new leaves the menu where it is',
        (tester) async {
      await show(tester, onPick: (_) {}, onAsk: (_) {});
      emit(wordy);
      await settle(tester);
      await holdOverText(tester);
      final before = tester.getRect(find.text('Copy'));

      final rect = tester.getRect(find.byType(TerminalView));
      final touch = await tester.startGesture(rect.bottomRight - const Offset(40, 60));
      await touch.moveBy(const Offset(0, -30));
      await touch.up();
      await settle(tester);

      expect(tester.getRect(find.text('Copy')), before);
    });

    /// LOT2-104: it sat by the lifted thumb, so a selection dragged downwards put the
    /// menu over the very lines it was about. It belongs above the text, like the
    /// phone's own text menu, and clear of every selected row.
    testWidgets('the menu sits above the selected text, never over it', (tester) async {
      await show(tester, onPick: (_) {}, onAsk: (_) {});
      emit(List.filled(20, 'the quick brown fox jumps over the lazy dog').join('\r\n'));
      await settle(tester);

      final view = tester.state<TerminalViewState>(find.byType(TerminalView));
      final line = view.renderTerminal.lineHeight;
      final rect = tester.getRect(find.byType(TerminalView));
      final press = await tester.startGesture(rect.topLeft + Offset(30, line * 6.5));
      await tester.pump(const Duration(milliseconds: 900));
      await press.moveBy(Offset(60, line * 4));
      await tester.pump(const Duration(milliseconds: 40));
      await press.up();
      await settle(tester);

      final selected = Rect.fromLTRB(rect.left, rect.top + line * 6, rect.right, rect.top + line * 11);
      final menu = tester.getRect(
          find.ancestor(of: find.text('Copy'), matching: find.byType(Material)).first);
      expect(find.text('Copy'), findsOne);
      expect(menu.overlaps(selected), isFalse, reason: 'menu $menu, text $selected');
      expect(menu.bottom, lessThanOrEqualTo(selected.top));
      expect(selected.top - menu.bottom, lessThan(line * 1.5), reason: 'next to it');
    });

    testWidgets('a pane with nowhere to send still offers copy, and only copy',
        (tester) async {
      await show(tester);
      emit(wordy);
      await settle(tester);
      await holdOverText(tester);

      expect(find.text('Copy'), findsOne);
      expect(find.text('To chat'), findsNothing);
      expect(find.textContaining('Ask'), findsNothing);
    });
  });

  /// v4 tiket 07: no permanent button — the operator read `↓` in the dock as *download*.
  /// The pill exists only while there is something below to go back to.
  group('the way back to the latest output', () {
    final long = List.generate(80, (i) => 'line $i').join('\r\n');
    final twelve = List.generate(12, (i) => '\r\nnew $i').join();
    Future<void> scrollUp(WidgetTester tester) async {
      await tester.drag(find.byType(TerminalView), const Offset(0, 400));
      await settle(tester);
    }

    testWidgets('scrolled up, new lines raise a pill that counts them', (tester) async {
      await show(tester);
      emit(long);
      await settle(tester);
      await scrollUp(tester);
      expect(find.byType(NewLinesPill), findsNothing, reason: 'nothing new yet');

      emit(twelve, offset: long.length);
      await settle(tester);

      expect(find.text('↓ 12 new lines'), findsOne);
    });

    testWidgets('tapping it goes to the bottom, and the pill goes', (tester) async {
      await show(tester);
      emit(long);
      await settle(tester);
      await scrollUp(tester);
      emit(twelve, offset: long.length);
      await settle(tester);

      await tester.tap(find.byType(NewLinesPill));
      await settle(tester);

      expect(find.byType(NewLinesPill), findsNothing);
      // Following again: the next line lands in view without a pill.
      emit('\r\nlast', offset: long.length + twelve.length);
      await settle(tester);
      expect(find.byType(NewLinesPill), findsNothing);
    });

    /// Review, 2026-10-04: a busy pane sits at the buffer's cap, where the line count
    /// stops growing — counted that way, the pill never came.
    testWidgets('still counts once the buffer is full', (tester) async {
      await show(tester);
      final full = List.generate(4100, (i) => 'line $i').join('\r\n');
      emit(full);
      await settle(tester);
      expect(viewOf(tester).terminal.buffer.lines.length, viewOf(tester).terminal.maxLines);
      await scrollUp(tester);

      emit(twelve, offset: full.length);
      await settle(tester);

      expect(find.text('↓ 12 new lines'), findsOne);
    });

    testWidgets('at the bottom, new output raises nothing', (tester) async {
      await show(tester);
      emit(long);
      await settle(tester);

      emit(twelve, offset: long.length);
      await settle(tester);

      expect(find.byType(NewLinesPill), findsNothing);
    });
  });

  testWidgets('a busy pane does not rebuild the furniture around it', (tester) async {
    await show(tester);
    emit('plain line-based output\r\n');
    await settle(tester);

    final before = tester.widget<TerminalDock>(find.byType(TerminalDock));
    for (var i = 0; i < 5; i++) {
      emit('line $i\r\n');
      await settle(tester);
    }

    // `RenderTerminal` subscribes to the emulator itself, so output repaints without
    // anyone rebuilding the widgets around it. Notifying per chunk rebuilt the bar, the
    // key bar and the surfaces fourteen times a second — jank that reads as input lag,
    // bought for nothing.
    expect(identical(tester.widget<TerminalDock>(find.byType(TerminalDock)), before), isTrue);
  });

  testWidgets('what was already held is written, then live chunks follow', (tester) async {
    await show(tester);
    emit('before ');
    await settle(tester);

    emit('after');
    await settle(tester);

    // Read off the emulator's own buffer rather than our string: this proves the bytes
    // reached `xterm`, which is the only thing that matters here.
    final firstLine = viewOf(tester).terminal.buffer.lines[0].toString();
    expect(firstLine, contains('before'));
    expect(firstLine, contains('after'));
  });

  group('one emulator for the life of the page', () {
    String drawn(WidgetTester tester) {
      final lines = viewOf(tester).terminal.buffer.lines;
      return [for (var y = 0; y < lines.length; y++) lines[y].toString()].join('|');
    }

    testWidgets('a re-subscribe replays the ring into an emptied terminal, not on top',
        (tester) async {
      await show(tester);
      emit('ring-one\r\nring-two');
      await settle(tester);
      final emulator = viewOf(tester).terminal;

      // What `tail` does on a page coming back to the front: the buffer is cleared and
      // the host answers by replaying its ring from the start.
      buffer
        ..watch(null)
        ..watch(macPane);
      emit('ring-one\r\nring-two');
      await settle(tester);

      // Same emulator — scroll, zoom and selection hang off it — holding the ring once.
      expect(identical(viewOf(tester).terminal, emulator), isTrue);
      expect('ring-one'.allMatches(drawn(tester)), hasLength(1));
      expect('ring-two'.allMatches(drawn(tester)), hasLength(1));
    });

    testWidgets('what the pane printed before the buffer was cleared does not linger',
        (tester) async {
      await show(tester);
      emit('stale-line');
      await settle(tester);

      buffer
        ..watch(null)
        ..watch(macPane);
      emit('fresh-line');
      await settle(tester);

      expect(drawn(tester), isNot(contains('stale-line')));
      expect(drawn(tester), contains('fresh-line'));
    });

    testWidgets('bytes of another pane never reach this emulator', (tester) async {
      await show(tester);
      emit('mine');
      await settle(tester);

      // A neighbour on the same host took the tail: the shared buffer now carries its
      // bytes, which are not this pane's to draw.
      buffer.watch(const CellRef(mac, 'p-2'));
      events.add((mac, const CellOutputEvent(paneId: 'p-2', chunk: 'theirs', byteOffset: 0)));
      await settle(tester);

      expect(drawn(tester), contains('mine'));
      expect(drawn(tester), isNot(contains('theirs')));
    });
  });

  group('what is missing is said out loud (R-4)', () {
    testWidgets('no notice while nothing has been lost', (tester) async {
      await show(tester);
      await settle(tester);

      expect(find.textContaining('never arrived'), findsNothing);
    });

    testWidgets('a truncation names how many bytes went missing', (tester) async {
      await show(tester);
      await settle(tester);

      events.add((
        mac,
        const CellTruncatedEvent(paneId: 'p-1', requestedFromByte: 1000, servedFromByte: 4000),
      ));
      await settle(tester);

      // A terminal that looked seamless after a long reconnect would be lying.
      expect(find.textContaining('3000 bytes never arrived'), findsOne);
    });
  });
}
