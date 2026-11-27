/// The seam isolates platform code; registration tokens route notifications but do not authorize access (ADR-13 no. 4).
abstract interface class PushTokens {
  /// Whether this build and this device can receive wake-ups at all.
  ///
  /// False on a device with no Google Play Services, and false in any build without
  /// the messaging plugin compiled in. Distinct from a host's `canPush`: this is the
  /// phone's half of the same question, and both must be true.
  Future<bool> get available;

  /// Request permission with the token so delivery is not registered without display permission.
  Future<String?> requestToken();

  /// Tokens FCM issues later — it rotates them, and a stale one silently stops
  /// delivering. Every rotation must be re-registered with every host.
  Stream<String> get refreshed;
}

/// Report unavailable when messaging is not compiled in.
class UnavailablePushTokens implements PushTokens {
  const UnavailablePushTokens();

  @override
  Future<bool> get available async => false;

  @override
  Future<String?> requestToken() async => null;

  @override
  Stream<String> get refreshed => const Stream<String>.empty();
}
