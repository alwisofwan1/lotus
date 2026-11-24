/// The secure-storage seam (ADR-13 no. 4) — Keychain on iOS, Keystore on Android.
///
/// Three methods, deliberately. Device tokens are the only thing Pocket persists
/// (ADR-12 no. 3 keeps the fleet in memory), so a wider surface would be shape we
/// have not needed yet.
///
/// [readAll] rather than a per-key `read` because hydration asks a different question
/// than lookup does: "which hosts am I paired with?" is answered by what is *there*,
/// and a separate index of host ids would be a second thing that can drift from the
/// first — including going orphan when one of two writes fails.
abstract interface class SecureStore {
  Future<Map<String, String>> readAll();

  Future<void> write(String key, String value);

  Future<void> delete(String key);
}
