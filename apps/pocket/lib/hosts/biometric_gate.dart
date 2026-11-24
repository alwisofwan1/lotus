import '../core/biometrics.dart';
import '../core/clock.dart';

/// Whether a gated action may proceed, and on what grounds.
///
/// Three values rather than a `bool` because "the operator proved it" and "there was
/// nobody to ask" are different facts about the same allowed action, and the second is
/// worth surfacing — in the UI, and in the audit attribution ADR-8 puts on the cell
/// timeline.
enum GateVerdict {
  granted,

  /// The device cannot demand proof at all, so the action proceeds ungated — the one
  /// exception ADR-12 no. 4 names.
  grantedWithoutLock,

  refused;

  bool get allowed => this != refused;
}

/// The gate in front of every mutation (ADR-8), fail-closed (ADR-12 no. 4).
///
/// Reads operate freely; only mutations come through here. That asymmetry is the whole
/// point: a prompt on every read would train the operator to tap through prompts, which
/// is how a gate stops being one.
///
/// **Proof lasts a few minutes, rather than exactly one action.** That is a relaxation,
/// and it is made on the ADR's own terms rather than against them:
///
/// - ADR-8 states plainly that the host *never verifies* this proof — "ia hanya melihat
///   bearer, tidak lebih". So this gate is a **local** control, and the thing it defends
///   against is precisely one: somebody acting through Pocket on a phone that is in
///   their hand and unlocked. What actually carries the credential's security is the
///   TTL the host enforces and the tailnet the host sits behind, which the ADR says in
///   those words.
/// - Against that one threat, a window bounds the exposure to its length instead of
///   removing it — the phone is either in the wrong hands or it is not, and a thief who
///   can produce one prompt can produce ten.
/// - What it buys back is the gate's meaning. Answering an agent is a conversation:
///   a permission prompt, a follow-up, a correction, all within a minute. Demanding
///   proof for each one trains exactly the tap-through this class's own comment names
///   as the way a gate stops being one.
///
/// The same instinct is already in `AgentRepository._mutate`, one call wide: when a
/// credential refresh has just prompted, the dispatch behind it does not prompt again,
/// "because prompting twice in one tap would train them to tap through". This is that
/// rule given a clock.
///
/// **One gate for every host, deliberately.** The threat is the phone being in the wrong
/// hands, which is not a per-host fact — and a window that reset per host would prompt
/// again on a swipe between two agents that happen to live on different machines, which
/// is the friction this exists to remove.
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

  /// How long a proof stands.
  ///
  /// Long enough to cover a back-and-forth with an agent — answer a permission prompt,
  /// read what it did, send a correction — and short enough that it is measured in the
  /// minutes a phone spends out of your hand, not the hours. It is also not the only
  /// bound: [forget] drops it the moment the app leaves the foreground, which is the
  /// event that actually matters. The clock is the backstop for a phone left unlocked
  /// on a desk with Pocket still open.
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

  /// Drops any standing proof, so the next mutation asks again.
  ///
  /// Called when the app leaves the foreground (`app/pocket_app.dart`). That is the
  /// event the window is really bounded by: a phone handed over, pocketed, or taken is
  /// a phone whose Pocket is no longer in front of its operator. The clock is the
  /// weaker of the two bounds and exists for the case where the app stays open.
  void forget() => _provenAt = null;
}
