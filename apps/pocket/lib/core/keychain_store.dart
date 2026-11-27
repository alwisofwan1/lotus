import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'secure_store.dart';

/// Avoid per-read biometric prompts that would block hydration (ADR-8, PLAN.md §ADR-5).
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
