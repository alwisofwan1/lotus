import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/core/api_failure.dart';
import 'package:lotus_pocket/hosts/biometric_gate.dart';
import 'package:lotus_pocket/hosts/credentials.dart';
import 'package:lotus_pocket/hosts/host_registry.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/pairing.dart';

import '../support/fake_security.dart';

/// The 72-hour TTL, tested by moving the clock rather than by waiting three days —
/// which is the entire reason ADR-13 no. 4 makes the clock a seam.
const HostId mac = HostId('mac');
const HostId vps = HostId('vps');

/// Wall clock the test drives by hand.
DateTime now = DateTime.utc(2026, 8, 5, 12);

/// Matches `DEVICE_TOKEN_TTL_MS` on the host — see the note there for why 72 hours.
const Duration hostTtl = Duration(hours: 72);

PairedDevice device({
  HostId host = mac,
  String token = 'tok-1',
  Duration ttl = hostTtl,
  Duration ceiling = const Duration(days: 30),
}) =>
    PairedDevice(
      deviceToken: token,
      deviceId: 'dev_a1',
      expiresAt: now.add(ttl),
      hardExpiresAt: now.add(ceiling),
      hostId: host,
      hostLabel: host == mac ? 'MacBook' : 'VPS',
      mode: host == mac ? 'client' : 'standalone',
      caps: const HostCaps(protocol: 1, features: ['fleet', 'dispatch']),
      baseUri: Uri.parse('http://${host.value}:9877'),
    );

void main() {
  late InMemorySecureStore store;
  late FakeBiometrics biometrics;
  late Credentials credentials;

  setUp(() {
    now = DateTime.utc(2026, 8, 5, 12);
    store = InMemorySecureStore();
    biometrics = FakeBiometrics();
    credentials = Credentials(
      store: store,
      now: () => now,
      gate: BiometricGate(biometrics),
    );
  });

  group('persistence', () {
    test('a Keystore that cannot be read at boot still lets the app start', () async {
      store.failReads = StateError('keystore unavailable');

      await credentials.load(); // must not throw: it gates the first frame

      expect(credentials.hosts, isEmpty);
      expect(credentials.unreadable, isNotEmpty);
    });

    test('a paired device survives a cold start', () async {
      await credentials.remember(device());
      expect(store.writes, 1);

      // A second instance over the same storage is what a relaunch actually is.
      final reopened = Credentials(
        store: store,
        now: () => now,
        gate: BiometricGate(biometrics),
      );
      await reopened.load();

      expect(reopened.deviceFor(mac)?.deviceToken, 'tok-1');
      expect(reopened.deviceFor(mac)?.hostLabel, 'MacBook');
      expect(reopened.hosts, [mac]);
    });

    test('what is stored is the wire shape, so one factory reads it back', () async {
      await credentials.remember(device());

      final stored = jsonDecode(store.entries['host:mac']!) as Map<String, Object?>;

      // Round-trips through the same `fromJson` the contract fixture already proves.
      expect(PairedDevice.fromStored(stored).deviceToken, 'tok-1');
      expect(stored['hostId'], 'mac');
    });

    test('a machine keeps the name its owner gave it across a cold start', () async {
      await credentials.remember(device());
      await credentials.rename(mac, 'studio');

      final reopened = Credentials(
        store: store,
        now: () => now,
        gate: BiometricGate(biometrics),
      );
      await reopened.load();

      expect(reopened.deviceFor(mac)?.nickname, 'studio');
      // The machine's own name is not replaced by it — two MacBooks are told apart by
      // the hostname and nothing else.
      expect(reopened.deviceFor(mac)?.hostLabel, 'MacBook');
    });

    test('clearing the name stores nothing rather than an empty one', () async {
      await credentials.remember(device());
      await credentials.rename(mac, 'studio');

      await credentials.rename(mac, '   ');

      expect(credentials.deviceFor(mac)?.nickname, isNull);
      final stored = jsonDecode(store.entries['host:mac']!) as Map<String, Object?>;
      expect(stored.containsKey('nickname'), isFalse);
    });

    test('a credential stored before names existed still reads back', () async {
      await credentials.remember(device());
      final stored = jsonDecode(store.entries['host:mac']!) as Map<String, Object?>
        ..remove('nickname');

      // The field is optional on the wire *and* in storage, so an app update does not
      // turn every paired machine into an unreadable entry.
      expect(PairedDevice.fromStored(stored).nickname, isNull);
    });

    test('unpairing takes the name with it', () async {
      await credentials.remember(device());
      await credentials.rename(mac, 'studio');

      await credentials.forget(mac);

      // The name lives on the credential precisely so it cannot outlive the pairing
      // and greet whatever machine reuses the id next.
      expect(store.entries.keys.any((k) => k.contains('mac')), isFalse);
    });

    test('two hosts are two entries, and one does not erase the other', () async {
      await credentials.remember(device());
      await credentials.remember(device(host: vps, token: 'tok-v'));

      expect(credentials.hosts, containsAll([mac, vps]));
      expect(credentials.tokenFor(mac), 'tok-1');
      expect(credentials.tokenFor(vps), 'tok-v');
    });

    test('forgetting one host leaves the other paired', () async {
      await credentials.remember(device());
      await credentials.remember(device(host: vps, token: 'tok-v'));

      await credentials.forget(mac);

      expect(store.deletes, 1);
      expect(credentials.hosts, [vps]);
      expect(credentials.deviceFor(mac), isNull);
    });

    test('an unreadable entry is skipped and named, not fatal', () async {
      await credentials.remember(device());
      store.entries['host:corrupt'] = 'not json at all';

      await credentials.load();

      // The only screen the operator has must not die because one Keychain entry rotted.
      expect(credentials.hosts, [mac]);
      expect(credentials.unreadable, ['host:corrupt']);
    });

    test('keys outside the host namespace are left alone', () async {
      store.entries['unrelated'] = 'someone else\'s value';
      await credentials.load();

      expect(credentials.hosts, isEmpty);
      expect(credentials.unreadable, isEmpty);
      expect(store.entries['unrelated'], isNotNull);
    });

    test('an unknown host reads as an empty token rather than throwing', () async {
      // Called from inside a socket callback: throwing there would take down the
      // reconnect loop. An empty bearer earns a 401, which is a path that exists.
      expect(credentials.tokenFor(vps), '');
    });

    test('it satisfies the reader HostRegistry already asks for', () async {
      await credentials.remember(device());

      // Proves the seam fits without adapters: this is the wiring app/ will do.
      final TokenReader reader = credentials.tokenFor;

      expect(reader(mac), 'tok-1');
    });
  });

  group('the 72-hour TTL', () {
    test('a fresh token is usable and not yet due', () async {
      await credentials.remember(device());

      expect(credentials.isUsable(mac), isTrue);
      expect(credentials.refreshDue(mac), isFalse);
    });

    test('inside the last day it is due, and still usable', () async {
      await credentials.remember(device());

      now = now.add(const Duration(hours: 71, minutes: 30));

      // ADR-12 no. 2: refresh proactively at under a day left, rather than waiting
      // for a 401 that arrives while the operator is mid-action. The lead is wide —
      // 24 hours against a 72-hour TTL — because it only has to fire the next time
      // the app happens to be opened, not at a precise moment.
      expect(credentials.refreshDue(mac), isTrue);
      expect(credentials.isUsable(mac), isTrue);
    });

    test('past the TTL it is no longer usable', () async {
      await credentials.remember(device());

      now = now.add(const Duration(hours: 72, minutes: 1));

      expect(credentials.isUsable(mac), isFalse);
    });

    test('past the 30-day ceiling nothing can revive it', () async {
      await credentials.remember(device());

      now = now.add(const Duration(days: 30, minutes: 1));

      expect(credentials.pastCeiling(mac), isTrue);
    });
  });

  group('refresh', () {
    test('does nothing while there is more than a day left', () async {
      await credentials.remember(device());
      var called = false;

      final outcome = await credentials.refreshIfDue(mac, () async {
        called = true;
        return RefreshedToken(deviceToken: 'tok-2', expiresAt: now);
      });

      expect(outcome, RefreshOutcome.notDue);
      expect(called, isFalse);
      expect(biometrics.prompts, 0);
    });

    test('when due it asks for proof, then stores the new token', () async {
      await credentials.remember(device());
      now = now.add(const Duration(hours: 71, minutes: 30));

      final outcome = await credentials.refreshIfDue(
        mac,
        () async => RefreshedToken(
          deviceToken: 'tok-2',
          expiresAt: now.add(const Duration(hours: 72)),
        ),
      );

      expect(outcome, RefreshOutcome.refreshed);
      // PLAN.md §Kredensial: refresh needs biometrics, precisely so a stolen unlocked
      // phone cannot renew forever.
      expect(biometrics.prompts, 1);
      expect(credentials.tokenFor(mac), 'tok-2');
      expect(credentials.refreshDue(mac), isFalse);
      expect(store.writes, 2, reason: 'the new token must reach storage too');
    });

    test('a refresh moves the TTL and never the ceiling', () async {
      await credentials.remember(device());
      final ceiling = credentials.deviceFor(mac)!.hardExpiresAt;
      now = now.add(const Duration(hours: 71, minutes: 30));

      await credentials.refreshIfDue(
        mac,
        () async => RefreshedToken(
          deviceToken: 'tok-2',
          expiresAt: now.add(const Duration(hours: 72)),
        ),
      );

      expect(credentials.deviceFor(mac)!.hardExpiresAt, ceiling);
    });

    test('refused proof keeps the old token, which is still alive', () async {
      await credentials.remember(device());
      biometrics.answer = false;
      now = now.add(const Duration(hours: 71, minutes: 30));

      final outcome = await credentials.refreshIfDue(
        mac,
        () async => fail('must not reach the host without proof'),
      );

      expect(outcome, RefreshOutcome.refused);
      expect(credentials.tokenFor(mac), 'tok-1');
      expect(credentials.isUsable(mac), isTrue);
    });

    test('past the ceiling it does not even ask the host', () async {
      await credentials.remember(device());
      now = now.add(const Duration(days: 31));

      final outcome = await credentials.refreshIfDue(
        mac,
        () async => fail('the host would refuse; do not spend a round trip on it'),
      );

      expect(outcome, RefreshOutcome.mustRepair);
      expect(biometrics.prompts, 0);
    });

    test('a host that refuses the refresh means re-pair, and the entry stays', () async {
      await credentials.remember(device());
      now = now.add(const Duration(hours: 71, minutes: 30));

      final outcome = await credentials.refreshIfDue(
        mac,
        () async => throw const RefreshRefused(),
      );

      // The entry is deliberately kept: onboarding needs to know *which* host to
      // re-pair with, and deleting it would drop that host off the list entirely.
      expect(outcome, RefreshOutcome.mustRepair);
      expect(credentials.hosts, [mac]);
    });

    test('an unreachable host is not a dead credential', () async {
      await credentials.remember(device());
      now = now.add(const Duration(hours: 71, minutes: 30));

      // A sleeping host must not read as "re-pair": the token is fine, the machine is
      // asleep, and `hosts/` already has a taxonomy for that.
      await expectLater(
        credentials.refreshIfDue(mac, () async => throw const HostUnauthorized()),
        throwsA(isA<HostUnauthorized>()),
      );
      expect(credentials.tokenFor(mac), 'tok-1');
    });

    test('an unknown host cannot be refreshed into existence', () async {
      final outcome = await credentials.refreshIfDue(
        vps,
        () async => fail('there is no credential to refresh'),
      );

      expect(outcome, RefreshOutcome.mustRepair);
    });

    test('a storage that refuses the write does not leave a token only in memory',
        () async {
      await credentials.remember(device());
      now = now.add(const Duration(hours: 71, minutes: 30));
      store.failWrites = Exception('keystore unavailable');

      await expectLater(
        credentials.refreshIfDue(
          mac,
          () async => RefreshedToken(
            deviceToken: 'tok-2',
            expiresAt: now.add(const Duration(hours: 72)),
          ),
        ),
        throwsA(isA<Exception>()),
      );

      // Storage is the source of truth across a relaunch. A token held in memory but
      // never written would vanish on the next cold start while the app acted as
      // though it were paired.
      expect(credentials.tokenFor(mac), 'tok-1');
    });
  });

  test('listeners hear a credential change, so a screen can follow it', () async {
    var notifications = 0;
    credentials.addListener(() => notifications += 1);

    await credentials.remember(device());
    now = now.add(const Duration(hours: 71, minutes: 30));
    await credentials.refreshIfDue(
      mac,
      () async => RefreshedToken(
        deviceToken: 'tok-2',
        expiresAt: now.add(const Duration(hours: 72)),
      ),
    );
    await credentials.forget(mac);

    expect(notifications, 3);
  });
}
