import 'package:flutter/gestures.dart' show kTouchSlop;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/home/widgets/close_action.dart';
import 'package:lotus_pocket/features/home/widgets/swipe_to_close.dart';

/// Geser untuk menutup, diuji lewat antarmuka publik [SwipeToClose] dan bukan lewat
/// controller di dalamnya: yang diamati adalah apa yang ada di layar dan callback mana yang
/// menyala. Spesifikasinya ada di `plans/lotus-pocket/design/revamp-modern.html` §4.
void main() {
  Widget host({
    required bool isOpen,
    ValueChanged<bool>? onOpenChanged,
    Future<bool> Function()? onClose,
  }) =>
      MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(
          body: ListView(
            children: [
              SwipeToClose(
                agent: 'Atlas',
                isOpen: isOpen,
                onOpenChanged: onOpenChanged ?? (_) {},
                onClose: onClose ?? () async => true,
                child: const SizedBox(height: 72, child: Text('Atlas row')),
              ),
            ],
          ),
        ),
      );

  group('diam', () {
    testWidgets('menggambar barisnya dan tidak menawarkan apa pun', (tester) async {
      var closed = 0;
      await tester.pumpWidget(host(isOpen: false, onClose: () async {
        closed++;
        return true;
      }));

      expect(find.text('Atlas row'), findsOneWidget);
      // Aksinya tidak ada di pohon sama sekali saat diam. Bukan sekadar transparan: sebuah
      // tombol yang mengakhiri agen tidak boleh bisa ditekan oleh apa pun yang kebetulan
      // menemukannya, termasuk pembaca layar.
      expect(find.text('HOLD TO CLOSE'), findsNothing);
      expect(closed, 0);
    });
  });

  group('geser', () {
    testWidgets('lewat ambang lalu dilepas: minta dibuka', (tester) async {
      final asked = <bool>[];
      await tester.pumpWidget(host(isOpen: false, onOpenChanged: asked.add));

      // Ambangnya setengah tempuh, **plus touch slop**: pengenal drag menelan ~18px sebelum
      // melaporkan delta pertamanya, jadi baris bergerak lebih pendek dari jarinya. Itu bukan
      // cacat, itu yang dilakukan setiap daftar di platform ini — dan mengabaikannya di sini
      // akan membuat test lulus untuk gestur yang di HP tidak cukup jauh.
      // Lambat, supaya jalur *jarak* yang diuji dan bukan jalur kecepatan.
      await tester.timedDrag(
        find.text('Atlas row'),
        const Offset(-(SwipeToClose.snapAt + kTouchSlop + 8), 0),
        const Duration(milliseconds: 400),
      );
      await tester.pumpAndSettle();

      expect(asked, [true]);
    });

    testWidgets('belum sampai ambang: tidak minta apa pun', (tester) async {
      final asked = <bool>[];
      await tester.pumpWidget(host(isOpen: false, onOpenChanged: asked.add));

      await tester.timedDrag(
        find.text('Atlas row'),
        const Offset(-(SwipeToClose.snapAt + kTouchSlop - 12), 0),
        const Duration(milliseconds: 400),
      );
      await tester.pumpAndSettle();

      expect(asked, isEmpty, reason: 'tarikan pendek harus kembali tanpa mengubah apa pun');
    });

    testWidgets('sentilan cepat membuka meski pendek', (tester) async {
      final asked = <bool>[];
      await tester.pumpWidget(host(isOpen: false, onOpenChanged: asked.add));

      // Jarak di bawah ambang bahkan sebelum slop, tapi cepat. Satu ambang saja akan membuat salah satu gaya
      // tangan terasa rusak, jadi keduanya diuji.
      await tester.timedDrag(
        find.text('Atlas row'),
        const Offset(-(kTouchSlop + 20), 0),
        const Duration(milliseconds: 40),
      );
      await tester.pumpAndSettle();

      expect(asked, [true]);
    });

    testWidgets('terbuka: aksinya ada dan menyebut agennya', (tester) async {
      await tester.pumpWidget(host(isOpen: true));
      await tester.pumpAndSettle();

      expect(find.text('Atlas'), findsOneWidget);
      expect(find.text('HOLD TO CLOSE'), findsOneWidget);
    });
  });

  group('menahan untuk komit', () {
    testWidgets('satu ketukan tidak mengakhiri apa pun', (tester) async {
      var closed = 0;
      await tester.pumpWidget(host(isOpen: true, onClose: () async {
        closed++;
        return true;
      }));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Atlas'));
      await tester.pumpAndSettle();

      // Ini keseluruhan alasan menahan itu ada: satu ketukan salah sasaran pada target
      // selebar ini tidak boleh mengakhiri agen.
      expect(closed, 0);
    });

    testWidgets('ditahan penuh: mengakhiri, tepat sekali', (tester) async {
      var closed = 0;
      await tester.pumpWidget(host(isOpen: true, onClose: () async {
        closed++;
        return true;
      }));
      await tester.pumpAndSettle();

      final press = await tester.startGesture(tester.getCenter(find.text('Atlas')));
      // `onTapDown` menunggu `kPressTimeout` lebih dulu, karena pengenal drag induknya juga
      // ikut di arena gestur. Satu `pump` panjang akan melompati tenggat itu tanpa pernah
      // memberi frame ke sapuannya, jadi tenggatnya dilewati dulu.
      await tester.pump(const Duration(milliseconds: 120));
      await tester.pumpAndSettle();
      await press.up();
      await tester.pumpAndSettle();

      expect(closed, 1);
    });

    testWidgets('dilepas lebih awal: tidak mengakhiri apa pun', (tester) async {
      var closed = 0;
      await tester.pumpWidget(host(isOpen: true, onClose: () async {
        closed++;
        return true;
      }));
      await tester.pumpAndSettle();

      final press = await tester.startGesture(tester.getCenter(find.text('Atlas')));
      await tester.pump(const Duration(milliseconds: 120));
      // Dua pertiga jalan, lalu dilepas — pembatalan paling alami yang bisa dilakukan jari.
      await tester.pump(CloseAction.holdFor * 0.66);
      await press.up();
      await tester.pumpAndSettle();

      expect(closed, 0);
    });
  });

  group('hidup bersama daftar', () {
    testWidgets('tarikan vertikal menggulir, bukan membuka', (tester) async {
      final asked = <bool>[];
      await tester.pumpWidget(host(isOpen: false, onOpenChanged: asked.add));

      await tester.drag(find.text('Atlas row'), const Offset(0, -140));
      await tester.pumpAndSettle();

      // `ListView` harus menang untuk niat vertikal. Kalau tidak, menggulir daftar akan
      // menyenggol aksi yang mengakhiri agen.
      expect(asked, isEmpty);
    });

    testWidgets('pembaca layar mendapat nama agennya dan caranya', (tester) async {
      // Dibuang di dalam body, bukan lewat `addTearDown`: verifikasi akhir test berjalan
      // lebih dulu, dan ia menganggap handle yang masih hidup sebagai kegagalan.
      final semantics = tester.ensureSemantics();
      await tester.pumpWidget(host(isOpen: true));
      await tester.pumpAndSettle();

      expect(
        find.bySemanticsLabel('Hold to close Atlas'),
        findsOneWidget,
        reason: '`Close` sendirian tidak menyebut apa yang berakhir',
      );
      semantics.dispose();
    });
  });

  group('mengurangi gerak', () {
    testWidgets('terkunci tanpa animasi ketika gerak dimatikan', (tester) async {
      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: MediaQuery(
          // Apa yang dihormati lembar terminal juga, jadi satu app tidak punya dua
          // pendapat tentang preferensi yang sama.
          data: const MediaQueryData(disableAnimations: true),
          child: Scaffold(
            body: ListView(children: [
              SwipeToClose(
                agent: 'Atlas',
                isOpen: false,
                onOpenChanged: (_) {},
                onClose: () async => true,
                child: const SizedBox(height: 72, child: Text('Atlas row')),
              ),
            ]),
          ),
        ),
      ));

      final restingAt = tester.getTopLeft(find.text('Atlas row')).dx;
      await tester.timedDrag(
        find.text('Atlas row'),
        const Offset(-(SwipeToClose.snapAt + kTouchSlop + 8), 0),
        const Duration(milliseconds: 400),
      );
      // Satu frame saja. Dengan animasi, barisnya masih di tengah jalan di sini.
      await tester.pump();

      expect(
        tester.getTopLeft(find.text('Atlas row')).dx,
        restingAt - SwipeToClose.actionWidth,
        reason: 'gerak dimatikan berarti sampai, bukan bergerak lebih cepat',
      );
    });
  });

  group('haptik', () {
    /// Mencatat denyut yang benar-benar diminta ke platform. Denyut di ambang adalah
    /// **informasi** — ia memberi tahu jempol bahwa melepas sekarang akan mengunci — jadi
    /// berapa kali ia terjadi adalah bagian dari perilakunya, bukan detail.
    List<String> listenForHaptics(WidgetTester tester) {
      final felt = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'HapticFeedback.vibrate') felt.add('${call.arguments}');
          return null;
        },
      );
      addTearDown(() => tester.binding.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null));
      return felt;
    }

    testWidgets('sekali saat melewati ambang, bukan tiap frame', (tester) async {
      final felt = listenForHaptics(tester);
      await tester.pumpWidget(host(isOpen: false));

      // Ditarik jauh melewati ambang, jadi banyak frame berada di atasnya.
      await tester.timedDrag(
        find.text('Atlas row'),
        const Offset(-(SwipeToClose.actionWidth + kTouchSlop), 0),
        const Duration(milliseconds: 500),
      );
      await tester.pumpAndSettle();

      expect(
        felt.where((f) => f.contains('selectionClick')).length,
        1,
        reason: 'berdenyut ulang di atas ambang mengubah informasi menjadi kebisingan',
      );
    });

    testWidgets('lebih tegas saat agennya benar-benar berakhir', (tester) async {
      final felt = listenForHaptics(tester);
      await tester.pumpWidget(host(isOpen: true));
      await tester.pumpAndSettle();
      felt.clear();

      final press = await tester.startGesture(tester.getCenter(find.text('Atlas')));
      await tester.pump(const Duration(milliseconds: 120));
      await tester.pumpAndSettle();
      await press.up();
      await tester.pumpAndSettle();

      expect(felt.where((f) => f.contains('mediumImpact')).length, 1);
    });
  });

  group('hasilnya menentukan apa yang terlihat', () {
    Widget hostWith({required Future<bool> Function() onClose,
                     ValueChanged<bool>? onOpenChanged}) =>
        MaterialApp(
          theme: buildAppTheme(),
          home: Scaffold(
            // `Column`, bukan `ListView`: sebuah baris setinggi nol di dalam viewport bisa
            // tidak di-layout sama sekali, dan finder-nya jadi kosong karena harness-nya —
            // bukan karena barisnya salah. Koeksistensi dengan gulir punya test sendiri.
            body: Column(children: [
              SwipeToClose(
                agent: 'Atlas',
                isOpen: true,
                onOpenChanged: onOpenChanged ?? (_) {},
                onClose: onClose,
                child: const SizedBox(height: 72, child: Text('Atlas row')),
              ),
            ]),
          ),
        );

    Future<void> holdToCommit(WidgetTester tester) async {
      final press = await tester.startGesture(tester.getCenter(find.text('Atlas')));
      await tester.pump(const Duration(milliseconds: 120));
      await tester.pumpAndSettle();
      await press.up();
      await tester.pumpAndSettle();
    }

    testWidgets('berhasil: barisnya pergi', (tester) async {
      await tester.pumpWidget(hostWith(onClose: () async => true));
      await tester.pumpAndSettle();
      expect(tester.getSize(find.byType(SwipeToClose)).height, 72);

      await holdToCommit(tester);

      // Runtuh, dan tetap runtuh sampai snapshot fleet membuang cell-nya. Tanpa ini ada
      // beberapa detik di mana tindakan yang tak bisa dibatalkan tampak seperti tak terjadi.
      expect(tester.getSize(find.byType(SwipeToClose)).height, 0);
    });

    testWidgets('gagal: barisnya bertahan dan jalurnya menutup', (tester) async {
      final asked = <bool>[];
      await tester.pumpWidget(hostWith(
        onClose: () async => false,
        onOpenChanged: asked.add,
      ));
      await tester.pumpAndSettle();

      await holdToCommit(tester);

      // Ini alasan hasilnya harus dilaporkan sama sekali: host bisa menolak dan gerbang bisa
      // dibatalkan. Meruntuhkan baris lebih dulu lalu memantulkannya kembali akan menjadi
      // kebohongan yang lebih buruk daripada tidak beranimasi.
      expect(tester.getSize(find.byType(SwipeToClose)).height, 72);
      expect(asked, [false], reason: 'jalurnya menutup, bukan menunggu dengan sapuan penuh');
    });
  });

  group('gradasi perbatasan', () {
    Size fadeSize(WidgetTester tester) =>
        tester.getSize(find.byKey(SwipeToClose.trailingFade));

    testWidgets('pada keadaan diam lelehnya nol', (tester) async {
      await tester.pumpWidget(host(isOpen: false));
      await tester.pumpAndSettle();

      // Kalau lelehnya dipasang sebagai nilai tetap, `WAITING` dan `RUNNING` akan tersamar
      // permanen di tepi kanan setiap baris — memperbaiki satu keadaan dengan merusak
      // keadaan yang jauh lebih sering dilihat.
      expect(fadeSize(tester).width, 0);
    });

    testWidgets('tumbuh bersama geseran', (tester) async {
      await tester.pumpWidget(host(isOpen: true));
      await tester.pumpAndSettle();

      expect(fadeSize(tester).width, SwipeToClose.fadeWidth);
    });
  });
}
