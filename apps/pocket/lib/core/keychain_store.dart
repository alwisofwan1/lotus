import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'secure_store.dart';

/// The real store, behind the seam: Keychain on iOS, Keystore on Android.
///
/// Named in `PLAN.md` §ADR-5 as `flutter_secure_storage`, so this file is a decision
/// already made being carried out rather than a choice being made here.
///
/// Platform options are left at their defaults on purpose. Version 10 dropped the old
/// `encryptedSharedPreferences` flag because the modern crypto path is no longer
/// optional, and `AndroidOptions.biometric(…)` is deliberately *not* used: it would
/// gate each read behind its own prompt, on top of the gate ADR-8 already puts in
/// front of every mutation, and it would block the hydration that happens before any
/// screen exists to explain the prompt.
class KeychainStore implements SecureStore {
  const KeychainStore({this.storage = const FlutterSecureStorage()});

  /// Injected collaborator, kept visible (ADR-13 no. 4).
  final FlutterSecureStorage storage;

  @override
  Future<Map<String, String>> readAll() => storage.readAll();

  @override
  Future<void> write(String key, String value) => storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => storage.delete(key: key);
}
