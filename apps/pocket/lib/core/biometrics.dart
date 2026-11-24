/// The biometric seam (ADR-13 no. 4) — the gate every mutation passes (ADR-8).
///
/// Two questions, and they are genuinely different. [canPrompt] asks whether this
/// device can prove the operator is present *at all*; [prompt] asks it to. ADR-12
/// no. 4 turns on exactly that split: a device with no lock whatsoever still gets to
/// dispatch, because locking an operator out of their own machine is the failure
/// Pocket exists to prevent.
abstract interface class Biometrics {
  /// Whether the device can demand proof of presence — a fingerprint, a face, or the
  /// device passcode.
  ///
  /// Passcode counts on purpose. ADR-12 no. 4's exception is for a device with
  /// **no** lock, not for one whose owner has not enrolled a fingerprint: a PIN still
  /// proves possession plus knowledge, and treating "not enrolled" as "no lock" would
  /// hand the exception to the one case an attacker can arrange.
  Future<bool> get canPrompt;

  /// Asks for proof. True only on a positive one — a cancel, a lockout, or an error
  /// are all false, because this gate fails closed.
  Future<bool> prompt(String reason);
}
