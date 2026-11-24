import 'widgets/spawn_controls.dart';
import '../../models/runner_family.dart';

/// Nama manusiawi tiap runner yang Lotus kenal.
///
/// Di sisi app, bukan dari host, dan itu bukan kelalaian: `HostRunner.name` untuk runner
/// asli sama dengan id-nya (`claude`), karena yang host tahu adalah perintah apa yang bisa
/// ia jalankan — bukan bagaimana produk itu disebut oleh pembuatnya. Tabel ini yang tahu.
///
/// Sejak 2026-08-27 tabelnya hidup di [RunnerFamily.displayName] — satu daftar "yang Lotus
/// kenali secara khusus" untuk nama, gate, dan warna, bukan lima salinan yang saling beda.

/// Baris kedua sebuah runner di sheet pemilih: siapa ia, dan apakah ia akan bertanya.
///
/// **Klausa gerbangnya selalu ada, dan itu menyimpang dari mockup dengan sengaja.**
/// `design/revamp-modern.html` M4 hanya mencetaknya untuk `claude` dan `codex`, lalu
/// membiarkan `cursor`, `gemini`, `grok`, dan `kimi` tanpa keterangan apa pun. Aturan yang
/// sudah dipakai daftar agen mengatakan sebaliknya: sebuah runner yang tidak pernah bertanya
/// **menjelaskan diamnya sendiri** (`cell_row.dart`, dan ada tesnya). Dan sheet ini memilih
/// runner **sebelum** ia lahir — jadi kalimat itu di sini lebih berguna daripada di mana pun,
/// karena ia satu-satunya kesempatan operator mengetahuinya sebelum agennya bertindak.
///
/// **Satu hal dari mockup yang tidak dibawa:** `no mark shipped` pada baris `acme`. Itu
/// keterangan tentang pipeline aset Lotus, bukan tentang agen operator — dan tile di sebelah
/// kirinya sudah menunjukkan bentuk fallback-nya tanpa perlu dijelaskan.
String runnerDescription(SpawnRunner runner) {
  final who = runner.isCustom ? 'Your own runner' : RunnerFamily.of(runner.id).displayName;
  // Sebuah runner asing sudah disebut namanya dalam serif di atas baris ini; mencetaknya
  // lagi di bawah tidak menambah satu fakta pun.
  final gate = runner.gates ? 'asks first' : 'never asks';

  return who == null ? gate : '$who · $gate';
}
