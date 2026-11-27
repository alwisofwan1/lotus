/// Separate capability from proof so devices with no lock remain usable (ADR-8, ADR-12 no. 4, ADR-13 no. 4).
abstract interface class Biometrics {
  /// A passcode counts as a lock; lack of biometric enrollment must not bypass proof (ADR-12 no. 4).
  Future<bool> get canPrompt;

  /// Asks for proof. True only on a positive one — a cancel, a lockout, or an error
  /// are all false, because this gate fails closed.
  Future<bool> prompt(String reason);
}
