import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/home/permission_words.dart';
import 'package:lotus_pocket/models/bootstrap.dart';

/// Kalimat di bawah track izin — satu-satunya fakta keselamatan di layar summon.
///
/// Ia dua bagian, dan yang kedua itulah alasan file ini ada: **siapa yang mendengar** ketika
/// agennya bertanya. Kata yang sama (`read only`) berarti dua hal berbeda tergantung apakah
/// selnya lahir dengan terminal, dan operator tidak bisa diharapkan tahu itu.
void main() {
  const plan = RunnerPermission(id: 'plan', label: 'plan');
  const manual = RunnerPermission(id: 'manual', label: 'manual', isDefault: true);
  const bypass = RunnerPermission(id: 'bypassPermissions', label: 'bypass');
  const readOnly = RunnerPermission(id: 'read-only', label: 'read only');
  const fullAccess = RunnerPermission(id: 'full-access', label: 'full access');

  group('siapa yang mendengar', () {
    test('sel keluarga Claude bertanya ke telepon ini', () {
      expect(
        permissionBlurb(manual, gates: true, headless: false),
        'asks before every action · this phone answers',
      );
    });

    /// Codex di terminal tidak punya hook (`agent-gating.ts` menyebutnya `runner_cannot`),
    /// jadi ia menunggu di mesin tanpa pernah menaikkan `needs-input`. Dari HP ia terlihat
    /// *quiet* padahal macet — itu keadaan paling mahal bagi produk ini, jadi ia dinamai.
    test('Codex berterminal bertanya ke mesin, dan itu dikatakan', () {
      expect(
        permissionBlurb(readOnly, gates: false, headless: false),
        'reads only · it asks on the machine, not here',
      );
    });

    /// Dan ini yang berubah pada 2026-08-27: sesi terstruktur dijalankan
    /// `approvalPolicy: "on-request"` (`structured-sessions.ts`) dan approval-nya sampai ke
    /// HP. Kalimat yang sama akan berbohong kalau tidak ikut berubah.
    test('Codex tanpa terminal bertanya ke sini, bukan ke mesin', () {
      expect(
        permissionBlurb(readOnly, gates: false, headless: true),
        'reads only · this phone answers',
      );
    });

    test('stop yang tak pernah bertanya tidak menjanjikan pendengar', () {
      for (final stop in [bypass, fullAccess]) {
        for (final headless in [true, false]) {
          expect(
            permissionBlurb(stop, gates: true, headless: headless),
            endsWith('the phone will not hear it'),
            reason: '${stop.id} headless=$headless',
          );
        }
      }
    });
  });

  test('tiap stop menyebut apa yang boleh dilakukan, bukan cuma siapa yang dengar', () {
    expect(permissionBlurb(plan, gates: true, headless: false), startsWith('reads and plans'));
    expect(
      permissionBlurb(const RunnerPermission(id: 'acceptEdits', label: 'accept edits'),
          gates: true, headless: false),
      startsWith('writes files on its own'),
    );
  });

  /// Host boleh lebih baru dari aplikasi ini. Label-nya milik host jadi knob tetap tergambar;
  /// yang tidak boleh terjadi adalah aplikasi ini mengarang akibat yang tidak diukur siapa pun.
  test('stop yang tak dikenal tidak dikarang kalimatnya', () {
    expect(
      permissionBlurb(const RunnerPermission(id: 'dontAsk', label: 'dont ask'),
          gates: true, headless: false),
      isNull,
    );
  });
}
