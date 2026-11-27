/// Enumerate stored credentials directly to avoid a separate index drifting (ADR-12 no. 3, ADR-13 no. 4).
abstract interface class SecureStore {
  Future<Map<String, String>> readAll();

  Future<void> write(String key, String value);

  Future<void> delete(String key);
}
