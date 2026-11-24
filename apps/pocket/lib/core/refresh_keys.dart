import 'dart:io';

import 'package:flutter/services.dart';

/// What came of asking the hardware key to sign.
sealed class KeySignature {
  const KeySignature();
}

/// Base64 DER ECDSA/SHA-256 — what `refresh-key.ts` on the host verifies.
class Signed extends KeySignature {
  const Signed(this.signature);
  final String signature;
}

/// The operator cancelled, or the prompt failed. The key is still there; ask again later.
class SignRefused extends KeySignature {
  const SignRefused();
}

/// The key can never sign again — a new fingerprint invalidated it, or it is missing.
/// Only a fresh pairing code gets back in.
class KeyGone extends KeySignature {
  const KeyGone();
}

/// The hardware-bound refresh key (PLAN.md §Kredensial, addendum 2026-08-05) — the seam
/// (ADR-13 no. 4) between the credential policy and Android Keystore.
///
/// The private half never leaves the Keystore, and the Keystore will not sign until the
/// operator proves presence — so a valid signature is a biometric check the **host** can
/// verify, which the bearer alone never was.
abstract interface class RefreshKeys {
  /// Makes a key under [alias] and returns its public half as base64 SPKI — or null on a
  /// phone that cannot hold one (no secure lock, no Keystore, not Android). Null is an
  /// ordinary answer: that phone pairs exactly as it did before keys existed.
  Future<String?> create(String alias);

  /// Signs [payload] after the system biometric prompt titled [reason].
  Future<KeySignature> sign(String alias, String payload, {required String reason});

  /// Forgets the key. Quiet when there is none.
  Future<void> delete(String alias);
}

/// A phone with no key, ever — the default wherever nothing hardware-backed is wired in.
class NoRefreshKeys implements RefreshKeys {
  const NoRefreshKeys();

  @override
  Future<String?> create(String alias) async => null;

  @override
  Future<KeySignature> sign(String alias, String payload, {required String reason}) async =>
      const KeyGone();

  @override
  Future<void> delete(String alias) async {}
}

/// Android Keystore through `RefreshKeyChannel.kt`. Every other platform answers "no key".
class DeviceRefreshKeys implements RefreshKeys {
  const DeviceRefreshKeys();

  static const _channel = MethodChannel('lotus/refresh_key');

  @override
  Future<String?> create(String alias) async {
    if (!Platform.isAndroid) return null;
    try {
      return await _channel.invokeMethod<String>('create', {'alias': alias});
    } on PlatformException {
      return null;
    } on MissingPluginException {
      return null;
    }
  }

  @override
  Future<KeySignature> sign(String alias, String payload, {required String reason}) async {
    if (!Platform.isAndroid) return const KeyGone();
    try {
      final signature = await _channel.invokeMethod<String>(
        'sign',
        {'alias': alias, 'payload': payload, 'title': reason},
      );
      return signature == null ? const SignRefused() : Signed(signature);
    } on PlatformException catch (e) {
      return e.code == 'INVALIDATED' || e.code == 'MISSING' ? const KeyGone() : const SignRefused();
    } on MissingPluginException {
      return const KeyGone();
    }
  }

  @override
  Future<void> delete(String alias) async {
    if (!Platform.isAndroid) return;
    try {
      await _channel.invokeMethod<void>('delete', {'alias': alias});
    } on PlatformException {
      // Nothing to forget, or nothing we can do about it — the host side is what counts.
    } on MissingPluginException {
      // Same.
    }
  }
}
