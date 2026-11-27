import '../core/biometrics.dart';
import '../core/clock.dart';

/// Distinguishes verified presence from an allowed action with no available prompt (ADR-8).
enum GateVerdict {
  granted,

  /// The device cannot demand proof at all, so the action proceeds ungated — the one
  /// exception ADR-12 no. 4 names.
  grantedWithoutLock,

  refused;

  bool get allowed => this != refused;
}

/// Mutations fail closed; proof is local, time-limited, and shared across hosts (ADR-8, ADR-12 no. 4).
/// The host verifies the bearer credential, not biometric proof.
class BiometricGate {
  BiometricGate(
    this.biometrics, {
    this.now = systemClock,
    this.graceWindow = defaultGraceWindow,
  });

  /// Injected collaborator, visible at the call site (ADR-13 no. 4).
  final Biometrics biometrics;

  /// Injected so the window is tested by moving time rather than by waiting it out —
  /// the same seam `Credentials` takes for the TTL.
  final Clock now;

  /// The time limit bounds exposure while [forget] clears proof on backgrounding.
  static const Duration defaultGraceWindow = Duration(minutes: 3);

  final Duration graceWindow;

  DateTime? _provenAt;

  /// Whether a fresh mutation would proceed without asking. Exposed for diagnostics and
  /// for tests; nothing renders it, because a UI that advertised "no prompt needed right
  /// now" would be telling whoever is holding the phone.
  bool get proofStands {
    final at = _provenAt;
    return at != null && now().difference(at) < graceWindow;
  }

  /// Asks for proof of presence. [reason] is shown by the OS, so it names the specific
  /// action rather than the app — "Dispatch to Chase", not "Authenticate".
  Future<GateVerdict> authorize(String reason) async {
    if (proofStands) return GateVerdict.granted;

    try {
      if (!await biometrics.canPrompt) return GateVerdict.grantedWithoutLock;
      // No `_provenAt = null` on the refusing branches, and that is deliberate rather
      // than an omission: every path that reaches a prompt has already failed
      // [proofStands], so there is no live grant left to clear. Writing one anyway would
      // be code that cannot matter, which this repo treats as noise.
      if (!await biometrics.prompt(reason)) return GateVerdict.refused;
      _provenAt = now();
      return GateVerdict.granted;
    } on Object {
      // The single fail-closed point, and the reason the platform impl catches nothing.
      // A cancel, a lockout after too many attempts, and a plugin that cannot answer at
      // all are the same fact — presence was not established — and the dangerous
      // mistake would be reading the last one as `grantedWithoutLock`, which *opens*
      // the gate. Not knowing whether a device has a lock is not knowing it has none.
      return GateVerdict.refused;
    }
  }

  /// Clear proof when the app leaves the foreground (`app/pocket_app.dart`).
  void forget() => _provenAt = null;
}
