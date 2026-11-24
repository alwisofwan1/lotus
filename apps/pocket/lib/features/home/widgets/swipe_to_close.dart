import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../app/theme/app_tokens.dart';
import 'close_action.dart';

/// Geser satu baris ke kiri, lalu tahan tombolnya untuk mengakhiri agennya.
///
/// Angkanya ada di `plans/lotus-pocket/design/revamp-modern.html` §4, dan konstanta di bawah
/// adalah satu-satunya salinannya di kode — test membaca yang sama, jadi keduanya tidak bisa
/// menyimpang.
///
/// **Menyingkap, bukan membuang.** Sengaja bukan [Dismissible]: yang dibutuhkan adalah aksi
/// yang bertahan terbuka sampai ditahan, bukan baris yang lenyap saat dilepas. Pengenal
/// horizontal sendiri juga membuat `ListView` tetap menang untuk niat vertikal, jadi
/// menggulir tidak pernah menyenggol aksinya.
///
/// **Hanya ke kiri.** Geser dari tepi kiri adalah gestur *back* milik Android dan iOS; aksi
/// yang muncul dari sana akan berebut dengan keduanya, setiap kali.
class SwipeToClose extends StatefulWidget {
  const SwipeToClose({
    required this.child,
    required this.agent,
    required this.isOpen,
    required this.onOpenChanged,
    required this.onClose,
    super.key,
  });

  final Widget child;

  /// Nama agennya, dicetak di badan tombol. Bukan hiasan: menamai yang akan diakhiri adalah
  /// pengaman yang sama yang dipakai konfirmasi lama, hanya dipindah ke tombolnya.
  final String agent;

  /// Terbuka atau tidak, dimiliki di atas widget ini supaya satu baris terbuka sekali —
  /// aturan yang sama yang sudah dipakai drawer aksi.
  final bool isOpen;
  final ValueChanged<bool> onOpenChanged;

  /// Mengakhiri agennya, dan **melaporkan apakah itu benar-benar terjadi**.
  ///
  /// Bukan `VoidCallback`, dan itu koreksi terhadap mockup-nya: §4 menulis “komit: baris
  /// runtuh”, seolah menahan penuh berarti selesai. Ia tidak — host bisa menolak dan gerbang
  /// biometrik bisa dibatalkan. Meruntuhkan barisnya lebih dulu lalu memantulkannya kembali
  /// adalah kebohongan yang lebih buruk daripada tidak beranimasi, jadi yang menentukan apa
  /// yang terlihat adalah hasilnya.
  final Future<bool> Function() onClose;

  /// Lebar aksi, dan **sekaligus jarak tempuh barisnya**. Sama persis supaya baris berhenti
  /// tepat di tepi kiri aksi: tidak ada satu piksel konten yang tertutup.
  static const double actionWidth = 112;

  /// Setengah tempuh. Di bawah ini, melepas mengembalikan barisnya.
  static const double snapAt = actionWidth / 2;

  /// Sentilan lebih cepat dari ini membuka berapa pun jaraknya. Dua ambang, karena satu saja
  /// membuat salah satu gaya tangan terasa rusak.
  static const double flickVelocity = 400;

  /// Perlawanan di luar rentang. Tanpa ini jari terus bergerak dan baris berhenti, yang
  /// terbaca sebagai macet alih-alih sebagai batas.
  static const double rubber = 0.35;

  static const Duration openIn = Duration(milliseconds: 220);

  /// Lebih cepat dari membuka: pembatalan tidak boleh terasa seperti menunggu.
  static const Duration closeIn = Duration(milliseconds: 180);

  /// Panjang lelehnya di tepi belakang baris, pada geseran penuh.
  ///
  /// **Diikat ke kemajuan, jadi pada keadaan diam ia nol.** Dipasang sebagai nilai tetap, ia
  /// akan menyamarkan `WAITING` dan `RUNNING` di tepi kanan setiap baris selamanya —
  /// memperbaiki satu keadaan dengan merusak keadaan yang jauh lebih sering dilihat.
  static const double fadeWidth = 20;

  /// Pegangan test untuk leleh itu. Ia tidak punya teks dan tidak punya semantik, jadi
  /// satu-satunya cara memeriksa klaim “nol saat diam” adalah menamainya.
  static const Key trailingFade = Key('swipe-to-close.trailing-fade');

  /// Lama barisnya runtuh sesudah host mengonfirmasi. Ia ada karena snapshot fleet baru
  /// membuang cell-nya beberapa detik kemudian, dan detik-detik itu adalah jeda di mana
  /// tindakan yang tak bisa dibatalkan tampak seperti tak terjadi.
  static const Duration leaveIn = Duration(milliseconds: 260);

  @override
  State<SwipeToClose> createState() => _SwipeToCloseState();
}

class _SwipeToCloseState extends State<SwipeToClose>
    with TickerProviderStateMixin {
  late final AnimationController _reveal = AnimationController(
    vsync: this,
    duration: SwipeToClose.openIn,
    reverseDuration: SwipeToClose.closeIn,
    value: widget.isOpen ? 1 : 0,
  );

  late final AnimationController _leave = AnimationController(
    vsync: this,
    duration: SwipeToClose.leaveIn,
  );

  /// Sudah berdenyut untuk tarikan ini. Denyut di ambang adalah informasi — ia memberi tahu
  /// jempol bahwa melepas sekarang akan mengunci — dan berdenyut ulang tiap frame di atas
  /// ambang akan mengubahnya dari informasi menjadi kebisingan.
  bool _buzzed = false;

  @override
  void didUpdateWidget(SwipeToClose old) {
    super.didUpdateWidget(old);
    if (old.isOpen != widget.isOpen) _settle(widget.isOpen);
  }

  @override
  void dispose() {
    _reveal.dispose();
    _leave.dispose();
    super.dispose();
  }

  /// Menahan penuh mengakhiri agennya, lalu **hasilnya** memutuskan apa yang terlihat.
  Future<void> _commit() async {
    final ended = await widget.onClose();
    if (!mounted) return;
    if (ended) {
      if (_stillness) {
        _leave.value = 1;
      } else {
        _leave.forward();
      }
      return;
    }
    // Tidak berakhir: jalurnya menutup alih-alih menunggu dengan sapuan penuh, yang akan
    // mengklaim sesuatu yang tidak terjadi. Sebabnya sudah dikatakan oleh notice di atasnya.
    _settle(false);
    if (widget.isOpen) widget.onOpenChanged(false);
  }

  /// Sampai, bukan bergerak lebih cepat.
  ///
  /// Sebuah gestur adalah gerakan yang diminta operator, tapi *penyelesaiannya* tidak —
  /// jadi ketika preferensinya mematikan gerak, ia mendarat. Aturan yang sama sudah
  /// dihormati lembar terminal, dan satu app tidak boleh punya dua pendapat tentang satu
  /// preferensi.
  bool get _stillness => MediaQuery.disableAnimationsOf(context);

  void _settle(bool open) {
    if (_stillness) {
      _reveal.value = open ? 1 : 0;
      return;
    }
    if (open) {
      _reveal.animateTo(
        1,
        duration: SwipeToClose.openIn,
        curve: Curves.easeOutQuart,
      );
    } else {
      _reveal.animateBack(
        0,
        duration: SwipeToClose.closeIn,
        curve: Curves.easeOutQuint,
      );
    }
  }

  void _onDragStart(DragStartDetails _) => _buzzed = false;

  void _onDragUpdate(DragUpdateDetails d) {
    final travelled =
        _reveal.value * SwipeToClose.actionWidth - d.primaryDelta!;
    // Karet di kedua ujung, jadi kedua batas terbaca sebagai batas.
    final bounded = travelled < 0
        ? travelled * SwipeToClose.rubber
        : travelled > SwipeToClose.actionWidth
        ? SwipeToClose.actionWidth +
              (travelled - SwipeToClose.actionWidth) * SwipeToClose.rubber
        : travelled;
    _reveal.value = (bounded / SwipeToClose.actionWidth).clamp(0.0, 1.0);

    if (!_buzzed && travelled >= SwipeToClose.snapAt) {
      _buzzed = true;
      HapticFeedback.selectionClick();
    }
  }

  void _onDragEnd(DragEndDetails d) {
    final velocity = -d.velocity.pixelsPerSecond.dx;
    final open = velocity > SwipeToClose.flickVelocity
        ? true
        : velocity < -SwipeToClose.flickVelocity
        ? false
        : _reveal.value * SwipeToClose.actionWidth >= SwipeToClose.snapAt;

    // Selalu diselesaikan di sini: kalau keputusannya sama dengan keadaan sekarang, induknya
    // tidak akan membangun ulang dan `didUpdateWidget` tidak akan pernah dipanggil.
    _settle(open);
    if (open != widget.isOpen) widget.onOpenChanged(open);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return SizeTransition(
      sizeFactor: Tween<double>(
        begin: 1,
        end: 0,
      ).animate(CurvedAnimation(parent: _leave, curve: Curves.easeOutQuint)),
      alignment: Alignment.topCenter,
      child: AnimatedBuilder(
        animation: _reveal,
        builder: (context, _) {
          final shown = _reveal.value;

          return Stack(
            children: [
              // Dibangun hanya ketika ada yang tersingkap. Sebuah tombol yang mengakhiri agen
              // tidak boleh bisa ditemukan — termasuk oleh pembaca layar — saat ia tak terlihat.
              if (shown > 0)
                Positioned.fill(
                  child: Align(
                    alignment: Alignment.centerRight,
                    child: CloseAction(
                      agent: widget.agent,
                      progress: shown,
                      onCommit: _commit,
                    ),
                  ),
                ),
              // Pengenal geser membungkus **barisnya**, bukan seluruh tumpukan.
              //
              // Ditemukan oleh test: dengan pengenal di luar, menekan tombolnya juga sampai
              // ke sana, dan melepasnya menjalankan logika akhir-geser sekali lagi — jadi
              // satu tahanan meminta jalurnya ditutup dua kali. Yang digeser memang
              // barisnya; tombolnya hanya ditahan.
              Transform.translate(
                offset: Offset(-shown * SwipeToClose.actionWidth, 0),
                child: GestureDetector(
                  onHorizontalDragStart: _onDragStart,
                  onHorizontalDragUpdate: _onDragUpdate,
                  onHorizontalDragEnd: _onDragEnd,
                  // Lantai app, bukan transparan: barisnya harus benar-benar menutupi
                  // aksinya saat diam, bukan cuma tampak menutupinya.
                  child: Stack(
                    children: [
                      ColoredBox(color: t.bg, child: widget.child),
                      // Tepi belakangnya meleleh alih-alih dipotong tegak.
                      //
                      // Dilukis, **bukan** `ShaderMask`: mask menyusun ulang seluruh
                      // baris ke layer terpisah setiap frame selama gestur, dan gestur
                      // adalah momen yang paling tidak boleh kehilangan frame. Satu
                      // strip gradien memberi piksel yang sama tanpa layer baru.
                      Positioned(
                        top: 0,
                        bottom: 0,
                        right: 0,
                        child: IgnorePointer(
                          child: Container(
                            key: SwipeToClose.trailingFade,
                            width: shown * SwipeToClose.fadeWidth,
                            decoration: BoxDecoration(
                              gradient: LinearGradient(
                                begin: Alignment.centerLeft,
                                end: Alignment.centerRight,
                                colors: [t.bg.withValues(alpha: 0), t.bg],
                              ),
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}
