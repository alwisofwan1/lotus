import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/features/agent/widgets/quote_strip.dart';
import 'package:lotus_pocket/features/shared/composer.dart';

Future<void> pumpComposer(
  WidgetTester tester, {
  Widget? above,
  Future<bool> Function(String text)? onSend,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(
        body: Composer(
          mood: ComposerMood.working,
          agent: 'nita',
          above: above,
          onSend: onSend ?? (_) async => true,
        ),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  group('the quote, as a person reads it', () {
    test('a heading keeps its words and loses its hashes', () {
      expect(quotePreview('## Ringkasan encoder'), 'Ringkasan encoder');
    });

    test('bold, inline code and links keep only what was said', () {
      expect(
        quotePreview('meng-encode dengan **software**, lihat `Pembatas:` di '
            '[panel status](http://127.0.0.1:9877/admin)'),
        'meng-encode dengan software, lihat Pembatas: di panel status',
      );
    });

    test('a multi-line quote becomes one run', () {
      expect(
        quotePreview('## Ringkasan\n\n- encoder: software\n- pembatas: cpu'),
        'Ringkasan encoder: software pembatas: cpu',
      );
    });

    test('a fence keeps its command and drops its rails', () {
      expect(
        quotePreview('jalankan\n\n```bash\nadb devices\n```'),
        'jalankan adb devices',
      );
    });
  });

  group('the quote the composer is holding', () {
    testWidgets('shows the agent\'s words without the markup', (tester) async {
      await pumpComposer(
        tester,
        above: QuoteStrip(text: 'software, bukan chip encoder', onDrop: () {}),
      );

      // The `>` belongs on the wire, not on a phone screen — `withQuote` adds it at
      // dispatch and this must not show it early.
      expect(find.text('software, bukan chip encoder'), findsOneWidget);
      expect(find.textContaining('>'), findsNothing);
    });

    testWidgets('can always be dropped, in one 44px target', (tester) async {
      var dropped = false;
      await pumpComposer(
        tester,
        above: QuoteStrip(text: 'pembatas: cpu', onDrop: () => dropped = true),
      );

      final target = find.ancestor(of: find.text('✕'), matching: find.byType(InkWell));
      expect(tester.getSize(target).height, kMinHitTarget);

      await tester.tap(target);
      await tester.pump();
      expect(dropped, isTrue);
    });

    testWidgets('stops at two lines, so the keyboard never buries the answer',
        (tester) async {
      await pumpComposer(
        tester,
        above: QuoteStrip(
          text: 'satu dua tiga empat lima enam tujuh delapan sembilan sepuluh sebelas '
              'dua belas tiga belas empat belas lima belas enam belas tujuh belas',
          onDrop: () {},
        ),
      );

      final quote = tester.widget<Text>(find.textContaining('satu dua tiga'));
      expect(quote.maxLines, 2);
      expect(quote.overflow, TextOverflow.ellipsis);
      expect(tester.takeException(), isNull);
    });

    testWidgets('sits inside the composer\'s own pill, above the field',
        (tester) async {
      await pumpComposer(
        tester,
        above: QuoteStrip(text: 'pembatas: cpu', onDrop: () {}),
      );

      final strip = tester.getRect(find.byType(QuoteStrip));
      final field = tester.getRect(find.byType(TextField));
      expect(strip.bottom, lessThanOrEqualTo(field.top),
          reason: 'above the field, not over it');
    });

    testWidgets('the composer is unchanged when nothing is held', (tester) async {
      await pumpComposer(tester);

      expect(find.byType(QuoteStrip), findsNothing);
      expect(find.byType(TextField), findsOneWidget);
    });
  });
}
