import '../core/secure_store.dart';

/// One bit: has this phone ever been walked through the intro.
///
/// **Why this is a stored bit and not "are there credentials".** `PocketApp` already
/// asks `credentials.devices.isEmpty` to choose between onboarding and the project
/// index, and the intro could have ridden along on it for free. It must not: an
/// operator who unpairs their only machine to re-pair it against a new address would
/// be walked through three explanatory panes again, in the middle of a repair, which
/// is the moment they least want to be taught what amber means.
///
/// So the two questions stay separate — *do I have a machine* is credentials, *have I
/// been here before* is this. The intro is shown when both say no.
///
/// Deliberately **not** versioned. Re-showing it after an update is tempting and
/// wrong: the panes explain what Pocket is, not what changed, and a changelog that
/// interrupts launch is a worse changelog than none. The only way back to the intro
/// is genuinely losing every pairing — which is exactly when it is useful again.
///
/// It rides in the same [SecureStore] as everything else this app remembers rather
/// than pulling in a preferences package for one boolean. Storage is not what the
/// Keystore is *for*, but it is already there, already loaded at boot, and this
/// costs one key.
class IntroSeen {
  IntroSeen(this.store);

  /// Injected, kept visible (ADR-13 no. 4).
  final SecureStore store;

  /// Namespaced like every other key this app owns, so `Credentials.load` — which
  /// reads *everything* and reports what it cannot parse — skips it by prefix rather
  /// than reporting it as a rotted credential.
  static const String key = 'intro:seen';

  static const String _value = '1';

  bool _seen = false;

  bool get isSeen => _seen;

  /// Reads the bit back. Called once at boot, beside the other loads.
  Future<void> load() async {
    final all = await store.readAll();
    // Compared against the exact value written rather than tested for presence: a
    // half-written or hand-edited entry should read as "not seen", which is the
    // harmless direction.
    _seen = all[key] == _value;
  }

  /// The operator finished the intro, or skipped it. Both are answers, and they are
  /// the same answer: do not show this again.
  Future<void> markSeen() async {
    if (_seen) return;
    _seen = true;
    await store.write(key, _value);
  }
}
