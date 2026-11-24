import 'package:lotus_pocket/core/refresh_keys.dart';

/// A Keystore the test scripts: what `create` hands back, and how `sign` answers.
class FakeRefreshKeys implements RefreshKeys {
  FakeRefreshKeys({this.publicKey = 'MFkw-public-key', this.answer});

  /// What `create` returns — null is a phone that cannot hold a key.
  String? publicKey;

  /// How `sign` answers. Null signs `sig(<payload>)`, so a test can read what was signed.
  KeySignature? answer;

  final List<String> created = [];
  final List<String> deleted = [];
  final List<(String alias, String payload, String reason)> signed = [];

  /// Aliases created and not deleted.
  Set<String> get live => {...created}..removeAll(deleted);

  @override
  Future<String?> create(String alias) async {
    if (publicKey == null) return null;
    created.add(alias);
    return publicKey;
  }

  @override
  Future<KeySignature> sign(String alias, String payload, {required String reason}) async {
    signed.add((alias, payload, reason));
    return answer ?? Signed('sig($payload)');
  }

  @override
  Future<void> delete(String alias) async => deleted.add(alias);
}
