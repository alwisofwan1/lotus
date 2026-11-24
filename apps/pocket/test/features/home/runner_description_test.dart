import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/home/runner_description.dart';
import 'package:lotus_pocket/features/home/widgets/spawn_controls.dart';

/// Baris kedua di sheet pemilih runner — `design/revamp-modern.html` M4.
///
/// Fungsi murni karena ia menjawab dua hal yang tidak boleh diputuskan oleh widget: apa
/// nama manusiawi sebuah runner, dan apakah runner itu akan bertanya sebelum bertindak.
/// Yang kedua adalah fakta keselamatan, bukan hiasan.
void main() {
  test('runner yang dikenal disebut dengan nama manusiawinya', () {
    expect(
      runnerDescription(const SpawnRunner('claude', label: 'claude', gates: true)),
      'Claude Code · asks first',
    );
    expect(
      runnerDescription(const SpawnRunner('codex', label: 'codex', gates: false)),
      'Codex · never asks',
    );
    expect(
      runnerDescription(const SpawnRunner('gemini', label: 'gemini', gates: false)),
      'Gemini CLI · never asks',
    );
  });

  test('runner buatan operator disebut sebagai miliknya', () {
    // `custom-` adalah bentuk yang dipakai host untuk runner yang ia sendiri tidak
    // definisikan — nama dan perintahnya karangan operator.
    expect(
      runnerDescription(
        const SpawnRunner('custom-acme', label: 'acme', gates: false),
      ),
      'Your own runner · never asks',
    );
  });

  test('runner yang tidak dikenal tidak mengulang namanya sendiri', () {
    // Barisnya sudah menyebut `aider` dalam serif di atasnya; mencetaknya lagi di bawah
    // tidak menambah satu fakta pun. Yang tetap dicetak adalah klausa gerbangnya.
    expect(
      runnerDescription(const SpawnRunner('aider', label: 'aider', gates: false)),
      'never asks',
    );
  });

  test('klausa gerbang selalu ada, karena ia fakta keselamatan', () {
    // Aturan yang sudah dipakai daftar agen: sebuah runner yang tidak pernah bertanya
    // **menjelaskan diamnya sendiri** (`cell_row.dart`, dan tesnya). Sheet ini memilih
    // runner **sebelum** ia lahir, jadi di sini kalimat itu bahkan lebih berguna.
    for (final r in [
      const SpawnRunner('cursor', label: 'cursor', gates: false),
      const SpawnRunner('grok', label: 'grok', gates: false),
      const SpawnRunner('kimi', label: 'kimi', gates: false),
    ]) {
      expect(runnerDescription(r), endsWith('never asks'), reason: r.id);
    }
  });
}
