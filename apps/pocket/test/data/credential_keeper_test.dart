import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/core/transport.dart';
import 'package:lotus_pocket/data/credential_keeper.dart';
import 'package:lotus_pocket/hosts/biometric_gate.dart';
import 'package:lotus_pocket/hosts/credentials.dart';
import 'package:lotus_pocket/hosts/host_registry.dart';
import 'package:lotus_pocket/hosts/paired_host.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/pairing.dart';

import 'package:lotus_pocket/core/refresh_keys.dart';

import '../support/fake_refresh_keys.dart';
import '../support/fake_security.dart';
import '../support/fake_transport.dart';

/// What the host enforces (`DEVICE_TOKEN_TTL_MS`), and what the client renews against
/// (`Credentials.refreshLead`). Both are moved by the clock, never waited out.
const Duration hostTtl = Duration(hours: 72);
const Duration lead = Credentials.refreshLead; // 24 hours

const HostId mac = HostId('mac');
const HostId vps = HostId('vps');

DateTime now = DateTime.utc(2026, 9, 17, 12);

PairedDevice device({
  HostId host = mac,
  Duration remaining = hostTtl,
  Duration ceiling = const Duration(days: 30),
  String? keyAlias,
}) =>
    PairedDevice(
      deviceToken: 'tok-${host.value}',
      deviceId: 'dev_${host.value}',
      expiresAt: now.add(remaining),
      hardExpiresAt: now.add(ceiling),
      hostId: host,
      hostLabel: host.value,
      mode: 'standalone',
      caps: const HostCaps(protocol: 1, features: ['fleet', 'dispatch']),
      baseUri: Uri.parse('http://${host.value}:9877'),
      refreshKeyAlias: keyAlias,
    );

String refreshReply({Duration ttl = hostTtl, String token = 'tok-new'}) => jsonEncode({
      'deviceToken': token,
      'expiresAt': now.add(ttl).millisecondsSinceEpoch,
    });

void main() {
  late InMemorySecureStore store;
  late FakeBiometrics biometrics;
  late FakeHttpTransport http;
  late Credentials credentials;
  late HostRegistry registry;
  late CredentialKeeper keeper;

  setUp(() {
    now = DateTime.utc(2026, 9, 17, 12);
    store = InMemorySecureStore();
    biometrics = FakeBiometrics();
    http = FakeHttpTransport();
    credentials = Credentials(
      store: store,
      now: () => now,
      gate: BiometricGate(biometrics, now: () => now),
    );
    registry = HostRegistry(
      transport: FakeTransport(),
      httpTransport: http,
      tokenReader: credentials.tokenFor,
      sleep: (_) async {},
    );
    keeper = CredentialKeeper(registry: registry, credentials: credentials);
  });

  Future<void> pair(PairedDevice d) async {
    await credentials.remember(d);
    registry.add(PairedHost.of(d));
  }

  /// The one this class exists for.
  ///
  /// The 2026-08-05 addendum says opening Pocket once inside the lead keeps a token
  /// alive. Before this class nothing did that — `refreshIfDue` only ran on a mutation,
  /// so an operator who read the fleet for three days and dispatched on the fourth met a
  /// re-pair. This test fails against that code.
  test('opening the app renews a credential that is inside its lead', () async {
    await pair(device(remaining: lead - const Duration(hours: 1)));
    http.enqueue(refreshReply());

    expect(await keeper.refreshDueHosts(), [mac]);
    expect(credentials.deviceFor(mac)?.deviceToken, 'tok-new');
    expect(http.last.method, 'POST');
    expect(http.last.uri.path, endsWith('/m/devices/refresh'));
  });

  /// And it does not ask for a fingerprint the operator did not need to give.
  test('a credential with plenty of time left is not touched, and prompts nobody',
      () async {
    await pair(device(remaining: hostTtl));

    expect(await keeper.refreshDueHosts(), isEmpty);
    expect(http.sent, isEmpty, reason: 'no request for a token that is nowhere near due');
    expect(biometrics.prompts, 0, reason: 'an app open must not demand proof by itself');
  });

  /// Past the ceiling only a new pairing code gets back in. Asking costs the operator a
  /// wait on a cellular link to be told what the client already knows.
  test('a credential past the 30-day ceiling is not even asked about', () async {
    await pair(device(
      remaining: const Duration(hours: 1),
      ceiling: const Duration(hours: -1),
    ));

    expect(await keeper.refreshDueHosts(), isEmpty);
    expect(http.sent, isEmpty);
  });

  /// Found by the first live run, in the host's audit log: a credential 33 hours past its
  /// TTL still produced a prompt and a request, and the host answered 401 — it enforces
  /// the same `at >= expiresAt` for `refresh()` as for `verify()`. Nothing about that is
  /// discoverable only at the host, so nobody should be asked for a fingerprint over it.
  test('a token already past its TTL is not worth a prompt or a round trip', () async {
    await pair(device(remaining: const Duration(hours: -33)));

    expect(await keeper.refreshDueHosts(), isEmpty);
    expect(http.sent, isEmpty, reason: 'the host would refuse this, and says so the same way');
    expect(biometrics.prompts, 0, reason: 'a prompt that cannot succeed is just a tax');
  });

  /// Two machines, one gesture. The gate's grace window is what makes that true, and a
  /// second sheet per host would be exactly the prompt fatigue the 2026-08-07 addendum
  /// went out of its way to remove.
  test('two due hosts are renewed behind a single prompt', () async {
    await pair(device(host: mac, remaining: const Duration(hours: 2)));
    await pair(device(host: vps, remaining: const Duration(hours: 3)));
    http.enqueue(refreshReply(token: 'tok-mac'));
    http.enqueue(refreshReply(token: 'tok-vps'));

    final renewed = await keeper.refreshDueHosts();

    expect(renewed.toSet(), {mac, vps});
    expect(biometrics.prompts, 1);
  });

  /// This runs because the app was opened, not because anyone asked for it. A machine
  /// that is off is not news, and it must not cost the machine next to it its renewal.
  test('an unreachable host is skipped quietly and does not block the others', () async {
    await pair(device(host: mac, remaining: const Duration(hours: 2)));
    await pair(device(host: vps, remaining: const Duration(hours: 2)));
    http.failWith = const TransportUnavailable('mesin ini mati', cause: TransportCause.unroutable);

    await expectLater(keeper.refreshDueHosts(), completion(isEmpty));

    // And once it is reachable again, the next open picks it up.
    http.failWith = null;
    http.enqueue(refreshReply(token: 'tok-mac'));
    http.enqueue(refreshReply(token: 'tok-vps'));
    expect((await keeper.refreshDueHosts()).toSet(), {mac, vps});
  });

  /// A refusal is an answer, not an error to retry per machine.
  test('declining the prompt stops the walk instead of asking again per host', () async {
    await pair(device(host: mac, remaining: const Duration(hours: 2)));
    await pair(device(host: vps, remaining: const Duration(hours: 2)));
    biometrics.answer = false;

    expect(await keeper.refreshDueHosts(), isEmpty);
    expect(biometrics.prompts, 1, reason: 'one refusal, not one per machine');
    expect(http.sent, isEmpty);
  });

  /// The rule this must never route around: the host only ever sees a bearer, so the
  /// client gate means something only at a TTL the host enforces. A renewal that asked
  /// nobody would hand a stolen phone 30 days instead of 72 hours.
  test('renewing still requires proof of presence', () async {
    await pair(device(remaining: const Duration(hours: 2)));
    http.enqueue(refreshReply());

    await keeper.refreshDueHosts();
    expect(biometrics.prompts, 1);
  });

  /// A host paired with a hardware key renews on a signature the host verifies — past
  /// the TTL and past the ceiling, which is what the key exists for.
  group('with a hardware-bound refresh key', () {
    late FakeRefreshKeys keys;

    setUp(() {
      keys = FakeRefreshKeys();
      keeper = CredentialKeeper(registry: registry, credentials: credentials, keys: keys);
    });

    String renewReply() => jsonEncode({
          'deviceToken': 'tok-renewed',
          'expiresAt': now.add(hostTtl).millisecondsSinceEpoch,
          'hardExpiresAt': now.add(const Duration(days: 30)).millisecondsSinceEpoch,
        });

    test('brings back a lapsed credential with no pairing code and no gate prompt',
        () async {
      await pair(device(host: vps, remaining: -const Duration(days: 5), keyAlias: 'k-vps'));
      http
        ..enqueue('{"nonce":"n-1","expiresAt":0}')
        ..enqueue(renewReply());

      expect(await keeper.refreshDueHosts(), [vps]);

      final renewed = credentials.deviceFor(vps)!;
      expect(renewed.deviceToken, 'tok-renewed');
      expect(renewed.hardExpiresAt.isAtSameMomentAs(now.add(const Duration(days: 30))), isTrue);
      expect(renewed.refreshKeyAlias, 'k-vps');
      expect(keys.signed.single.$2, 'lotus-renew/v1\ndev_vps\nn-1');
      expect(http.last.uri.path, '/m/devices/renew');
      expect(http.last.json, {'deviceId': 'dev_vps', 'nonce': 'n-1', 'signature': 'sig(lotus-renew/v1\ndev_vps\nn-1)'});
      expect(http.sent.every((r) => r.bearer == null), isTrue, reason: 'the bearer is what lapsed');
      expect(biometrics.prompts, 0, reason: 'the Keystore prompt is the proof of presence');
    });

    test('renews past the 30-day ceiling too', () async {
      await pair(device(host: vps, remaining: -const Duration(days: 40),
          ceiling: -const Duration(days: 2), keyAlias: 'k-vps'));
      http
        ..enqueue('{"nonce":"n-1","expiresAt":0}')
        ..enqueue(renewReply());

      expect(await keeper.refreshDueHosts(), [vps]);
    });

    test('a cancelled prompt changes nothing and asks no further host', () async {
      keys.answer = const SignRefused();
      await pair(device(host: vps, remaining: -const Duration(days: 1), keyAlias: 'k-vps'));
      await pair(device(host: mac, remaining: -const Duration(days: 1), keyAlias: 'k-mac'));
      http.enqueue('{"nonce":"n-1","expiresAt":0}');

      expect(await keeper.refreshDueHosts(), isEmpty);
      expect(keys.signed, hasLength(1));
      expect(credentials.deviceFor(vps)!.refreshKeyAlias, 'k-vps');
    });

    test('a key a new fingerprint invalidated is forgotten, and the pairing kept', () async {
      keys.answer = const KeyGone();
      await pair(device(host: vps, remaining: -const Duration(days: 1), keyAlias: 'k-vps'));
      http.enqueue('{"nonce":"n-1","expiresAt":0}');

      expect(await keeper.refreshDueHosts(), isEmpty);
      expect(credentials.deviceFor(vps)!.refreshKeyAlias, isNull);
    });

    test('a host that no longer holds the key gets the local half deleted', () async {
      await pair(device(host: vps, remaining: -const Duration(days: 1), keyAlias: 'k-vps'));
      http.enqueue('{"error":"Renewal refused; pair again"}', status: 401);

      expect(await keeper.refreshDueHosts(), isEmpty);
      expect(keys.deleted, ['k-vps']);
      expect(credentials.deviceFor(vps)!.refreshKeyAlias, isNull);
    });

    test('a keyed credential with time to spare is left alone', () async {
      await pair(device(host: vps, keyAlias: 'k-vps'));

      expect(await keeper.refreshDueHosts(), isEmpty);
      expect(http.sent, isEmpty);
      expect(keys.signed, isEmpty);
    });
  });
}
