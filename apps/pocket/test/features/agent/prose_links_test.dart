import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/agent/chat_transcript.dart';
import 'package:lotus_pocket/features/agent/link_target.dart';
import 'package:lotus_pocket/features/agent/widgets/chat_lines.dart';

ChatItem reply(String text) => ChatItem(
      kind: ChatLine.prose,
      text: text,
      timestamp: DateTime(2026, 9, 17, 9, 30),
    );

Future<void> show(WidgetTester tester, String text) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(
        body: SingleChildScrollView(
          child: ProseLine(item: reply(text), agent: 'nita', onQuote: (_) {}),
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  group('whose machine a link is on', () {
    test('a public address is reachable from the phone', () {
      final target = LinkTarget.of('https://pub.dev/packages/record');

      expect(target.kind, LinkKind.web);
      expect(target.reachableFromPhone, isTrue);
    });

    test('loopback belongs to the agent, whatever port it names', () {
      for (final raw in [
        'http://127.0.0.1:9877/admin',
        'http://localhost:3000',
        'http://0.0.0.0:8080/',
      ]) {
        expect(LinkTarget.of(raw).kind, LinkKind.machine, reason: raw);
        expect(LinkTarget.of(raw).reachableFromPhone, isFalse, reason: raw);
      }
    });

    test('a private address is the agent\'s network, not the phone\'s', () {
      for (final raw in [
        'http://192.168.1.4:3000',
        'http://10.0.0.7/status',
        'http://172.20.0.2:5173',
        'http://obscam.local:9877',
      ]) {
        expect(LinkTarget.of(raw).kind, LinkKind.machine, reason: raw);
      }
    });

    test('a public address that merely looks private is not', () {
      // 172.32 is outside the private block, and the classification has to know that or
      // it will refuse to open perfectly reachable addresses.
      expect(LinkTarget.of('http://172.32.0.1/').kind, LinkKind.web);
      expect(LinkTarget.of('https://192.169.1.1/').kind, LinkKind.web);
    });

    test('a path keeps the line the agent pointed at', () {
      final target = LinkTarget.of('apps/pocket/lib/main.dart:88');

      expect(target.kind, LinkKind.path);
      expect(target.line, 88);
      expect(target.raw, 'apps/pocket/lib/main.dart:88');
    });
  });

  group('a link the agent simply typed', () {
    testWidgets('opens a sheet that names what it points at', (tester) async {
      await show(tester, 'Panelnya ada di http://127.0.0.1:9877/admin sekarang.');

      await tester.tap(find.text('http://127.0.0.1:9877/admin'));
      await tester.pumpAndSettle();

      expect(find.text('alamat di mesin agen — bukan di ponsel ini'), findsOneWidget);
      // No browser row: the address is on the other machine, and an action that cannot
      // work is worse than one that is absent.
      expect(find.text('BUKA'), findsNothing);
      expect(find.text('SALIN'), findsOneWidget);
      expect(find.text('ADD TO CHAT'), findsWidgets);
    });

    testWidgets('offers to open one the phone can actually reach', (tester) async {
      await show(tester, 'lihat https://pub.dev/packages/record untuk detailnya');

      await tester.tap(find.text('https://pub.dev/packages/record'));
      await tester.pumpAndSettle();

      expect(find.text('BUKA'), findsOneWidget);
      expect(find.text('terbuka di ponsel ini'), findsOneWidget);
    });

    testWidgets('stops before the punctuation that ends the sentence', (tester) async {
      await show(tester, 'ada di https://pub.dev/packages/record.');

      expect(find.text('https://pub.dev/packages/record'), findsOneWidget);
    });

    testWidgets('a path with a line number is pressable too', (tester) async {
      await show(tester, 'baris yang kuubah: lib/features/agent/main.dart:88');

      await tester.tap(find.text('lib/features/agent/main.dart:88'));
      await tester.pumpAndSettle();

      expect(find.text('berkas di mesin agen'), findsOneWidget);
    });

    testWidgets('ordinary prose with a slash in it is left alone', (tester) async {
      await show(tester, 'pilih h264 dan/atau vp9, dua/tiga percobaan lagi');

      // No separator-plus-extension, so nothing here is a path — this is the case that
      // makes the pattern strict rather than generous. A run that *did* match would be
      // lifted out of the paragraph into a `Text` of its own, which is what this looks
      // for.
      expect(find.text('dan/atau'), findsNothing);
      expect(find.text('dua/tiga'), findsNothing);
    });

    testWidgets('a link longer than the phone wraps rather than overflowing',
        (tester) async {
      // Seen on the emulator: a path ran to the right edge of a 1080px screen. A
      // `WidgetSpan` that refuses to wrap would push past it, and the paragraph would
      // overflow silently in release and paint a yellow band in debug.
      tester.view.physicalSize = const Size(390 * 3, 844 * 3);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);

      await show(
        tester,
        'berkasnya di /Users/alwisofwan/workspace/experiments/Lotus/apps/pocket/'
        'lib/features/agent/widgets/agent_prose.dart:188 ya',
      );

      expect(tester.takeException(), isNull);
    });

    testWidgets('a URL inside backticks stays code', (tester) async {
      await show(tester, 'jalankan `curl http://127.0.0.1:9877/health` dulu');

      // `HighlightedText` claims the run first, so the inline-code style wins and the
      // address is never lifted out of it.
      expect(find.text('http://127.0.0.1:9877/health'), findsNothing);
      expect(find.text('curl http://127.0.0.1:9877/health'), findsOneWidget);
    });
  });
}
