/// The device's push registration token, behind a seam (ADR-13 no. 4).
///
/// Same shape as `Biometrics` and `SecureStore`: an interface here, the plugin-backed
/// implementation in one file that nothing else imports, so every layer above is
/// testable without a platform channel — and, in this case, without a Firebase project.
///
/// **A registration token is not a secret in the way a bearer is.** It names where to
/// deliver, so a leaked one lets someone with the *service account key* ring this
/// phone; it authorises nothing by itself and identifies no account. That is why it is
/// stored in the clear on the host while the bearer is stored hashed.
abstract interface class PushTokens {
  /// Whether this build and this device can receive wake-ups at all.
  ///
  /// False on a device with no Google Play Services, and false in any build without
  /// the messaging plugin compiled in. Distinct from a host's `canPush`: this is the
  /// phone's half of the same question, and both must be true.
  Future<bool> get available;

  /// Asks the operator for notification permission and returns the token, or null
  /// when either the permission or the platform says no.
  ///
  /// Permission and token in one call on purpose: Android 13+ requires the runtime
  /// grant before a notification can be shown, so a token obtained without it would
  /// deliver wake-ups the operator never sees.
  Future<String?> requestToken();

  /// Tokens FCM issues later — it rotates them, and a stale one silently stops
  /// delivering. Every rotation must be re-registered with every host.
  Stream<String> get refreshed;
}

/// The build without messaging compiled in: honest about being unable to help.
///
/// Not a stub that pretends — `available` is false, so `PushRepository` never
/// registers anything and the app keeps working exactly as it does today, on the
/// live socket alone. This is what lets the whole push path land, and be tested,
/// before a Firebase project exists.
class UnavailablePushTokens implements PushTokens {
  const UnavailablePushTokens();

  @override
  Future<bool> get available async => false;

  @override
  Future<String?> requestToken() async => null;

  @override
  Stream<String> get refreshed => const Stream<String>.empty();
}
