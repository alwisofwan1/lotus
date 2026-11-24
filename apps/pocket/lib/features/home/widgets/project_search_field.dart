import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';
import '../../shared/field_glyphs.dart';

/// Dock di dasar indeks: satu field untuk mencari project.
///
/// **Di bawah, bukan di pojok atas.** Ini layar yang dipegang satu tangan sambil berjalan,
/// dan pojok kiri atas adalah bagian layar yang paling jauh dari jempol. Mockup M1 menaruhnya
/// di zona jempol dengan tinggi 50 dan radius 16, dan angka itu yang dipakai di sini.
///
/// **Tidak ada tombol `+` di sebelahnya**, meski mockup menggambarnya. Memulai agen butuh
/// sebuah project, sementara indeks justru satu-satunya layar yang tidak punya satu project —
/// jadi `+` harus menanyakannya lewat sheet, dan `+` lalu memilih project berbiaya ketukan
/// yang sama dengan membuka project lalu menekan `New agent`. Ia menambah satu permukaan
/// tanpa menghemat apa pun, beberapa jam sesudah sheet pengalih dipensiunkan karena alasan
/// yang persis sama. (Keputusan operator, 2026-08-11.)
class ProjectSearchField extends StatefulWidget {
  const ProjectSearchField({
    required this.query,
    required this.onChanged,
    super.key,
  });

  final String query;
  final ValueChanged<String> onChanged;

  @override
  State<ProjectSearchField> createState() => _ProjectSearchFieldState();
}

class _ProjectSearchFieldState extends State<ProjectSearchField> {
  late final TextEditingController _text = TextEditingController(
    text: widget.query,
  );

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Padding(
      padding: const EdgeInsets.fromLTRB(14, 12, 14, 20),
      child: Container(
        height: 50,
        padding: const EdgeInsets.symmetric(horizontal: 14),
        decoration: BoxDecoration(
          color: t.raise,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Row(
          children: [
            SearchGlyph(color: t.faint),
            const SizedBox(width: 10),
            Expanded(child: _field(t)),
            // Hanya saat ada yang bisa dibatalkan. Sebuah silang di field kosong adalah
            // kontrol yang tidak melakukan apa pun, dan aturan itu sudah ditulis di
            // ADR-14 untuk tombol spawn.
            if (widget.query.isNotEmpty) _clear(t),
          ],
        ),
      ),
    );
  }

  Widget _field(AppTokens t) => TextField(
    controller: _text,
    onChanged: widget.onChanged,
    textInputAction: TextInputAction.search,
    style: t.ui.copyWith(fontSize: 14, color: t.text),
    cursorColor: t.waiting,
    cursorWidth: 1.5,
    decoration: InputDecoration(
      isDense: true,
      border: InputBorder.none,
      hintText: 'Search projects',
      hintStyle: t.ui.copyWith(fontSize: 14, color: t.muted),
    ),
  );

  Widget _clear(AppTokens t) => Semantics(
    button: true,
    label: 'Clear search',
    child: InkWell(
      onTap: () {
        _text.clear();
        widget.onChanged('');
      },
      customBorder: const CircleBorder(),
      splashColor: t.line,
      highlightColor: t.line,
      // Kotak sentuhnya penuh setinggi field: 34 di dalam field 50 dengan padding di
      // kedua sisinya, jadi jempol tidak perlu mencari lingkaran 11px.
      child: SizedBox(
        width: 34,
        height: 34,
        child: Center(child: CrossGlyph(color: t.muted)),
      ),
    ),
  );
}
