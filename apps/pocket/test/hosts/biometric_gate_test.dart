import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/hosts/biometric_gate.dart';

import '../support/fake_security.dart';

/// ADR-12 no. 4, as a test: fail-closed, with exactly one named exception.
void main() {
  test('proof given opens the gate', () async {
    final biometrics = FakeBiometrics();
    final gate = BiometricGate(biometrics);

    final verdict = await gate.authorize('Dispatch to Chase');

    expect(verdict, GateVerdict.granted);
    expect(verdict.allowed, isTrue);
    expect(biometrics.reasons.single, 'Dispatch to Chase');
  });

  test('proof refused closes it — a cancel is not a yes', () async {
    final gate = BiometricGate(FakeBiometrics(answer: false));

    final verdict = await gate.authorize('Dispatch to Chase');

    expect(verdict, GateVerdict.refused);
    expect(verdict.allowed, isFalse);
  });

  test('a device with no lock at all still acts, and says which case it was', () async {
    final biometrics = FakeBiometrics(hasLock: false);
    final gate = BiometricGate(biometrics);

    final verdict = await gate.authorize('Dispatch to Chase');

    // The exception ADR-12 no. 4 names out loud: locking an operator out of their own
    // machine is the failure this product exists to prevent. Kept as its own verdict
    // rather than folded into `granted`, because "nobody was asked" is worth showing.
    expect(verdict, GateVerdict.grantedWithoutLock);
    expect(verdict.allowed, isTrue);
    expect(biometrics.prompts, 0, reason: 'nothing to prompt with');
  });

  test('a device with no lock is never asked, so an answer cannot leak in', () async {
    // `answer: false` would refuse if it were consulted. It must not be.
    final gate = BiometricGate(FakeBiometrics(hasLock: false, answer: false));

    expect(await gate.authorize('Stop Chase'), GateVerdict.grantedWithoutLock);
  });

  test('a plugin that cannot answer closes the gate, it does not open it', () async {
    final gate = BiometricGate(FakeBiometrics(failCanPrompt: Exception('no platform channel')));

    // The dangerous mistake this pins down: "cannot tell whether this device has a
    // lock" is not "this device has no lock". Reading it as the latter would hand out
    // the ADR-12 no. 4 exception on every plugin error.
    expect(await gate.authorize('Dispatch to Chase'), GateVerdict.refused);
  });

  test('a lockout mid-prompt is refused rather than thrown at the screen', () async {
    final biometrics = FakeBiometrics();
    final gate = BiometricGate(biometrics);
    biometrics.failPrompt = Exception('too many attempts');

    expect(await gate.authorize('Dispatch to Chase'), GateVerdict.refused);
  });

  group('proof stands for a few minutes', () {
    /// The friction this removes, measured in use on 2026-08-07: answering an agent is a
    /// conversation — a permission prompt, a follow-up, a correction — and every one of
    /// them asked for a fingerprint.
    ///
    /// It is a relaxation made on ADR-8's own terms. The ADR states the host never
    /// verifies this proof ("ia hanya melihat bearer, tidak lebih"), so the gate defends
    /// against exactly one thing: someone acting through Pocket on a phone in their hand
    /// and unlocked. A window bounds that instead of removing it — and a thief who can
    /// produce one prompt can produce ten.
    test('a second mutation inside the window does not ask again', () async {
      var clock = DateTime.utc(2026, 8, 7, 12);
      final biometrics = FakeBiometrics();
      final gate = BiometricGate(biometrics, now: () => clock);

      expect(await gate.authorize('Dispatch to Chase'), GateVerdict.granted);
      clock = clock.add(const Duration(minutes: 2));
      expect(await gate.authorize('Dispatch to Chase'), GateVerdict.granted);

      expect(biometrics.prompts, 1, reason: 'one gesture, not two');
    });

    test('past the window it asks again', () async {
      var clock = DateTime.utc(2026, 8, 7, 12);
      final biometrics = FakeBiometrics();
      final gate = BiometricGate(biometrics, now: () => clock);

      await gate.authorize('Dispatch to Chase');
      clock = clock.add(BiometricGate.defaultGraceWindow + const Duration(seconds: 1));
      await gate.authorize('Dispatch to Chase');

      expect(biometrics.prompts, 2);
    });

    /// The event the window is really bounded by. A phone handed over, pocketed or taken
    /// is a phone whose Pocket is no longer in front of its operator, and the clock is
    /// only the backstop for one left open on a desk.
    test('leaving the foreground drops it immediately', () async {
      var clock = DateTime.utc(2026, 8, 7, 12);
      final biometrics = FakeBiometrics();
      final gate = BiometricGate(biometrics, now: () => clock);

      await gate.authorize('Dispatch to Chase');
      gate.forget();
      clock = clock.add(const Duration(seconds: 1));
      await gate.authorize('Dispatch to Chase');

      expect(biometrics.prompts, 2);
    });

    /// Inside the window nothing is asked, so a refusal cannot even be offered — which
    /// is the point, not a gap. Once the window is past, the gate is an ordinary gate
    /// again and a "no" is a no.
    test('once the window is past, a refusal is a refusal', () async {
      var clock = DateTime.utc(2026, 8, 7, 12);
      final biometrics = FakeBiometrics();
      final gate = BiometricGate(biometrics, now: () => clock);

      await gate.authorize('Dispatch to Chase');
      clock = clock.add(BiometricGate.defaultGraceWindow + const Duration(seconds: 1));
      biometrics.answer = false;

      expect(await gate.authorize('Delete something'), GateVerdict.refused);
      expect(gate.proofStands, isFalse, reason: 'a stale grant must not revive');
    });

    /// Fail-closed all the way through: a lockout after the window must not be softened
    /// by the grant that came before it.
    test('a plugin failure past the window still refuses', () async {
      var clock = DateTime.utc(2026, 8, 7, 12);
      final biometrics = FakeBiometrics();
      final gate = BiometricGate(biometrics, now: () => clock);

      await gate.authorize('Dispatch to Chase');
      clock = clock.add(BiometricGate.defaultGraceWindow + const Duration(seconds: 1));
      biometrics.failPrompt = Exception('too many attempts');

      expect(await gate.authorize('Dispatch to Chase'), GateVerdict.refused);
      expect(gate.proofStands, isFalse);
    });

    /// A device with no lock never had a window to begin with — it is ungated by
    /// ADR-12 no. 4, not granted by a proof it cannot give.
    test('a lockless device is not silently given a window', () async {
      final gate = BiometricGate(FakeBiometrics(hasLock: false));

      expect(await gate.authorize('Dispatch to Chase'), GateVerdict.grantedWithoutLock);
      expect(gate.proofStands, isFalse);
    });
  });
}
