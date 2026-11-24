import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/features/home/spawn_choice.dart';
import 'package:lotus_pocket/features/home/widgets/runner_sheet.dart';
import 'package:lotus_pocket/features/home/widgets/scale_track.dart';
import 'package:lotus_pocket/features/home/widgets/summon_controls.dart';
import 'package:lotus_pocket/features/home/widgets/summon_step.dart';
import 'package:lotus_pocket/models/bootstrap.dart';
import 'package:lotus_pocket/features/home/widgets/spawn_controls.dart';
import 'package:lotus_pocket/features/shared/glyphs.dart';
import 'package:lotus_pocket/features/shared/runner_mark.dart';

const runners = [
  SpawnRunner('claude', label: 'claude', gates: true),
  SpawnRunner('codex', label: 'codex', gates: false),
  SpawnRunner('custom-acme', label: 'acme', gates: false),
];

/// Sheet pemilih runner — `design/revamp-modern.html` M4.
///
/// Ia menggantikan deret pil horizontal di atas field, dan alasannya ada di gambarnya:
/// sebuah pil hanya bisa memuat satu kata, jadi ia menawarkan pilihan tanpa pernah
/// mengatakan **apa** yang dipilih. Sheet punya ruang untuk baris kedua, dan baris kedua
/// itu yang memuat satu-satunya fakta keselamatan di layar ini: apakah runner-nya akan
/// bertanya sebelum bertindak.
void main() {
  late List<SpawnChoice> chosen;

  setUp(() => chosen = []);

  Future<void> open(
    WidgetTester tester, {
    String path = '/Users/op/code/cnvs',
    List<SpawnRunner> list = runners,
  }) async {
    tester.view.physicalSize = const Size(1080, 2400);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                onPressed: () async {
                  final picked = await showRunnerSheet(
                    context,
                    runners: list,
                    projectPath: path,
                  );
                  if (picked != null) chosen.add(picked);
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    // Sheet-nya berhenti di 82% tinggi layar, jadi apa yang muat adalah pertanyaan tentang
    // telepon sungguhan — bukan tentang 800×600 default `flutter_test`, yang bahkan bukan
    // bentuk telepon. Langkah SUMMON kini bisa digulir; ukuran ini yang membuat tes menguji
    // gulirannya alih-alih menguji sebuah layar yang tidak ada.
  }

  testWidgets('menyebut ke mana agennya akan lahir, dalam bentuk ~', (tester) async {
    await open(tester);

    // Dinyatakan, bukan ditawarkan: memilih path di HP adalah cara tercepat mengirim agen
    // ke repo yang salah, dan itu risiko yang judul project ada untuk menutupnya (R-10).
    expect(find.text('START AN AGENT IN ~/CODE/CNVS'), findsOne);
  });

  testWidgets('setiap runner membawa nama, keterangan, dan mark-nya', (tester) async {
    await open(tester);

    expect(find.text('claude'), findsOne);
    expect(find.text('Claude Code · asks first'), findsOne);
    expect(find.text('codex'), findsOne);
    expect(find.text('Codex · never asks'), findsOne);
    // Runner buatan operator: namanya miliknya, dan mark-nya jatuh ke bentuk fallback
    // tanpa barisnya kehilangan apa pun.
    expect(find.text('acme'), findsOne);
    expect(find.text('Your own runner · never asks'), findsOne);

    expect(find.byType(RunnerMarkGlyph), findsNWidgets(3));
  });

  testWidgets('mark-nya memakai warna merek yang sama dengan baris Home', (tester) async {
    await open(tester);

    // Dibalik 2026-08-27: Home mewarnai mark tiap baris, dan runner yang dipilih di sini
    // harus terlihat sama di sana. Runner buatan operator tidak punya merek — ia `dim`.
    Color colourOf(String label) => tester
        .widget<RunnerMarkGlyph>(find.descendant(
          of: find.ancestor(of: find.text(label), matching: find.byType(InkWell)).first,
          matching: find.byType(RunnerMarkGlyph),
        ))
        .color;
    expect(colourOf('claude'), brandColorFor('claude'));
    expect(colourOf('codex'), brandColorFor('codex'));
    expect(colourOf('acme'), AppTokens.dark.dim);
  });

  testWidgets('menekan satu baris mengembalikan runner itu, lalu menutup sheet',
      (tester) async {
    await open(tester);

    await tester.tap(find.text('codex'));
    await tester.pumpAndSettle();

    expect(chosen.map((c) => c.runner.id), ['codex']);
    // Nothing to tune on it, so the choice is the runner's own defaults — and no posture,
    // because codex has no mechanism to ask.
    expect(chosen.single.model, isNull);
    expect(chosen.single.posture, isNull);
    expect(find.text('START AN AGENT IN ~/CODE/CNVS'), findsNothing);
  });

  testWidgets('ditutup tanpa memilih tidak memilih apa pun', (tester) async {
    await open(tester);

    await tester.tapAt(const Offset(20, 20));
    await tester.pumpAndSettle();

    expect(chosen, isEmpty);
  });

  testWidgets('setiap baris melewati batas target sentuh', (tester) async {
    await open(tester);

    for (final label in ['claude', 'codex', 'acme']) {
      final row = find.ancestor(of: find.text(label), matching: find.byType(InkWell));
      expect(tester.getSize(row.first).height, greaterThanOrEqualTo(kMinHitTarget),
          reason: label);
    }
  });

  testWidgets('tanpa path yang diketahui, headernya tetap kalimat yang benar',
      (tester) async {
    // Sebuah host yang lebih tua tidak mengirim `projects[]`, jadi path-nya kosong. Header
    // yang berbunyi `START AN AGENT IN ` dengan ujung menggantung lebih buruk daripada
    // header yang tidak menyebut tempat.
    await open(tester, path: '');

    expect(find.text('START AN AGENT'), findsOne);
  });

  group('runner yang bisa disetel membuka langkah kedua', () {
    const tunable = [
      SpawnRunner(
        'claude',
        label: 'claude',
        gates: true,
        models: [
          RunnerModel(id: 'opus', label: 'opus'),
          RunnerModel(id: 'sonnet', label: 'sonnet', isDefault: true),
          RunnerModel(id: 'haiku', label: 'haiku'),
        ],
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        permissions: [
          RunnerPermission(id: 'plan', label: 'plan'),
          RunnerPermission(id: 'manual', label: 'manual', isDefault: true),
          RunnerPermission(id: 'acceptEdits', label: 'accept edits'),
          RunnerPermission(id: 'bypassPermissions', label: 'bypass'),
        ],
      ),
      SpawnRunner('codex', label: 'codex', gates: false),
    ];

    testWidgets('hanya runner yang punya sesuatu untuk disetel yang membawa chevron',
        (tester) async {
      await open(tester, list: tunable);

      // Chevron berarti *ini membuka sesuatu*, dan hanya claude yang membuka langkah kedua.
      final claudeRow = find.ancestor(of: find.text('claude'), matching: find.byType(InkWell)).first;
      final codexRow = find.ancestor(of: find.text('codex'), matching: find.byType(InkWell)).first;
      expect(find.descendant(of: claudeRow, matching: find.byType(Chevron)), findsOne);
      expect(find.descendant(of: codexRow, matching: find.byType(Chevron)), findsNothing);
    });

    testWidgets('menekan runner yang bisa disetel tidak menutup sheet — ia membuka SUMMON',
        (tester) async {
      await open(tester, list: tunable);

      await tester.tap(find.text('claude'));
      await tester.pumpAndSettle();

      expect(chosen, isEmpty);
      expect(find.byType(SummonStep), findsOne);
      expect(find.text('START AN AGENT IN ~/CODE/CNVS'), findsNothing);
      // Default host-nya yang terpilih saat dibuka, dan thinking beristirahat di auto.
      expect(find.text('sonnet'), findsOne);
      expect(find.text('auto'), findsOne);
    });

    testWidgets('Start mengembalikan runner beserta model, thinking, dan posture-nya',
        (tester) async {
      await open(tester, list: tunable);
      await tester.tap(find.text('claude'));
      await tester.pumpAndSettle();

      await tester.tap(find.text('opus'));
      await tester.pumpAndSettle();
      // Stop ketiga dari kiri: auto · low · medium → `medium`.
      final slider = find.bySemanticsLabel('Thinking');
      final box = tester.getRect(slider);
      await tester.tapAt(Offset(box.left + box.width * (2.5 / 6), box.center.dy));
      await tester.pumpAndSettle();
      expect(find.text('medium'), findsOne);

      await tester.tap(find.textContaining('Start'));
      await tester.pumpAndSettle();

      final choice = chosen.single;
      expect(choice.runner.id, 'claude');
      expect(choice.model, 'opus');
      expect(choice.effort, 'medium');
      expect(choice.posture, 'manual', reason: 'rests where the host said it rests');
      expect(choice.summary, 'claude · opus · medium');
    });

    /// Dibalik pada 2026-08-27, dan bug-nya diukur di HP: dulu memilih default host mengirim
    /// **tidak ada** model, supaya default mesin yang bergerak tetap dihormati. Tapi default
    /// yang sebenarnya berlapis — `~/.claude/settings.json` di mesin ini berbunyi `opus[1m]`
    /// — jadi sheet menyorot `sonnet`, tidak mengirim apa pun, dan sebuah sel opus lahir.
    /// Picker yang pilihannya tidak berbuat apa-apa adalah kebohongan.
    testWidgets('memilih default host-nya tetap menyebut namanya, bukan diam',
        (tester) async {
      await open(tester, list: tunable);
      await tester.tap(find.text('claude'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('haiku'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('sonnet'));
      await tester.pumpAndSettle();

      await tester.tap(find.textContaining('Start'));
      await tester.pumpAndSettle();

      expect(chosen.single.model, 'sonnet');
      // Chip-nya tetap diam soal itu: yang beristirahat bukan berita, dan aturan itu kini
      // tentang apa yang dicetak — bukan lagi tentang apa yang dikirim.
      expect(chosen.single.summary, 'claude');
    });

    /// Kalimat itu dulu **adalah** kontrolnya — satu `InkWell` di dalam satu baris miring —
    /// dan itulah sebabnya posture berhenti di dua nilai sampai 2026-08-27. Sekarang ia
    /// keterangan sebuah track, dan yang dijaga tes ini adalah keduanya: knob-nya benar-benar
    /// memilih, dan kalimatnya benar-benar mengikuti.
    testWidgets('track posture memilih, dan kalimatnya menyebut akibat stop itu',
        (tester) async {
      await open(tester, list: tunable);
      await tester.tap(find.text('claude'));
      await tester.pumpAndSettle();

      expect(find.text('asks before every action · this phone answers'), findsOne);

      final track = find.byWidgetPredicate(
        (w) => w is ScaleTrack && w.label == 'Permission',
      );
      final box = tester.getRect(track);
      // Ujung kanan track: stop paling bebas, apa pun panjang skalanya.
      await tester.tapAt(Offset(box.right - 6, box.center.dy));
      await tester.pumpAndSettle();

      expect(find.text('never asks · the phone will not hear it'), findsOne);

      await tester.tap(find.textContaining('Start'));
      await tester.pumpAndSettle();
      expect(chosen.single.posture, 'bypassPermissions');
      // Yang tidak beristirahat ikut tercetak, supaya chip di atas field masih bisa
      // menangkapnya sebelum tombol kirim.
      expect(chosen.single.summary, contains('bypass'));
    });

    testWidgets('kembali ke daftar tidak memilih apa pun, dan runner lain mulai bersih',
        (tester) async {
      await open(tester, list: tunable);
      await tester.tap(find.text('claude'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('opus'));
      await tester.pumpAndSettle();

      await tester.tap(find.bySemanticsLabel('Back to runners'));
      await tester.pumpAndSettle();

      expect(chosen, isEmpty);
      expect(find.text('START AN AGENT IN ~/CODE/CNVS'), findsOne);
    });

    testWidgets('dibuka ulang dengan pilihan sebelumnya, langkah kedua mengingatnya',
        (tester) async {
      final before = SpawnChoice(runner: tunable[0], model: 'haiku', effort: 'xhigh');
      // Bentuk telepon, sama seperti `open()`: langkah SUMMON menggulir, dan 800×600 bukan
      // layar yang bisa diuji apa pun tentangnya.
      tester.view.physicalSize = const Size(1080, 2400);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        MaterialApp(
          theme: buildAppTheme(),
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () async {
                  final picked = await showRunnerSheet(
                    context,
                    runners: tunable,
                    projectPath: '',
                    current: before,
                  );
                  if (picked != null) chosen.add(picked);
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('claude'));
      await tester.pumpAndSettle();

      expect(find.text('xhigh'), findsOne, reason: 'the thinking value, as last set');
      await tester.tap(find.textContaining('Start'));
      await tester.pumpAndSettle();
      expect(chosen.single.model, 'haiku');
      expect(chosen.single.effort, 'xhigh');
    });

    testWidgets('katalog yang bergerak di mesin mengganti picker-nya, bukan diingat lama',
        (tester) async {
      // Runner yang sama, sesudah mesinnya berubah pikiran: `opusplan` masuk, `opus`
      // pergi. `before` adalah pilihan yang dipegang composer — ia membawa katalog dari
      // saat ia dibuat, dan itulah yang dulu digambar ulang di sini.
      const moved = [
        SpawnRunner(
          'claude',
          label: 'claude',
          gates: true,
          models: [
            RunnerModel(id: 'sonnet', label: 'sonnet', isDefault: true),
            RunnerModel(id: 'opusplan', label: 'opusplan'),
          ],
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        ),
      ];
      final before = SpawnChoice(runner: tunable[0], model: 'opus', effort: 'xhigh');
      await tester.pumpWidget(
        MaterialApp(
          theme: buildAppTheme(),
          home: Builder(
            builder: (context) => Scaffold(
              body: TextButton(
                onPressed: () async {
                  final picked = await showRunnerSheet(
                    context,
                    runners: moved,
                    projectPath: '',
                    current: before,
                  );
                  if (picked != null) chosen.add(picked);
                },
                child: const Text('open'),
              ),
            ),
          ),
        ),
      );
      await tester.tap(find.text('open'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('claude'));
      await tester.pumpAndSettle();

      expect(find.text('opusplan'), findsOne, reason: 'yang baru ada di mesin terlihat');
      expect(find.text('opus'), findsNothing, reason: 'yang sudah tidak ada tidak ditawarkan');
      expect(find.text('xhigh'), findsOne, reason: 'skalanya tidak berubah, jadi pilihannya bertahan');

      await tester.tap(find.textContaining('Start'));
      await tester.pumpAndSettle();
      // Alias mati tidak ikut terkirim: ia akan ditolak oleh CLI, jauh dari operator. Yang
      // dikirim adalah tempat istirahat katalog **baru**, bukan diam — sebuah spawn tanpa
      // `model` memakai default mesin, dan default itu bukan yang tersorot di sheet.
      expect(chosen.single.model, 'sonnet');
      expect(chosen.single.effort, 'xhigh');
    });
  });

  testWidgets('enam alias model tidak berdesakan: pilnya menggulir dan yang terpilih terlihat',
      (tester) async {
    const codex = SpawnRunner(
      'codex',
      label: 'codex',
      gates: false,
      models: [
        RunnerModel(id: 'gpt-5.6-sol', label: '5.6-sol', isDefault: true),
        RunnerModel(id: 'gpt-5.6-terra', label: '5.6-terra'),
        RunnerModel(id: 'gpt-5.6-luna', label: '5.6-luna'),
        RunnerModel(id: 'gpt-5.5', label: '5.5'),
        RunnerModel(id: 'gpt-5.4', label: '5.4'),
        RunnerModel(id: 'gpt-5.4-mini', label: '5.4-mini'),
      ],
      efforts: ['minimal', 'low', 'medium', 'high', 'xhigh'],
    );
    await open(tester, list: const [codex]);
    await tester.tap(find.text('codex'));
    await tester.pumpAndSettle();

    // Diukur di HP 2026-08-27: enam segmen dalam satu pil membuat `5.6-terra 5.6-luna`
    // saling menimpa. Sekarang tiap segmen punya lebar minimum dan barisnya menggulir.
    expect(tester.takeException(), isNull, reason: 'no RenderFlex overflow');
    // Yang digulir adalah pilnya, bukan sheet-nya: langkah SUMMON sendiri punya
    // `SingleChildScrollView` sejak track permission datang, jadi finder-nya harus menyebut
    // yang mana — kalau tidak, tes ini lulus karena scroll milik orang lain.
    expect(
      find.descendant(
        of: find.byType(ModelSegment),
        matching: find.byType(SingleChildScrollView),
      ),
      findsOne,
    );
    await tester.drag(find.text('5.6-sol'), const Offset(-400, 0));
    await tester.pumpAndSettle();
    await tester.tap(find.text('5.4-mini'));
    await tester.pumpAndSettle();
    await tester.tap(find.textContaining('Start'));
    await tester.pumpAndSettle();
    expect(chosen.single.model, 'gpt-5.4-mini');
  });

  group('a runner the host can run without a terminal', () {
    const headless = [
      SpawnRunner('claude', label: 'claude', gates: true),
      SpawnRunner('codex', label: 'codex', gates: false, headless: true),
    ];

    /// Resting on the bridge since 2026-09-08 (PLAN §6.1): where the host can run an agent
    /// without a terminal, that is where its conversation is — streamed text and an approval
    /// the runner really waits on, rather than a Chat assembled from hooks.
    testWidgets('opens SUMMON with a RUNS IN row, resting on Chat', (tester) async {
      await open(tester, list: headless);
      await tester.tap(find.text('codex'));
      await tester.pumpAndSettle();

      expect(find.byType(SummonStep), findsOne);
      expect(find.text('RUNS IN'), findsOne);
      expect(find.text('Chat'), findsOne);
      expect(find.text('Terminal'), findsOne);
    });

    testWidgets('choosing Terminal gives it a terminal, and Start carries that choice',
        (tester) async {
      await open(tester, list: headless);
      await tester.tap(find.text('codex'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Terminal'));
      await tester.pumpAndSettle();

      await tester.tap(find.textContaining('Start'));
      await tester.pumpAndSettle();
      final choice = chosen.single;
      expect(choice.terminal, isTrue);
      // Absent, not `true`: a terminal is what every host has always given.
      expect(choice.tui, isNull);
      expect(choice.summary, 'codex');
    });

    testWidgets('and Start with the row untouched sends tui: false', (tester) async {
      await open(tester, list: headless);
      await tester.tap(find.text('codex'));
      await tester.pumpAndSettle();
      await tester.tap(find.textContaining('Start'));
      await tester.pumpAndSettle();

      final choice = chosen.single;
      expect(choice.terminal, isFalse);
      expect(choice.tui, isFalse);
      expect(choice.summary, 'codex · no terminal');
    });

    testWidgets('a runner the host cannot run headless never shows the row', (tester) async {
      await open(tester, list: headless);
      await tester.tap(find.text('claude'));
      await tester.pumpAndSettle();
      expect(find.text('RUNS IN'), findsNothing);
    });

    testWidgets('nor does a runner with no terminal at all: there is nothing to choose', (tester) async {
      await open(tester, list: const [
        SpawnRunner('cursor', label: 'cursor', gates: false, headless: true, terminal: false),
      ]);
      await tester.tap(find.text('cursor'));
      await tester.pumpAndSettle();
      expect(find.text('RUNS IN'), findsNothing);
    });
  });
}
