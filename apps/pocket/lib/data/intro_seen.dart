import '../core/secure_store.dart';

/// Keep intro history separate from credentials so re-pairing does not repeat onboarding.
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
