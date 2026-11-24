part of 'host_api.dart';

/// `/m/devices/renew*` — back in after the bearer lapsed, on a signature from the
/// hardware-bound key registered at pairing instead of a new pairing code.
///
/// A `part` for the reason [HostApiReads] is one: `host_api.dart` sits at the 300-line
/// mark, and these share `_send` and its status classification. **No bearer** on either
/// call, by construction — the bearer is what lapsed.
extension HostApiRenewal on HostApi {
  /// A nonce for this device to sign, valid for a couple of minutes.
  Future<String> renewalChallenge(String deviceId) async {
    final json = await _send(
      transport,
      'POST',
      _uri(const ['m', 'devices', 'renew', 'challenge']),
      body: {'deviceId': deviceId},
      special: _renewalRefused,
    );
    return json['nonce']! as String;
  }

  /// Trades the signed nonce for a new bearer with a new TTL **and** a new ceiling.
  Future<RenewedToken> renew({
    required String deviceId,
    required String nonce,
    required String signature,
  }) async =>
      RenewedToken.fromJson(await _send(
        transport,
        'POST',
        _uri(const ['m', 'devices', 'renew']),
        body: {'deviceId': deviceId, 'nonce': nonce, 'signature': signature},
        special: _renewalRefused,
      ));
}

ApiFailure? _renewalRefused(HttpReply reply) =>
    reply.status == 401 ? const RenewalRefused() : null;

/// What the phone signs. Must match `renewalPayload` in the host's `refresh-key.ts`
/// byte for byte — `contract/README.md` pins it.
String renewalPayload(String deviceId, String nonce) => 'lotus-renew/v1\n$deviceId\n$nonce';
