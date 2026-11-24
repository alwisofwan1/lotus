import 'package:flutter/material.dart';

/// Dua bentuk yang dipakai sebuah field: mencari, dan membatalkan.
///
/// Terpisah dari `glyphs.dart` bukan karena kategori, melainkan karena berkas itu sudah
/// menyentuh batas 300 baris repo ini — dan sebuah berkas yang duduk tepat di batas membuat
/// tambahan berikutnya, sekecil apa pun, menjadi pekerjaan pemecahan berkas.
/// Kaca pembesar: sebuah lingkaran dan satu pegangan.
///
/// **Digambar, dan itu keputusan yang punya bukti.** `terminal_bar.dart` dan `find_bar.dart`
/// memakai `⌕` untuk arti yang sama, dan Unicode menamai codepoint itu
/// `U+2315 TELEPHONE RECORDER` — ia bukan kaca pembesar, ia hanya kebetulan berbentuk mirip
/// pada beberapa font. Satu-satunya kaca pembesar sungguhan di Unicode adalah `U+1F50D`, yang
/// dirender berwarna sebagai emoji. App ini juga tidak membundel font apa pun, jadi setiap
/// glyph non-ASCII bergantung pada rantai font perangkat.
///
/// Jadi bentuk ini mengikuti aturan yang sudah ditulis di kepala berkas ini: yang app ini
/// maksud, app ini gambar. Dua permukaan yang masih memakai `⌕` bisa mengadopsinya nanti.
class SearchGlyph extends StatelessWidget {
  const SearchGlyph({
    required this.color,
    this.size = 15,
    this.stroke = 1.5,
    super.key,
  });

  final Color color;
  final double size;
  final double stroke;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: size,
    height: size,
    child: CustomPaint(
      painter: _SearchPainter(color: color, stroke: stroke),
    ),
  );
}

class _SearchPainter extends CustomPainter {
  const _SearchPainter({required this.color, required this.stroke});

  final Color color;
  final double stroke;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round;

    // Lensanya duduk di kiri-atas dan pegangannya keluar ke kanan-bawah, sehingga pusat
    // optisnya jatuh di tengah kotak meski bentuknya tidak simetris.
    final r = size.width * 0.30;
    final c = Offset(size.width * 0.42, size.height * 0.42);
    canvas.drawCircle(c, r, paint);

    // Pegangan mulai di tepi lingkaran, bukan di pusatnya: sebuah garis yang menembus
    // lensa membuat bentuk ini terbaca sebagai simbol "dilarang", bukan kaca pembesar.
    final edge = Offset(c.dx + r * 0.71, c.dy + r * 0.71);
    canvas.drawLine(edge, Offset(size.width * 0.92, size.height * 0.92), paint);
  }

  @override
  bool shouldRepaint(_SearchPainter old) =>
      old.color != color || old.stroke != stroke;
}

/// Silang untuk membatalkan — dua goresan, bukan `✕`.
///
/// Alasannya sama dengan [SearchGlyph]: `U+2715` tidak dibundel bersama font apa pun di app
/// ini, jadi ia bergantung pada rantai font perangkat. Dua garis tidak bergantung pada apa
/// pun.
class CrossGlyph extends StatelessWidget {
  const CrossGlyph({
    required this.color,
    this.size = 11,
    this.stroke = 1.5,
    super.key,
  });

  final Color color;
  final double size;
  final double stroke;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: size,
    height: size,
    child: CustomPaint(
      painter: _CrossPainter(color: color, stroke: stroke),
    ),
  );
}

class _CrossPainter extends CustomPainter {
  const _CrossPainter({required this.color, required this.stroke});

  final Color color;
  final double stroke;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round;

    final a = size.width * 0.2;
    final b = size.width * 0.8;
    canvas
      ..drawLine(Offset(a, a), Offset(b, b), paint)
      ..drawLine(Offset(b, a), Offset(a, b), paint);
  }

  @override
  bool shouldRepaint(_CrossPainter old) =>
      old.color != color || old.stroke != stroke;
}

/// Papan ketik: sebuah bingkai dengan tiga tuts dan satu spasi.
///
/// **Diukur, bukan diduga.** Tombol ini memakai `⌨` (U+2328), dan codepoint itu terdaftar
/// `Emoji=Yes` di data Unicode — Android melayaninya dari font emoji. Tangkapan layar bar
/// terminal di HP operator (2026-09-17) mengukurnya: tetangganya — `Aa`, `{}`, `⤢`, dan
/// [SearchGlyph] — semuanya `#A5A29E` dengan chroma 7–11, yaitu `dim` seperti yang diminta
/// kode; `⌨` keluar sebagai `#858E93` / `#AAAAAB` / `#285661`, chroma **57**. Ia membuang
/// warna yang diberikan, persis seperti `✳` di `agent_header.dart`.
///
/// Yang membuatnya lebih dari sekadar salah warna: [BarButton] menandai keadaan *on* dengan
/// membalik labelnya menjadi `bg` di atas isian `text`. Sebuah emoji tidak bisa membalik, jadi
/// papan ketik biru-muda itu akan duduk di atas latar yang nyaris putih.
///
/// **Sebuah `glyph` tidak ikut dibalik oleh [BarButton] — pemanggilnya yang memilih warna.**
class KeyboardGlyph extends StatelessWidget {
  const KeyboardGlyph({
    required this.color,
    this.size = 15,
    this.stroke = 1.3,
    this.crossed = false,
    super.key,
  });

  final Color color;
  final double size;
  final double stroke;

  /// `⌨̸` — lower the keyboard. The mini bar's one verb (v4 tiket 04).
  final bool crossed;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: size,
    height: size,
    child: CustomPaint(
      painter: _KeyboardPainter(color: color, stroke: stroke, crossed: crossed),
    ),
  );
}

class _KeyboardPainter extends CustomPainter {
  const _KeyboardPainter({required this.color, required this.stroke, required this.crossed});

  final Color color;
  final double stroke;
  final bool crossed;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;

    // Bingkainya lebih lebar daripada tinggi, seperti papan ketik sungguhan; pada 15px itu
    // menyisakan dua baris di dalamnya, yang cukup untuk dibaca sebagai tuts.
    canvas.drawRRect(
      RRect.fromRectAndRadius(
        Rect.fromLTRB(w * 0.06, h * 0.28, w * 0.94, h * 0.72),
        Radius.circular(w * 0.10),
      ),
      paint,
    );

    // Tuts sebagai titik: sebuah garis sepanjang nol dengan ujung bulat adalah lingkaran
    // selebar strokenya, yang pada ukuran ini lebih bersih daripada persegi kecil.
    for (final x in [0.28, 0.5, 0.72]) {
      canvas.drawLine(Offset(w * x, h * 0.44), Offset(w * x, h * 0.44), paint);
    }
    // Spasinya satu-satunya tuts yang bukan titik — itulah yang membuat siluetnya terbaca.
    canvas.drawLine(Offset(w * 0.34, h * 0.60), Offset(w * 0.66, h * 0.60), paint);
    if (crossed) canvas.drawLine(Offset(w * 0.14, h * 0.86), Offset(w * 0.86, h * 0.14), paint);
  }

  @override
  bool shouldRepaint(_KeyboardPainter old) =>
      old.color != color || old.stroke != stroke || old.crossed != crossed;
}

/// Two stacked cards — the dock's Sessions (v4 tiket 08). Painted for the reason
/// [KeyboardGlyph] is: a `⧉` falls to the emoji font and throws away the colour it is given.
class SessionsGlyph extends StatelessWidget {
  const SessionsGlyph({required this.color, this.size = 17, super.key});

  final Color color;
  final double size;

  @override
  Widget build(BuildContext context) => SizedBox(
    width: size,
    height: size,
    child: CustomPaint(painter: _SessionsPainter(color)),
  );
}

class _SessionsPainter extends CustomPainter {
  const _SessionsPainter(this.color);

  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.3
      ..strokeJoin = StrokeJoin.round;
    final r = Radius.circular(w * 0.10);
    canvas.drawRRect(RRect.fromRectAndRadius(Rect.fromLTRB(w * 0.10, h * 0.36, w * 0.74, h * 0.88), r), paint);
    // The card behind shows only its top and right edge, so the two read as a stack.
    canvas.drawPath(
      Path()
        ..moveTo(w * 0.26, h * 0.22)
        ..lineTo(w * 0.90, h * 0.22)
        ..lineTo(w * 0.90, h * 0.72),
      paint,
    );
  }

  @override
  bool shouldRepaint(_SessionsPainter old) => old.color != color;
}
