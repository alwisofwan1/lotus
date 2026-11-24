import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/features/home/widgets/start_button.dart';
import 'package:lotus_pocket/features/shared/glyphs.dart';

/// Satu-satunya commit di sheet summon.
///
/// Tes pertama adalah yang paling penting dan paling mudah hilang lagi: tombol ini pernah
/// digambar dengan `raise` — bahasa aplikasi ini untuk *panel* — sementara aksi utama di
/// mana pun lainnya terbalik (`send_button.dart`). Yang menjaganya bukan selera, tapi
/// perbandingan langsung dengan token-nya.
void main() {
  late int started;

  setUp(() => started = 0);

  Widget host() => MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 342,
              child: StartButton(
                semanticsLabel: 'Start claude · opus · medium',
                onStart: () => started++,
              ),
            ),
          ),
        ),
      );

  AppTokens tokensOf(WidgetTester tester) =>
      Theme.of(tester.element(find.byType(StartButton))).extension<AppTokens>()!;

  /// Dekorasi *tujuan* pill-nya, bukan yang sedang diinterpolasi: ia dibaca dari
  /// [AnimatedContainer] sendiri, jadi tes tidak bergantung pada berapa milidetik yang
  /// sudah lewat sejak jempol turun.
  BoxDecoration pill(WidgetTester tester) => tester
      .widget<AnimatedContainer>(
        find.descendant(of: find.byType(StartButton), matching: find.byType(AnimatedContainer)),
      )
      .decoration! as BoxDecoration;

  testWidgets('ia digambar sebagai aksi utama: isi terang, tinta gelap', (tester) async {
    await tester.pumpWidget(host());
    final t = tokensOf(tester);

    expect(pill(tester).color, t.text, reason: 'bukan raise — itu bahasa untuk panel');
    expect(tester.widget<Text>(find.text('Start')).style!.color, t.bg);
  });

  testWidgets('satu kata di tengah, tanpa glyph di sebelahnya', (tester) async {
    await tester.pumpWidget(host());

    // Panah dan launch bay-nya dibuang 2026-08-27. `Start` sudah sebuah verba, dan sheet
    // yang memuatnya sudah berjudul SUMMON — panahnya mengulang arah yang tidak ditempuh
    // apa pun di sini. Yang menjaga keputusan ini bukan selera: sebuah glyph yang kembali
    // diam-diam akan lolos kalau tidak ada yang menghitungnya.
    // Dulu `find.text('↑')`; panahnya sekarang bentuk yang digambar, jadi mencari
    // karakternya akan selalu lolos tanpa menjaga apa pun.
    expect(find.byType(ArrowGlyph), findsNothing);
    expect(find.descendant(of: find.byType(StartButton), matching: find.byType(Text)), findsOne);
  });

  testWidgets('menekan memberi respons yang terasa, melepas mengembalikannya',
      (tester) async {
    await tester.pumpWidget(host());
    final t = tokensOf(tester);
    double scale() => tester.widget<AnimatedScale>(find.byType(AnimatedScale)).scale;

    expect(scale(), 1);
    expect(pill(tester).color, t.text);

    final gesture = await tester.startGesture(tester.getCenter(find.byType(StartButton)));
    await tester.pump();
    expect(scale(), lessThan(1), reason: 'pill memadat di bawah jempol');
    // Yang dulu dikatakan oleh bay — `bg` di atas isi terang — kini dikatakan oleh
    // seluruh permukaannya. Diukur sebagai *lebih gelap*, bukan sebagai satu nilai hex,
    // supaya menyetel banyaknya usapan tidak mematahkan tes yang menjaga arahnya.
    expect(pill(tester).color!.r, lessThan(t.text.r), reason: 'isinya diusap lantai');
    expect(pill(tester).color!.a, 1.0, reason: 'buram — sheet di belakangnya translusen');

    await gesture.up();
    await tester.pump();
    expect(scale(), 1);
    expect(pill(tester).color, t.text);
    expect(started, 1);
  });

  testWidgets('gestur yang dibatalkan tidak menyalakan apa pun', (tester) async {
    await tester.pumpWidget(host());

    final gesture = await tester.startGesture(tester.getCenter(find.byType(StartButton)));
    await tester.pump();
    await gesture.cancel();
    await tester.pumpAndSettle();

    expect(started, 0);
    expect(tester.widget<AnimatedScale>(find.byType(AnimatedScale)).scale, 1);
  });

  testWidgets('satu ketukan adalah satu agen', (tester) async {
    await tester.pumpWidget(host());

    await tester.tap(find.byType(StartButton));
    await tester.pumpAndSettle();

    expect(started, 1);
  });

  testWidgets('pembaca layar mendengar seluruh pilihannya, bukan satu kata', (tester) async {
    await tester.pumpWidget(host());
    final handle = tester.ensureSemantics();

    // Label yang terlihat satu verba karena chip dan footer sudah mencetak sisanya; suara
    // hanya dapat satu kesempatan untuk menyebut apa yang akan terjadi.
    expect(
      tester.getSemantics(find.byType(StartButton)).label,
      'Start claude · opus · medium',
    );

    handle.dispose();
  });
}
