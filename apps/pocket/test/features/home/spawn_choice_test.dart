import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/home/spawn_choice.dart';
import 'package:lotus_pocket/features/home/widgets/spawn_controls.dart';
import 'package:lotus_pocket/models/bootstrap.dart';

/// `SpawnChoice.rebound` — apa yang terjadi pada satu pilihan ketika mesinnya berubah
/// pikiran tentang runner yang sama.
///
/// Ini bukan detail: sebuah pilihan hidup lebih lama dari snapshot tempat ia dibuat, dan
/// karena ia membawa `SpawnRunner`-nya utuh, katalog yang sudah bergerak di mesin sampai
/// ke store lalu **berhenti di sana** — chip masih mencetak model lama dan sheet masih
/// menggambar picker lama. Aturannya di sini: id yang dicocokkan, deskripsi yang dipakai.
void main() {
  const before = SpawnRunner(
    'claude',
    label: 'claude',
    gates: true,
    models: [
      RunnerModel(id: 'opus', label: 'opus'),
      RunnerModel(id: 'sonnet', label: 'sonnet', isDefault: true),
    ],
    efforts: ['low', 'high'],
    permissions: [
      RunnerPermission(id: 'plan', label: 'plan'),
      RunnerPermission(id: 'manual', label: 'manual', isDefault: true),
      RunnerPermission(id: 'bypassPermissions', label: 'bypass'),
    ],
  );

  /// Mesin yang sama, sesudah operator menambahkan sesuatu: `haiku` masuk, `opus` pergi.
  const after = SpawnRunner(
    'claude',
    label: 'claude',
    gates: true,
    models: [
      RunnerModel(id: 'sonnet', label: 'sonnet', isDefault: true),
      RunnerModel(id: 'haiku', label: 'haiku'),
    ],
    efforts: ['low', 'high', 'max'],
    permissions: [
      RunnerPermission(id: 'plan', label: 'plan'),
      RunnerPermission(id: 'manual', label: 'manual', isDefault: true),
      RunnerPermission(id: 'bypassPermissions', label: 'bypass'),
    ],
  );

  test('picker yang dibaca adalah katalog terbaru, bukan yang ikut di dalam pilihan', () {
    final choice = const SpawnChoice(runner: before, model: 'sonnet').rebound(after);

    expect(choice.runner.models.map((m) => m.id), ['sonnet', 'haiku']);
    expect(choice.runner.efforts, ['low', 'high', 'max']);
  });

  test('tuning yang masih ditawarkan tetap dipegang', () {
    final choice =
        const SpawnChoice(runner: before, model: 'sonnet', effort: 'high').rebound(after);

    expect(choice.model, 'sonnet');
    expect(choice.effort, 'high');
  });

  test('model yang tidak lagi ditawarkan jatuh ke tempat istirahat, bukan ikut terbawa', () {
    // Kalau `opus` ikut terbawa, CLI-lah yang menolaknya — jauh dari operator yang
    // memilihnya. Kembali ke tempat istirahat adalah satu-satunya jawaban yang selalu lahir.
    final choice = const SpawnChoice(runner: before, model: 'opus').rebound(after);

    // Bukan lagi `null`: sejak 2026-08-27 model selalu disebut, karena default mesin yang
    // sebenarnya berlapis dan sebuah picker yang diam akan berbohong tentangnya.
    expect(choice.model, 'sonnet');
    expect(choice.summary, 'claude', reason: 'yang beristirahat tetap bukan berita');
  });

  test('akun yang tidak lagi ada di mesin jatuh ke pilihan mesin sendiri (issues/07)', () {
    const twoAccounts = SpawnRunner('claude', label: 'claude', gates: true, profiles: [
      RunnerProfile(id: 'default', label: 'default'),
      RunnerProfile(id: 'hss', label: 'hss'),
    ]);
    const choice = SpawnChoice(runner: twoAccounts, profile: 'hss');
    expect(choice.summary, 'claude · hss');
    expect(choice.rebound(twoAccounts).profile, 'hss');

    const oneLeft = SpawnRunner('claude', label: 'claude', gates: true, profiles: [
      RunnerProfile(id: 'default', label: 'default'),
    ]);
    expect(choice.rebound(oneLeft).profile, isNull);
  });

  test('effort di luar skala baru juga dijatuhkan', () {
    const narrower = SpawnRunner('claude', label: 'claude', gates: true, efforts: ['low']);
    final choice = const SpawnChoice(runner: before, effort: 'high').rebound(narrower);

    expect(choice.effort, isNull);
  });

  test('runner yang skalanya hilang tidak memegang posture apa pun', () {
    // Host yang lebih tua, atau runner yang flag-nya tidak dikenal Lotus: rem tanpa ujung
    // tidak boleh digambar, apalagi dikirim.
    const unscaled = SpawnRunner('claude', label: 'claude', gates: false);
    final choice = SpawnChoice.resting(before).rebound(unscaled);

    expect(choice.posture, isNull, reason: 'tidak mengklaim sikap yang tak bisa dipegang');
  });

  test('posture yang dipilih operator selamat; yang belum dipilih beristirahat', () {
    final free = const SpawnChoice(runner: before, posture: 'bypassPermissions').rebound(after);
    final quiet = const SpawnChoice(runner: before).rebound(after);

    expect(free.posture, 'bypassPermissions');
    expect(quiet.posture, 'manual', reason: 'stop yang ditandai host sebagai tempat istirahat');
  });

  /// Aturan yang sama dengan model: sebuah stop yang tidak lagi diiklankan tidak boleh ikut
  /// menumpang ke *Start*, karena CLI-lah yang akan menolaknya — jauh dari operator yang
  /// memilihnya.
  test('stop di luar skala baru dijatuhkan ke tempat istirahat, bukan dibawa', () {
    const narrower = SpawnRunner(
      'claude',
      label: 'claude',
      gates: true,
      permissions: [RunnerPermission(id: 'manual', label: 'manual', isDefault: true)],
    );
    final choice = const SpawnChoice(runner: before, posture: 'bypassPermissions').rebound(narrower);

    expect(choice.posture, 'manual');
  });

  test('runner lain berarti pilihan lain: semuanya kembali ke istirahat', () {
    const codex = SpawnRunner('codex', label: 'codex', gates: false);
    final choice =
        const SpawnChoice(runner: before, model: 'sonnet', effort: 'high').rebound(codex);

    expect(choice.runner.id, 'codex');
    expect(choice.model, isNull);
    expect(choice.effort, isNull);
  });

  test('deskripsi yang sama persis dikembalikan apa adanya', () {
    const choice = SpawnChoice(runner: before, model: 'opus');

    expect(identical(choice.rebound(before), choice), isTrue);
  });

  group('a cell without a terminal', () {
    const headless = SpawnRunner('codex', label: 'codex', gates: false, headless: true);
    const tty = SpawnRunner('codex', label: 'codex', gates: false);

    /// Flipped 2026-09-08 (PLAN §6.1). It used to rest on a terminal and send nothing, on the
    /// grounds that a terminal is what every host has always given. What that defaulted the
    /// operator into was the *lower-fidelity* half of the two paths — no streaming text, and
    /// a permission card scraped off the screen. A bridge this host advertises is where the
    /// conversation actually is, and the terminal is one tap away on the line under Start.
    test('rests on its bridge when the host has one, and names that on the wire', () {
      final resting = SpawnChoice.resting(headless);
      expect(resting.terminal, isFalse);
      expect(resting.tui, isFalse);
      expect(resting.summary, 'codex · no terminal');
      expect(resting.tuningSummary, 'no terminal');
    });

    test('the operator can still ask for a terminal, and then nothing is sent', () {
      final chosen = SpawnChoice.resting(headless).copyWith(terminal: true);
      expect(chosen.terminal, isTrue);
      expect(chosen.tui, isNull, reason: 'absent means "as the host always did"');
    });

    test('a runner this host cannot run headless still rests on its terminal', () {
      expect(SpawnChoice.resting(tty).terminal, isTrue);
      expect(SpawnChoice.resting(tty).tui, isNull);
    });

    test('a host that stopped offering headless gets a terminal back on rebind', () {
      final chosen = SpawnChoice.resting(headless).copyWith(terminal: false);
      expect(chosen.rebound(headless).terminal, isFalse, reason: 'still offered: kept');
      expect(chosen.rebound(tty).terminal, isTrue, reason: 'no longer offered: not sent');
    });

    test('headless alone makes a runner tunable — the toggle needs a second step to live on', () {
      expect(tty.tunable, isFalse);
      expect(headless.tunable, isTrue);
    });
  });

  /// Di mana knob izin beristirahat — dan kenapa Codex punya dua jawaban.
  ///
  /// Kedua jalur spawn Codex sudah berbeda jauh sebelum skala ini ada: yang punya terminal
  /// dijalankan `--dangerously-bypass-approvals-and-sandbox`, yang terstruktur dimulai
  /// `approvalPolicy: "on-request"`. Mengistirahatkan sesi headless di *tidak pernah bertanya*
  /// akan membuang satu-satunya alasan ia bisa menaruh approval di depan operator.
  group('tempat istirahat knob izin', () {
    const codex = SpawnRunner(
      'codex',
      label: 'codex',
      gates: false,
      headless: true,
      permissions: [
        RunnerPermission(id: 'read-only', label: 'read only'),
        RunnerPermission(id: 'auto', label: 'auto', isDefaultHeadless: true),
        RunnerPermission(id: 'full-access', label: 'full access', isDefault: true),
      ],
    );

    test('Codex beristirahat di tempat berbeda tergantung terminalnya', () {
      expect(codex.restingPermission(headless: false)?.id, 'full-access');
      expect(codex.restingPermission(headless: true)?.id, 'auto');
    });

    test('runner tanpa skala tidak punya tempat istirahat sama sekali', () {
      const bare = SpawnRunner('cursor', label: 'cursor', gates: false);
      expect(bare.restingPermission(headless: false), isNull);
    });

    /// Host yang menandai apa-apa tetap harus memberi knob sebuah posisi. Yang paling tidak
    /// bebas adalah satu-satunya bacaan yang tidak bisa melukai.
    test('skala tanpa tanda default jatuh ke stop paling tidak bebas', () {
      const vague = SpawnRunner(
        'claude',
        label: 'claude',
        gates: true,
        permissions: [
          RunnerPermission(id: 'plan', label: 'plan'),
          RunnerPermission(id: 'bypassPermissions', label: 'bypass'),
        ],
      );
      expect(vague.restingPermission(headless: false)?.id, 'plan');
    });

    /// Sebuah skala membuat runner *bisa disetel*, jadi ia membuka langkah kedua — bahkan
    /// runner yang tidak punya model maupun effort untuk ditawarkan.
    test('skala saja sudah membuat runner membuka langkah SUMMON', () {
      expect(codex.tunable, isTrue);
    });
  });

  /// Chip di atas field adalah tempat terakhir pilihan berbahaya masih bisa tertangkap
  /// sebelum tombol kirim, jadi ia mencetak apa yang digeser dari tempat istirahatnya — dan
  /// diam tentang apa yang tidak.
  group('apa yang dicetak chip', () {
    const claude = SpawnRunner(
      'claude',
      label: 'claude',
      gates: true,
      permissions: [
        RunnerPermission(id: 'manual', label: 'manual', isDefault: true),
        RunnerPermission(id: 'bypassPermissions', label: 'bypass'),
      ],
    );

    test('posture yang beristirahat bukan berita', () {
      expect(SpawnChoice.resting(claude).summary, 'claude');
      expect(SpawnChoice.resting(claude).tuningSummary, isNull);
    });

    test('posture yang digeser ikut tercetak, dengan kata host-nya', () {
      const free = SpawnChoice(runner: claude, posture: 'bypassPermissions');
      expect(free.postureLabel, 'bypass');
      expect(free.summary, 'claude · bypass');
    });
  });

  /// A provider this machine reaches only through a bridge — `cursor` — has no terminal to
  /// offer. Until the host said so it never appeared in the list at all, so Chat could not be
  /// opened on an agent the machine could perfectly well run.
  group('a runner with no terminal', () {
    const bridgeOnly = SpawnRunner('cursor',
        label: 'Cursor Agent', gates: false, headless: true, terminal: false);

    test('rests on Chat rather than on a terminal it cannot have', () {
      expect(SpawnChoice.resting(bridgeOnly).terminal, isFalse);
    });

    test('cannot be switched into a terminal by a stale choice', () {
      final chosen = SpawnChoice.resting(bridgeOnly).copyWith(terminal: true);
      expect(chosen.rebound(bridgeOnly).terminal, isFalse);
    });
  });

  /// Reported from a real device on 2026-09-08, twice: the operator meant to start codex for
  /// Chat and got a terminal cell both times. The terminal was the resting choice and the
  /// alternative was one tap on a line *below* Start. A codex terminal cell has no Chat page
  /// on any host — so resting it there is resting on a dead end.
  group('a runner whose terminal cell has no Chat', () {
    const codex = SpawnRunner('codex',
        label: 'codex', gates: false, headless: true, chatInTerminal: false);
    const noBridge = SpawnRunner('gemini',
        label: 'gemini', gates: false, headless: false, chatInTerminal: false);

    test('rests on its bridge, because that is where its conversation is', () {
      expect(SpawnChoice.resting(codex).terminal, isFalse);
    });

    test('still rests on a terminal when there is no bridge to rest on', () {
      // Nothing is gained by refusing the only path the host has.
      expect(SpawnChoice.resting(noBridge).terminal, isTrue);
    });

    test('the operator can still ask for a terminal', () {
      final chosen = SpawnChoice.resting(codex).copyWith(terminal: true);
      expect(chosen.terminal, isTrue);
      expect(chosen.rebound(codex).terminal, isTrue, reason: 'a made choice is kept');
    });
  });
}
