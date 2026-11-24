import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/home/widgets/sheet_steps.dart';

/// Perpindahan antar-langkah di dalam satu sheet.
///
/// Tes ini menahan dua artefak yang **terekam di HP sungguhan** pada 2026-08-27, ketika
/// perpindahan ini masih `AnimatedSwitcher`:
///
///   1. tingginya tidak pernah diinterpolasi — `Stack` mengambil ukuran anak terbesar,
///      jadi sheet bertahan setinggi daftar lalu melompat ~80px di satu frame terakhir;
///   2. dua langkah terbaca menembus satu sama lain selama ~120ms, karena cross-fade
///      menjalankan kedua opacity pada kurva yang sama.
///
/// Keduanya lolos dari mata tes unit biasa dan hanya terlihat sebagai "glitch" di tangan,
/// jadi yang diperiksa di sini adalah bentuk geraknya per frame, bukan hasil akhirnya.
void main() {
  const tall = 420.0;
  const short = 160.0;

  Widget host({bool reduceMotion = false}) => MediaQuery(
        data: MediaQueryData(disableAnimations: reduceMotion),
        child: Directionality(
          textDirection: TextDirection.ltr,
          child: Center(
            child: SizedBox(
              width: 300,
              child: _Host(tall: tall, short: short),
            ),
          ),
        ),
      );

  double sheetHeight(WidgetTester tester) => tester.getSize(find.byType(SheetSteps)).height;

  /// Opacity efektif satu langkah, dibaca dari pembungkus yang menganimasikannya.
  double opacityOf(WidgetTester tester, String label) {
    final wrappers = tester.widgetList<Opacity>(
      find.ancestor(of: find.text(label), matching: find.byType(Opacity)),
    );
    return wrappers.fold(1, (value, w) => value * w.opacity);
  }

  testWidgets('tingginya berjalan, bukan melompat di frame terakhir', (tester) async {
    await tester.pumpWidget(host());
    expect(sheetHeight(tester), tall);

    await tester.tap(find.text('deeper'));
    await tester.pump();

    // Inti perbaikannya: di pertengahan animasi, tinggi sheet berada di antara kedua
    // langkah — bukan masih setinggi daftar (lompatan di akhir) dan bukan sudah setinggi
    // langkah kedua (lompatan di awal).
    await tester.pump(const Duration(milliseconds: 150));
    final mid = sheetHeight(tester);
    expect(mid, lessThan(tall - 8), reason: 'sudah mulai turun');
    expect(mid, greaterThan(short + 8), reason: 'belum sampai');

    await tester.pumpAndSettle();
    expect(sheetHeight(tester), short);
  });

  testWidgets('tidak pernah ada dua langkah yang sama-sama terbaca', (tester) async {
    await tester.pumpWidget(host());
    await tester.tap(find.text('deeper'));
    await tester.pump();

    var overlapped = 0;
    for (var elapsed = 0; elapsed < 320; elapsed += 16) {
      await tester.pump(const Duration(milliseconds: 16));
      if (!find.text('LIST').evaluate().isNotEmpty) break;
      final leaving = opacityOf(tester, 'LIST');
      final arriving = opacityOf(tester, 'CONFIG');
      // Double exposure adalah ketika keduanya cukup pekat untuk dibaca sekaligus.
      if (leaving > 0.35 && arriving > 0.35) overlapped++;
    }
    expect(overlapped, 0, reason: 'fade through, bukan cross-fade');

    await tester.pumpAndSettle();
  });

  testWidgets('langkah yang pergi mempertahankan tingginya sendiri', (tester) async {
    await tester.pumpWidget(host());
    await tester.tap(find.text('deeper'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));

    // Kalau ia diperas ke dalam kotak langkah yang datang, barisnya melompat justru di
    // saat ia masih terlihat — itu separuh dari glitch yang terekam.
    expect(tester.getSize(find.text('LIST')).height, tall);

    await tester.pumpAndSettle();
  });

  testWidgets('yang datang bergeser masuk dari sisi yang benar', (tester) async {
    await tester.pumpWidget(host());

    // Masuk lebih dalam: langkah kedua datang dari kanan, jadi awalnya ia di kanan
    // posisi akhirnya.
    await tester.tap(find.text('deeper'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 40));
    final enteringFromRight = tester.getTopLeft(find.text('CONFIG')).dx;
    await tester.pumpAndSettle();
    final settledX = tester.getTopLeft(find.text('CONFIG')).dx;
    expect(enteringFromRight, greaterThan(settledX));

    // Kembali: daftar datang dari kiri.
    await tester.tap(find.text('back'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 40));
    final enteringFromLeft = tester.getTopLeft(find.text('LIST')).dx;
    await tester.pumpAndSettle();
    expect(enteringFromLeft, lessThan(tester.getTopLeft(find.text('LIST')).dx));
  });

  testWidgets('langkah yang pergi membawa State-nya, bukan lahir ulang', (tester) async {
    await tester.pumpWidget(host());
    await tester.tap(find.text('deeper'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('CONFIG'));
    await tester.pump();
    expect(find.text('touched=1'), findsOne);

    await tester.tap(find.text('back'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 30));

    // Yang memudar harus persis apa yang tadi di layar. Tanpa GlobalKey yang berpindah
    // slot, elemennya dibangun ulang di posisi barunya dan State-nya lahir lagi — di
    // aplikasi sungguhan itu berarti pil model berkedip balik ke pilihan awal.
    expect(find.text('touched=1'), findsOne, reason: 'State ikut berpindah slot');

    await tester.pumpAndSettle();
  });

  testWidgets('reduce-motion memotong, tidak memperlambat', (tester) async {
    await tester.pumpWidget(host(reduceMotion: true));
    await tester.tap(find.text('deeper'));
    await tester.pump();

    // Satu frame, dan semuanya sudah sampai: tidak ada gerak yang bisa membuat mual, dan
    // tidak ada langkah lama yang tertinggal di layar.
    expect(sheetHeight(tester), short);
    expect(find.text('LIST'), findsNothing);
    expect(opacityOf(tester, 'CONFIG'), 1);
  });
}

/// Dua langkah dengan tinggi yang berbeda jauh — selisihnya adalah apa yang dulu melompat.
class _Host extends StatefulWidget {
  const _Host({required this.tall, required this.short});

  final double tall;
  final double short;

  @override
  State<_Host> createState() => _HostState();
}

class _HostState extends State<_Host> {
  int depth = 0;

  @override
  Widget build(BuildContext context) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          GestureDetector(
            onTap: () => setState(() => depth = 1),
            child: const Text('deeper'),
          ),
          GestureDetector(
            onTap: () => setState(() => depth = 0),
            child: const Text('back'),
          ),
          SheetSteps(
            depth: depth,
            child: depth == 0
                ? SizedBox(height: widget.tall, child: const Text('LIST'))
                : _Config(height: widget.short),
          ),
        ],
      );
}

/// Langkah kedua dengan State yang bisa diubah operator — pilihan model, di aplikasi
/// sungguhan — supaya bisa diperiksa apakah State itu ikut berpindah saat ia pergi.
class _Config extends StatefulWidget {
  const _Config({required this.height});

  final double height;

  @override
  State<_Config> createState() => _ConfigState();
}

class _ConfigState extends State<_Config> {
  int touched = 0;

  @override
  Widget build(BuildContext context) => SizedBox(
        height: widget.height,
        child: GestureDetector(
          onTap: () => setState(() => touched++),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [const Text('CONFIG'), Text('touched=$touched')],
          ),
        ),
      );
}
