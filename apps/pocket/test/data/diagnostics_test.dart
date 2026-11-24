import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/core/push_tokens.dart';
import 'package:lotus_pocket/data/diagnostics.dart';
import 'package:lotus_pocket/data/push_repository.dart';
import 'package:lotus_pocket/hosts/biometric_gate.dart';
import 'package:lotus_pocket/hosts/credentials.dart';
import 'package:lotus_pocket/hosts/host_registry.dart';
import 'package:lotus_pocket/hosts/paired_host.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/pairing.dart';

import '../support/fake_security.dart';
import '../support/fake_transport.dart';

const HostId mac = HostId('mac');
const HostId vps = HostId('vps');

final DateTime nowStamp = DateTime.utc(2026, 8, 7, 12);

PairedHost host(HostId id, {List<String> features = const ['fleet'], String mode = 'client'}) =>
    PairedHost(
      id: id,
      label: id.value,
      baseUri: Uri.parse('http://${id.value}:8787'),
      mode: mode,
      caps: HostCaps(protocol: 1, features: features),
    );

PairedDevice device(
  HostId id, {
  Duration tokenLeft = const Duration(hours: 60),
  Duration ceilingLeft = const Duration(days: 28),
}) =>
    PairedDevice(
      deviceToken: 'tok-${id.value}',
      deviceId: 'dev_${id.value}',
      expiresAt: nowStamp.add(tokenLeft),
      hardExpiresAt: nowStamp.add(ceilingLeft),
      hostId: id,
      hostLabel: id.value,
      mode: 'client',
      caps: const HostCaps(protocol: 1, features: ['fleet']),
      baseUri: Uri.parse('http://${id.value}:8787'),
    );

/// A device whose token the test decides — the same seam `push_repository_test` uses.
class FakePushTokens implements PushTokens {
  FakePushTokens({this.token = 'tok-fcm-secret'});

  String? token;

  @override
  Future<bool> get available async => true;

  @override
  Future<String?> requestToken() async => token;

  @override
  Stream<String> get refreshed => const Stream<String>.empty();
}

void main() {
  late HostRegistry registry;
  late Credentials credentials;
  late PushRepository push;
  late FakePushTokens tokens;

  setUp(() {
    registry = HostRegistry(
      transport: FakeTransport(),
      httpTransport: FakeHttpTransport(),
      tokenReader: (h) => 'bearer',
      sleep: (_) async {},
    );
    credentials = Credentials(
      store: InMemorySecureStore(),
      now: () => nowStamp,
      gate: BiometricGate(FakeBiometrics()),
    );
    tokens = FakePushTokens();
    push = PushRepository(tokens: tokens, registry: registry);
  });

  tearDown(() => registry.dispose());

  Diagnostics read() => Diagnostics.of(
        registry: registry,
        credentials: credentials,
        push: push,
        now: nowStamp,
      );

  test('one host is described by what it advertised, not by what it is called', () async {
    registry.add(host(mac, features: ['fleet', 'transcript', 'permission'], mode: 'client'));
    await credentials.remember(device(mac));

    final host_ = read().hosts.single;

    expect(host_.label, 'mac');
    expect(host_.mode, 'client');
    // With the scheme: it is what decides ws against wss, and losing it was a real bug.
    expect(host_.origin, 'http://mac:8787');
    expect(host_.features, ['fleet', 'transcript', 'permission']);
  });

  group('reach', () {
    test('a host that has never answered reads as not connected, not as an error', () {
      registry.add(host(mac));

      // No failure yet either: nothing has been attempted. Inventing a cause here would
      // put a diagnosis on screen that nothing measured.
      expect(read().hosts.single.reach, 'not connected');
      expect(read().hosts.single.connected, isFalse);
    });

    test('a failure is named by its stable slug', () {
      registry.add(host(mac));
      registry.reportUnauthorized(mac, tokenStillValid: true);

      expect(read().hosts.single.reach, 'credential_revoked');
    });
  });

  group('credential', () {
    test('both clocks are reported as time remaining', () async {
      registry.add(host(mac));
      await credentials.remember(
        device(mac, tokenLeft: const Duration(hours: 60), ceilingLeft: const Duration(days: 28)),
      );

      final runway = read().hosts.single.credential!;

      expect(runway.tokenLeft, const Duration(hours: 60));
      expect(runway.ceilingLeft, const Duration(days: 28));
      expect(runway.refreshDue, isFalse);
      expect(runway.expired, isFalse);
      expect(runway.pastCeiling, isFalse);
    });

    test('inside the refresh lead it says so before the biometric prompt appears', () async {
      registry.add(host(mac));
      await credentials.remember(device(mac, tokenLeft: const Duration(hours: 20)));

      // 24-hour lead against a 72-hour TTL: the next foreground renews, and an operator
      // who was not told meets an unexplained biometric prompt.
      expect(read().hosts.single.credential!.refreshDue, isTrue);
    });

    test('expired and past-ceiling are separate answers, because the way out differs', () async {
      registry.add(host(mac));
      registry.add(host(vps));
      await credentials.remember(device(mac, tokenLeft: const Duration(hours: -1)));
      await credentials.remember(
        device(vps, tokenLeft: const Duration(hours: 5), ceilingLeft: const Duration(days: -1)),
      );

      final [macRunway, vpsRunway] = read().hosts.map((h) => h.credential!).toList();

      expect(macRunway.expired, isTrue);
      expect(macRunway.pastCeiling, isFalse);
      expect(vpsRunway.expired, isFalse);
      expect(vpsRunway.pastCeiling, isTrue);
    });

    test('a registered host with no stored token says so rather than showing a zero', () {
      registry.add(host(mac));

      expect(read().hosts.single.credential, isNull);
    });
  });

  group('push', () {
    test('a host that does not advertise push cannot send, whatever the phone holds',
        () async {
      registry.add(host(mac, features: ['fleet']));
      await push.start();

      expect(read().hosts.single.push, PushState.hostCannotSend);
    });

    test('a host that can send, with no token on this phone, names the missing half',
        () async {
      registry.add(host(mac, features: ['fleet', 'push']));
      tokens.token = null;
      await push.start();

      expect(read().hosts.single.push, PushState.phoneHasNoToken);
    });

    test('both halves in place reads as sent', () async {
      registry.add(host(mac, features: ['fleet', 'push']));
      await push.start();

      expect(read().hosts.single.push, PushState.tokenSent);
    });

    // That the token never *reaches the screen* is asserted where it could actually go
    // wrong — `test/features/settings/settings_screen_test.dart` renders the real screen
    // with a real token behind it and sweeps every string in the tree.
  });

  test('hosts stay in registry order, so the list does not reshuffle while it is read', () {
    registry.add(host(mac));
    registry.add(host(vps));
    registry.reportUnauthorized(mac, tokenStillValid: false);

    // `mac` is the broken one and still comes first, because it was paired first. Sorting
    // by health would move rows under the operator's finger every time a socket flapped.
    expect(read().hosts.map((h) => h.host), [mac, vps]);
  });

  test('an unparseable stored entry is carried through, not swallowed', () async {
    final store = InMemorySecureStore();
    await store.write('${Credentials.keyPrefix}corrupt', 'not json');
    credentials =
        Credentials(store: store, now: () => nowStamp, gate: BiometricGate(FakeBiometrics()));
    await credentials.load();

    expect(read().unreadableEntries, ['${Credentials.keyPrefix}corrupt']);
  });
}
