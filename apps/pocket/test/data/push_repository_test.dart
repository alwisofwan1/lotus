import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/core/push_tokens.dart';
import 'package:lotus_pocket/core/transport.dart';
import 'package:lotus_pocket/data/push_repository.dart';
import 'package:lotus_pocket/hosts/host_registry.dart';
import 'package:lotus_pocket/hosts/paired_host.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';

import '../support/fake_transport.dart';

const HostId mac = HostId('mac');
const HostId vps = HostId('vps');

PairedHost host(HostId id, {required List<String> features}) => PairedHost(
      id: id,
      label: id.value,
      baseUri: Uri.parse('http://${id.value}:8787'),
      mode: 'client',
      caps: HostCaps(protocol: 1, features: features),
    );

/// A device whose push support the test decides.
class FakePushTokens implements PushTokens {
  FakePushTokens({this.hasSupport = true, this.token = 'tok-fcm'});

  bool hasSupport;
  String? token;
  int requests = 0;
  final _rotations = StreamController<String>.broadcast();

  void rotate(String next) => _rotations.add(next);

  @override
  Future<bool> get available async => hasSupport;

  @override
  Future<String?> requestToken() async {
    requests += 1;
    return token;
  }

  @override
  Stream<String> get refreshed => _rotations.stream;
}

void main() {
  late FakeHttpTransport http;
  late HostRegistry registry;
  late FakePushTokens tokens;
  late PushRepository push;

  setUp(() {
    http = FakeHttpTransport();
    registry = HostRegistry(
      transport: FakeTransport(),
      httpTransport: http,
      tokenReader: (h) => 'bearer-${h.value}',
      sleep: (_) async {},
    );
    tokens = FakePushTokens();
    push = PushRepository(tokens: tokens, registry: registry);
  });

  tearDown(() => registry.dispose());

  // A local function, not a getter: Dart has no local getters.
  List<Uri> pushRegistrations() => http.sent
      .where((r) => r.uri.path == '/m/devices/push-token' && r.method == 'POST')
      .map((r) => r.uri)
      .toList();

  test('registers the token with every host that advertises push', () async {
    registry.add(host(mac, features: ['fleet', 'push']));
    registry.add(host(vps, features: ['fleet', 'push']));

    await push.start();

    expect(pushRegistrations(), hasLength(2));
    expect(http.sent.last.json, {'token': 'tok-fcm', 'platform': 'fcm'});
  });

  test('skips a host that cannot send, so nothing waits on a wake-up that cannot come',
      () async {
    registry.add(host(mac, features: ['fleet', 'push']));
    registry.add(host(vps, features: ['fleet'])); // No Firebase credentials there.

    await push.start();

    expect(pushRegistrations(), hasLength(1));
    expect(pushRegistrations().single.host, 'mac');
  });

  test('carries the host\'s own bearer, since the host binds the token to it', () async {
    registry.add(host(mac, features: ['fleet', 'push']));

    await push.start();

    // The body has no deviceId at all — the host reads it from this bearer, which is
    // what stops one paired phone claiming another's wake-ups.
    expect(http.sent.last.bearer, 'Bearer bearer-mac');
  });

  group('before anything is paired', () {
    test('asks for nothing at all — not even the permission', () async {
      await push.start();

      // On Android 13+ a refusal is permanent. Asking on a phone that knows no machine
      // collects a "no" for a capability the operator has not seen the point of yet,
      // and the OS never asks again — so push would be dead before pairing even
      // happened. Seen for real: the system dialog on top of the onboarding screen.
      expect(tokens.requests, 0);
      expect(http.sent, isEmpty);
    });

    test('and asks the moment a host exists', () async {
      await push.start();
      registry.add(host(mac, features: ['fleet', 'push']));

      // What `PocketApp.onPaired` does: run it again once there is a machine.
      await push.start();

      expect(tokens.requests, 1);
      expect(pushRegistrations(), hasLength(1));
    });
  });

  group('when the phone cannot receive wake-ups', () {
    test('a build without messaging never asks for a token', () async {
      registry.add(host(mac, features: ['fleet', 'push']));
      tokens.hasSupport = false;

      await push.start();

      expect(tokens.requests, 0);
      expect(http.sent, isEmpty);
    });

    test('a declined permission registers nothing', () async {
      registry.add(host(mac, features: ['fleet', 'push']));
      tokens.token = null;

      await push.start();

      expect(http.sent, isEmpty);
      expect(push.currentToken, isNull);
    });
  });

  group('rotation', () {
    test('a rotated token is re-registered everywhere', () async {
      registry.add(host(mac, features: ['fleet', 'push']));
      registry.add(host(vps, features: ['fleet', 'push']));
      await push.start();

      tokens.rotate('tok-rotated');
      await pumpEventQueue();

      // Not an edge case: a stale token stops delivering *silently*, which in this
      // product looks exactly like a quiet fleet.
      expect(pushRegistrations(), hasLength(4));
      expect(http.sent.last.json['token'], 'tok-rotated');
      expect(push.currentToken, 'tok-rotated');
    });

    test('rotation stops being followed after stop()', () async {
      registry.add(host(mac, features: ['fleet', 'push']));
      await push.start();
      await push.stop();
      final before = http.sent.length;

      tokens.rotate('tok-late');
      await pumpEventQueue();

      expect(http.sent.length, before);
    });
  });

  group('a host that joins later', () {
    test('gets the token the first pairing already obtained', () async {
      // The real sequence, now that nothing is asked before the first pairing: one host
      // paired and started, then a second machine joins.
      registry.add(host(mac, features: ['fleet', 'push']));
      await push.start();
      registry.add(host(vps, features: ['fleet', 'push']));

      await push.registerWith(vps);

      expect(pushRegistrations(), hasLength(2));
      expect(pushRegistrations().last.host, 'vps');
      // One prompt, not two: the token is held, not re-requested per host.
      expect(tokens.requests, 1);
    });

    test('is left alone when there is no token to give it', () async {
      tokens.token = null;
      registry.add(host(mac, features: ['fleet', 'push']));
      await push.start();

      await push.registerWith(mac);

      expect(http.sent, isEmpty);
    });
  });

  group('failures never break the first channel', () {
    test('a sleeping host does not stop the others being registered', () async {
      registry.add(host(mac, features: ['fleet', 'push']));
      http.failWith = const TransportUnavailable('asleep', cause: TransportCause.timedOut);

      // Push is the second channel: the operator still sees everything over the live
      // socket the moment they open the app, so failing loudly here would trade a real
      // capability for a broken screen.
      await expectLater(push.start(), completes);
    });

    test('a host that refuses the route is not an error either', () async {
      registry.add(host(mac, features: ['fleet', 'push']));
      http.enqueue('{"error":"Not Found"}', status: 404);

      await expectLater(push.start(), completes);
    });
  });

  test('stop() withdraws the device from every host that knows it', () async {
    registry.add(host(mac, features: ['fleet', 'push']));
    registry.add(host(vps, features: ['fleet', 'push']));
    await push.start();

    await push.stop();

    final withdrawals =
        http.sent.where((r) => r.method == 'DELETE' && r.uri.path == '/m/devices/push-token');
    expect(withdrawals, hasLength(2));
    expect(push.currentToken, isNull);
  });
}
