import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../shared/glyphs.dart';
import '../../shared/runner_mark.dart';
import '../../shared/tactile.dart';
import '../../shared/tilde_path.dart';
import '../runner_description.dart';
import '../spawn_choice.dart';
import 'sheet_steps.dart';
import 'spawn_controls.dart';
import 'summon_step.dart';

/// Memilih runner yang akan lahir — `design/revamp-modern.html` M4.
///
/// **Menggantikan deret pil horizontal di atas field, dan gambarnya sendiri yang menjelaskan
/// kenapa:** sebuah pil hanya memuat satu kata, jadi ia menawarkan pilihan tanpa pernah
/// mengatakan *apa* yang dipilih. `codex` dan `claude` terlihat setara di deret pil, padahal
/// yang satu bertanya sebelum bertindak dan yang lain tidak. Baris di sheet ini punya ruang
/// untuk mengatakannya ([runnerDescription]), dan itu satu-satunya fakta keselamatan di layar
/// ini.
///
/// Daftar tempat, sama seperti indeks project: mark, nama serif, keterangan mono, chevron.
/// Satu idiom untuk dipelajari, bukan tiga.
///
/// **Dua langkah sejak `spawn-tuning`, tapi hanya bila ada yang bisa disetel.** Runner
/// yang host-nya mengirim `models`/`efforts` membuka [SummonStep] di dalam sheet yang
/// sama; runner tanpa keduanya — host lama, runner asing, runner buatan operator — tetap
/// terpilih dalam satu ketukan, persis seperti sebelumnya. Jadi tidak ada layar yang
/// ditawarkan pada mesin yang tidak bisa menepatinya (ADR-14). [current] mengisi langkah
/// kedua dengan pilihan terakhir untuk runner yang sama, supaya membuka ulang sheet
/// tidak menghapus apa yang barusan diputuskan.
Future<SpawnChoice?> showRunnerSheet(
  BuildContext context, {
  required List<SpawnRunner> runners,
  required String projectPath,
  SpawnChoice? current,
}) =>
    showModalBottomSheet<SpawnChoice>(
      context: context,
      backgroundColor: Colors.transparent,
      // Daftar milik mesin, bukan milik kita: sebuah host dengan delapan runner harus bisa
      // menggulir alih-alih diperas jadi tidak terbaca.
      isScrollControlled: true,
      builder: (context) =>
          _RunnerSheet(runners: runners, projectPath: projectPath, current: current),
    );

class _RunnerSheet extends StatefulWidget {
  const _RunnerSheet({required this.runners, required this.projectPath, this.current});

  final List<SpawnRunner> runners;
  final String projectPath;
  final SpawnChoice? current;

  @override
  State<_RunnerSheet> createState() => _RunnerSheetState();
}

class _RunnerSheetState extends State<_RunnerSheet> {
  /// The runner being tuned, or null while the list is showing.
  SpawnRunner? _tuning;

  List<SpawnRunner> get runners => widget.runners;
  String get projectPath => widget.projectPath;

  void _pick(BuildContext context, SpawnRunner runner) {
    Tactile.chose();
    if (!runner.tunable) {
      Navigator.of(context).pop(SpawnChoice.resting(runner));
      return;
    }
    setState(() => _tuning = runner);
  }

  /// The resting point for the second step: the last choice when it was for this same
  /// runner, otherwise this runner's defaults.
  /// Pilihan lama dipakai **hanya untuk apa yang dipilih**, bukan untuk daftarnya: yang
  /// menggambar picker adalah [runner] dari `widget.runners` — deskripsi terbaru mesin ini
  /// — lewat [SpawnChoice.rebound]. Sebelumnya `current` dikembalikan apa adanya, dan
  /// karena ia membawa `SpawnRunner`-nya sendiri, langkah kedua menggambar katalog dari
  /// saat pilihan itu dibuat: model yang baru muncul di mesin tidak pernah terlihat selama
  /// id runner-nya tidak berubah.
  SpawnChoice _initialFor(SpawnRunner runner) {
    final current = widget.current;
    return current != null && current.runner.id == runner.id
        ? current.rebound(runner)
        : SpawnChoice.resting(runner);
  }

  /// `START AN AGENT IN ~/CODE/CNVS`, atau tanpa tempatnya ketika host tidak mengirimnya.
  ///
  /// Dinyatakan, tidak ditawarkan: memilih path di HP adalah cara tercepat mengirim agen ke
  /// repo yang salah. Dan sebuah host yang lebih tua tidak mengirim `projects[]`, jadi
  /// ujung yang menggantung — `START AN AGENT IN ` — harus mustahil, bukan tidak mungkin.
  String get _header => projectPath.isEmpty
      ? 'START AN AGENT'
      : 'START AN AGENT IN ${tildePath(projectPath).toUpperCase()}';

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Container(
      decoration: BoxDecoration(
        color: t.bg,
        border: Border(top: BorderSide(color: t.lineStrong)),
        borderRadius: const BorderRadius.vertical(top: Radius.circular(22)),
      ),
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * 0.82,
      ),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _grip(t),
            // One sheet, two steps: the second arrives from the right and the list leaves
            // to the left, so the operator reads it as *deeper*, not as a new place — and
            // the sheet's own height travels with them ([SheetSteps]). Honours the OS
            // reduce-motion setting by collapsing to a cut.
            Flexible(
              child: SheetSteps(
                depth: _tuning == null ? 0 : 1,
                child: switch (_tuning) {
                  final runner? => SummonStep(
                      // Keyed by runner, so going back and picking another runner starts
                      // that runner's step fresh instead of reusing the previous one's state.
                      key: ValueKey(runner.id),
                      initial: _initialFor(runner),
                      onBack: () => setState(() => _tuning = null),
                      onStart: (choice) => Navigator.of(context).pop(choice),
                    ),
                  null => _list(t),
                },
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _list(AppTokens t) => Column(
        key: const ValueKey('list'),
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 13),
                child: Text(
                  _header,
                  style: t.mono.copyWith(
                    fontSize: 10.5,
                    letterSpacing: 0.14 * 10.5,
                    color: t.muted,
                  ),
                ),
              ),
              Flexible(
                child: ListView.builder(
                  padding: EdgeInsets.zero,
                  shrinkWrap: true,
                  itemCount: runners.length,
                  itemBuilder: (context, i) => _row(context, t, runners[i]),
                ),
              ),
        ],
      );

  /// Pegangan geser. Bukan kontrol — sheet ini ditutup dengan menggeser di mana saja atau
  /// menekan di luarnya — melainkan tanda bahwa lapisan ini bisa dilempar pergi.
  Widget _grip(AppTokens t) => Center(
        child: Container(
          width: 34,
          height: 4,
          margin: const EdgeInsets.only(top: 10, bottom: 12),
          decoration: BoxDecoration(
            color: t.lineStrong,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      );

  Widget _row(BuildContext context, AppTokens t, SpawnRunner runner) => InkWell(
        onTap: () => _pick(context, runner),
        child: Container(
          decoration: BoxDecoration(
            border: Border(top: BorderSide(color: t.line)),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 13),
          child: Row(
            children: [
              _tile(t, runner),
              const SizedBox(width: 14),
              Expanded(child: _words(t, runner)),
              const SizedBox(width: 12),
              // The chevron says *this opens something*, and only a tunable runner does.
              if (runner.tunable)
                Chevron(color: t.faint, direction: ChevronDirection.right, size: 12),
            ],
          ),
        ),
      );

  /// Mark-nya, dalam warna mereknya, di kolom 40px yang sama dengan baris Home — jadi
  /// sebuah runner terlihat sama di daftar agen dan di sheet yang melahirkannya.
  ///
  /// **Membalik keputusan `dim` di sini (2026-08-27).** Alasannya dulu: tujuh warna merek
  /// dalam satu daftar adalah papan iklan. Yang berubah: Home kini mewarnai mark setiap
  /// baris, dan sheet ini adalah tempat operator memilih runner yang akan tampil di sana
  /// — dua warna berbeda untuk satu runner di dua layar berturut-turut lebih membingungkan
  /// daripada tujuh warna berjajar. Tile `raise` di belakangnya ikut hilang, seperti di Home.
  Widget _tile(AppTokens t, SpawnRunner runner) => SizedBox(
        width: 40,
        height: 40,
        child: Center(
          child: RunnerMarkGlyph(
            // Id-nya, bukan labelnya: mark dan warna dicocokkan dengan apa yang host
            // jalankan, dan runner buatan operator jatuh ke bentuk fallback tanpa warna.
            agentType: runner.isCustom ? runner.label : runner.id,
            color: brandColorFor(runner.id, Theme.of(context).brightness) ?? t.dim,
            size: 28,
          ),
        ),
      );

  Widget _words(AppTokens t, SpawnRunner runner) => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            runner.label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: t.serif.copyWith(
              fontSize: 19,
              fontWeight: FontWeight.w600,
              letterSpacing: -0.3,
              color: t.text,
            ),
          ),
          const SizedBox(height: 3),
          Text(
            runnerDescription(runner),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: t.mono.copyWith(fontSize: 11.5, color: t.muted),
          ),
        ],
      );
}
