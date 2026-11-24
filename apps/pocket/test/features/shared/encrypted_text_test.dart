import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/shared/encrypted_text.dart';

/// Label yang mendekode saat nilainya berubah.
///
/// Yang dijaga di sini bukan "apakah ada animasi", tapi tiga hal yang membedakannya dari
/// sekadar string acak: lebarnya tidak pernah bergoyang, noise-nya stabil di dalam satu
/// frame, dan pembaca layar tidak pernah menerima noise itu.
void main() {
  Widget host(String text, {bool reduceMotion = false}) => MediaQuery(
        data: MediaQueryData(disableAnimations: reduceMotion),
        child: Directionality(
          textDirection: TextDirection.ltr,
          child: Center(child: EncryptedText(text: text)),
        ),
      );

  String shown(WidgetTester tester) => tester.widget<Text>(find.byType(Text)).data!;

  testWidgets('nilai awal tampil apa adanya, tanpa animasi masuk', (tester) async {
    await tester.pumpWidget(host('auto'));

    // Membuka sheet bukan peristiwa "nilainya berubah". Mengacak di sini akan membuat
    // setiap pembukaan sheet terasa seperti sesuatu baru saja terjadi.
    expect(shown(tester), 'auto');
  });

  testWidgets('panjangnya sama dengan target sejak frame pertama', (tester) async {
    await tester.pumpWidget(host('auto'));
    final before = tester.getSize(find.byType(Text));

    await tester.pumpWidget(host('medium'));
    await tester.pump(const Duration(milliseconds: 16));

    // Kalau noise dibuat sepanjang kata lama, apa pun di sebelahnya akan bergeser dua
    // kali: sekali saat mulai, sekali saat selesai.
    expect(shown(tester).length, 'medium'.length);
    final during = tester.getSize(find.byType(Text));
    await tester.pumpAndSettle();
    expect(during, tester.getSize(find.byType(Text)));
    expect(before.height, during.height);
  });

  testWidgets('di tengah jalan ia belum kata targetnya, dan hanya memakai charset-nya',
      (tester) async {
    await tester.pumpWidget(host('auto'));
    await tester.pumpWidget(host('xhigh'));
    await tester.pump(const Duration(milliseconds: 24));

    final mid = shown(tester);
    expect(mid, isNot('xhigh'));
    expect(mid, matches(RegExp(r'^[a-z0-9]+$')), reason: 'huruf kecil dan angka saja');

    await tester.pumpAndSettle();
    expect(shown(tester), 'xhigh');
  });

  testWidgets('mendekode dari kiri ke kanan', (tester) async {
    await tester.pumpWidget(host('auto'));
    await tester.pumpWidget(host('medium'));
    await tester.pump(const Duration(milliseconds: 180));

    // Lebih dari separuh waktu berlalu: awal kata sudah harus mendarat, ekornya belum.
    expect(shown(tester).startsWith('me'), isTrue);
    await tester.pumpAndSettle();
  });

  testWidgets('noise tidak berubah kalau frame-nya tidak maju', (tester) async {
    await tester.pumpWidget(host('auto'));
    await tester.pumpWidget(host('medium'));
    await tester.pump(const Duration(milliseconds: 24));
    final first = shown(tester);

    // Repaint karena alasan lain (mis. induknya rebuild) tidak boleh membuat katanya
    // berkedip — itulah sebabnya acaknya di-seed, bukan `Random()` per frame.
    await tester.pump(Duration.zero);
    expect(shown(tester), first);

    await tester.pumpAndSettle();
  });

  testWidgets('pembaca layar selalu menerima kata sesungguhnya', (tester) async {
    await tester.pumpWidget(host('auto'));
    await tester.pumpWidget(host('medium'));
    await tester.pump(const Duration(milliseconds: 24));

    expect(tester.widget<Text>(find.byType(Text)).semanticsLabel, 'medium');
    await tester.pumpAndSettle();
  });

  testWidgets('reduce-motion tidak mengacak apa pun', (tester) async {
    await tester.pumpWidget(host('auto', reduceMotion: true));
    await tester.pumpWidget(host('medium', reduceMotion: true));
    await tester.pump();

    expect(shown(tester), 'medium');
  });

  testWidgets('perubahan di tengah jalan memulai ulang, bukan mengantre', (tester) async {
    await tester.pumpWidget(host('auto'));
    await tester.pumpWidget(host('medium'));
    await tester.pump(const Duration(milliseconds: 120));
    await tester.pumpWidget(host('max'));
    await tester.pump(const Duration(milliseconds: 16));

    // Menggeser jempol melewati lima stop harus terbaca sebagai satu dekode yang terus
    // berjalan, bukan lima animasi yang saling menunggu.
    expect(shown(tester).length, 'max'.length);
    await tester.pumpAndSettle();
    expect(shown(tester), 'max');
  });
}
