import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/core/transport.dart';
import 'package:lotus_pocket/data/fleet_store.dart';
import 'package:lotus_pocket/data/snippets.dart';
import 'package:lotus_pocket/data/pairing_outcome.dart';
import 'package:lotus_pocket/data/pairing_repository.dart';
import 'package:lotus_pocket/data/readdress_outcome.dart';
import 'package:lotus_pocket/hosts/biometric_gate.dart';
import 'package:lotus_pocket/hosts/credentials.dart';
import 'package:lotus_pocket/hosts/host_failure.dart';
import 'package:lotus_pocket/hosts/host_registry.dart';
import 'package:lotus_pocket/models/bootstrap.dart';
import 'package:lotus_pocket/models/host_id.dart';

import '../support/fake_refresh_keys.dart';
import '../support/fake_security.dart';
import '../support/fake_transport.dart';

/// The `POST /m/pair` reply, as `contract/fixtures/rest-pair.json` gives it.
String pairReply({
  String hostId = 'mac',
  String hostLabel = 'MacBook',
  String mode = 'client',
  int expiresInMs = 72 * 60 * 60 * 1000,
  List<String> features = const ['fleet', 'dispatch', 'stop', 'stream'],
}) =>
    jsonEncode({
      'deviceToken': 'tok_live',
      'deviceId': 'dev_abc',
      'expiresAt': DateTime(2026, 8, 6).millisecondsSinceEpoch + expiresInMs,
      'hardExpiresAt': DateTime(2026, 9, 5).millisecondsSinceEpoch,
      'hostId': hostId,
      'hostLabel': hostLabel,
      'mode': mode,
      'hostCaps': {
        'protocol': 1,
        'features': features,
      },
    });

void main() {
  late FakeHttpTransport http;
  late FakeTransport sockets;
  late InMemorySecureStore store;
  late Credentials credentials;
  late HostRegistry registry;
  late PairingRepository pairing;
  late FleetStore fleet;

  /// Held rather than inlined, because re-addressing is gated and this is the knob
  /// that says no.
  late FakeBiometrics biometrics;
  late FakeRefreshKeys keys;

  setUp(() {
    http = FakeHttpTransport();
    sockets = FakeTransport();
    store = InMemorySecureStore();
    biometrics = FakeBiometrics();
    credentials = Credentials(
      store: store,
      now: () => DateTime(2026, 8, 6),
      gate: BiometricGate(biometrics),
    );
    registry = HostRegistry(
      transport: sockets,
      httpTransport: http,
      tokenReader: credentials.tokenFor,
      sleep: (_) async {},
    );
    fleet = FleetStore(registry.events);
    // No key by default, so every test that predates hardware keys reads as it did.
    keys = FakeRefreshKeys(publicKey: null);
    pairing = PairingRepository(
      credentials: credentials,
      registry: registry,
      transport: http,
      fleet: fleet,
      snippets: Snippets(store),
      keys: keys,
    );
  });

  tearDown(() {
    fleet.dispose();
    registry.dispose();
    credentials.dispose();
  });

  Future<PairingOutcome> pairWith({
    String address = '100.64.0.3:8787',
    String code = '12345678',
    String deviceName = 'Pixel 8',
  }) =>
      pairing.pair(address: address, code: code, deviceName: deviceName);

  /// PLAN.md §Kredensial, addendum 2026-08-05: a key made at pairing, its public half
  /// with the host, so a lapsed token can come back on a signature instead of a code.
  group('a hardware-bound refresh key', () {
    const renewing = ['fleet', 'dispatch', 'stop', 'stream', 'device-renew'];

    test('rides in the pairing request and is remembered when the host takes it', () async {
      keys.publicKey = 'MFkw-public';
      http.enqueue(pairReply(features: renewing));

      await pairWith();

      expect(http.last.json['refreshKey'], 'MFkw-public');
      final alias = credentials.deviceFor(const HostId('mac'))!.refreshKeyAlias;
      expect(alias, keys.created.single);
      expect(keys.live, {alias});
    });

    test('is dropped on both sides of a host that does not renew', () async {
      keys.publicKey = 'MFkw-public';
      http.enqueue(pairReply());

      await pairWith();

      expect(credentials.deviceFor(const HostId('mac'))!.refreshKeyAlias, isNull);
      expect(keys.live, isEmpty);
    });

    test('is dropped when the pairing fails', () async {
      keys.publicKey = 'MFkw-public';
      http.enqueue('{"error":"Pairing code is invalid or expired"}', status: 401);

      await pairWith();

      expect(keys.created, hasLength(1));
      expect(keys.live, isEmpty);
    });

    test('is not sent at all by a phone that cannot hold one', () async {
      http.enqueue(pairReply(features: renewing));

      await pairWith();

      expect(http.last.json.containsKey('refreshKey'), isFalse);
      expect(credentials.deviceFor(const HostId('mac'))!.refreshKeyAlias, isNull);
    });

    test('of a re-paired machine replaces the old one, and unpairing drops it', () async {
      keys.publicKey = 'MFkw-public';
      http.enqueue(pairReply(features: renewing));
      await pairWith();
      final first = keys.created.single;

      http.enqueue(pairReply(features: renewing));
      await pairWith();
      final second = credentials.deviceFor(const HostId('mac'))!.refreshKeyAlias!;

      expect(second, isNot(first));
      expect(keys.live, {second});

      await pairing.unpair(const HostId('mac'));
      expect(keys.live, isEmpty);
    });
  });

  group('a code that works', () {
    test('redeems against the address that was typed', () async {
      http.enqueue(pairReply());

      final outcome = await pairWith();

      expect(outcome, isA<PairingSucceeded>());
      expect(http.last.method, 'POST');
      expect(http.last.uri, Uri.parse('http://100.64.0.3:8787/m/pair'));
      expect(http.last.json, {'pairingCode': '12345678', 'deviceName': 'Pixel 8'});
      // The one route with no bearer — there is no credential yet to send.
      expect(http.last.bearer, isNull);
    });

    test('stores the credential before anything can depend on it', () async {
      http.enqueue(pairReply());

      await pairWith();

      // Written to storage, not merely held in memory: a token that never reached the
      // Keychain would work until the next cold start and then be silently gone.
      expect(store.writes, 1);
      expect(store.entries.keys.single, 'host:mac');
      expect(credentials.tokenFor(const HostId('mac')), 'tok_live');
    });

    test('registers the host and starts dialling it', () async {
      http.enqueue(pairReply(hostLabel: 'MacBook'));

      await pairWith();

      final status = registry.statusOf(const HostId('mac'));
      expect(status, isNotNull);
      expect(status!.host.label, 'MacBook');
      // The address it was reached at, kept — the reply does not carry one.
      expect(status.host.baseUri, Uri.parse('http://100.64.0.3:8787'));
      expect(sockets.opened, hasLength(1));
    });

    test('the socket carries the token that was just issued', () async {
      http.enqueue(pairReply());

      await pairWith();

      // Proves the registry reads the credential through `Credentials`, so the token
      // stored a moment ago is the one dialled with — not an empty bearer that would
      // earn a 401 on the first connection.
      expect(sockets.opened.single.queryParameters['token'], 'tok_live');
    });

    test('an unnamed phone still gets a name the revoke list can show', () async {
      http.enqueue(pairReply());

      await pairWith(deviceName: '   ');

      expect(http.last.json['deviceName'], 'Lotus Pocket');
    });

    test('re-pairing a known host replaces it instead of doubling it', () async {
      http.enqueue(pairReply());
      await pairWith();
      http.enqueue(pairReply());

      await pairWith();

      // The ordinary way back in after the 72-hour TTL. Two live sockets for one host
      // would deliver every frame twice into `FleetStore` and keep dialling with the
      // dead token.
      expect(registry.hosts, hasLength(1));
      expect(store.entries.keys, ['host:mac']);
    });
  });

  group('what went wrong, told apart', () {
    test('a typo never leaves the phone', () async {
      final outcome = await pairWith(address: 'not an address');

      expect(outcome, isA<PairingAddressUnreadable>());
      expect(http.sent, isEmpty);
    });

    test('a refused code is not dressed up as a network problem', () async {
      http.enqueue('{"error":"Pairing code is invalid or expired"}', status: 401);

      final outcome = await pairWith();

      // The phone reached the host perfectly well and was told no. Sending the
      // operator to check their network here is the most expensive wrong turn on this
      // screen.
      expect(outcome, isA<PairingCodeRefused>());
      expect(credentials.devices, isEmpty);
      expect(registry.hosts, isEmpty);
    });

    /// `packages/host` throttles `/m/pair` per source and locks redeeming out after
    /// five failures (`issues/09`). Both answer 429, and neither is "this host does not
    /// pair" — the operator's move is to wait a moment, or ask for a fresh code, which
    /// is not the move any other case here asks for.
    test('a throttled or locked host is not dressed up as a broken one', () async {
      http.enqueue('{"error":"Too many pairing attempts"}', status: 429);

      final outcome = await pairWith();

      expect(outcome, isA<PairingThrottled>());
      expect(credentials.devices, isEmpty);
    });

    test('a lockout carries the host\'s own words, not invented copy', () async {
      http.enqueue('{"error":"Pairing is locked; ask the host for a new code"}', status: 429);

      final outcome = await pairWith();

      expect((outcome as PairingThrottled).reason, contains('new code'));
    });

    test('a refused connection means Lotus is not running, and says so', () async {
      http.failWith = const TransportUnavailable('nope', cause: TransportCause.refused);

      final outcome = await pairWith();

      expect(outcome, isA<PairingUnreachable>());
      expect((outcome as PairingUnreachable).failure, isA<LotusNotRunning>());
    });

    test('silence means the machine is asleep — a different fix entirely', () async {
      http.failWith = const TransportUnavailable('…', cause: TransportCause.timedOut);

      final outcome = await pairWith();

      expect((outcome as PairingUnreachable).failure, isA<HostAsleep>());
    });

    test('no route at all is the tailnet, not the host', () async {
      http.failWith = const TransportUnavailable('…', cause: TransportCause.unroutable);

      final outcome = await pairWith();

      expect((outcome as PairingUnreachable).failure, isA<TailnetDown>());
    });

    test('something that answers but is not Lotus carries its own words', () async {
      http.enqueue('<html>502 Bad Gateway</html>', status: 502);

      final outcome = await pairWith();

      expect(outcome, isA<PairingHostFaulted>());
      expect((outcome as PairingHostFaulted).reason, contains('502'));
    });

    test('a host that refuses the request hands back its reason unedited', () async {
      http.enqueue('{"error":"pairingCode is required"}', status: 400);

      final outcome = await pairWith();

      expect((outcome as PairingHostFaulted).reason, 'pairingCode is required');
    });

    test('nothing is stored when nothing succeeded', () async {
      http.failWith = const TransportUnavailable('…', cause: TransportCause.timedOut);

      await pairWith();

      // The stronger assertion: not that it returned a failure, but that no half-state
      // was left behind for the next cold start to find.
      expect(store.writes, 0);
      expect(credentials.devices, isEmpty);
      expect(registry.hosts, isEmpty);
    });
  });

  /// The cheaper answer to the commonest failure on the diagnostics screen.
  ///
  /// The host binds a literal IP (`host_runtime::interfaces` refuses a hostname), and
  /// `PairedHost.withHello` keeps `baseUri` across every reconnection — so a DHCP lease
  /// moving leaves a perfectly good credential pointing at nothing, and until this
  /// existed the only way out was to unpair and type an address again.
  group('re-addressing', () {
    const HostId mac = HostId('mac');

    Future<void> paired() async {
      http.enqueue(pairReply());
      await pairWith();
      http.sent.clear();
      sockets.opened.clear();
    }

    test('keeps the token and moves only where to look', () async {
      await paired();
      final before = credentials.deviceFor(const HostId('mac'))!;

      final outcome = await pairing.readdress(host: mac, address: '192.168.1.11:8787');

      expect(outcome, isA<ReaddressDone>());
      final after = credentials.deviceFor(const HostId('mac'))!;
      expect(after.baseUri, Uri.parse('http://192.168.1.11:8787'));
      // Nothing was revoked and nothing was re-issued: a machine that changed address
      // is still the machine that issued this.
      expect(after.deviceToken, before.deviceToken);
      expect(after.deviceId, before.deviceId);
      expect(after.expiresAt, before.expiresAt);
      expect(after.hardExpiresAt, before.hardExpiresAt);
      // And the host was never asked anything — this is a local rewrite.
      expect(http.sent, isEmpty);
    });

    test('survives a cold start, which is the whole point of writing it', () async {
      await paired();
      await pairing.readdress(host: mac, address: '192.168.1.11:8787');

      final reloaded = Credentials(
        store: store,
        now: () => DateTime(2026, 8, 6),
        gate: BiometricGate(FakeBiometrics()),
      );
      await reloaded.load();

      expect(reloaded.deviceFor(const HostId('mac'))!.baseUri, Uri.parse('http://192.168.1.11:8787'));
      reloaded.dispose();
    });

    test('dials the new address and stops dialling the old one', () async {
      await paired();

      await pairing.readdress(host: mac, address: '192.168.1.11:8787');

      // `registry.add` retires the previous socket first. Without that, the old
      // connection would keep spending its backoff on an address nothing answers on.
      expect(sockets.opened, hasLength(1));
      expect(sockets.opened.single.toString(), startsWith('ws://192.168.1.11:8787/'));
      expect(registry.hosts, hasLength(1));
    });

    test('a typo is caught before anything is written', () async {
      await paired();

      final outcome = await pairing.readdress(host: mac, address: 'not an address');

      expect(outcome, isA<ReaddressUnreadable>());
      // The old address stands, so a slip costs nothing — including on a host that
      // was reachable a moment ago.
      expect(credentials.deviceFor(const HostId('mac'))!.baseUri, Uri.parse('http://100.64.0.3:8787'));
      expect(sockets.opened, isEmpty);
    });

    test('a typo never costs a fingerprint', () async {
      await paired();

      await pairing.readdress(host: mac, address: 'not an address');

      // The parse comes first on purpose: being asked for proof and *then* told the
      // address was wrong teaches that the prompt means nothing.
      expect(biometrics.prompts, 0);
    });

    test('a refused gate changes nothing at all', () async {
      await paired();
      biometrics.answer = false;

      final outcome = await pairing.readdress(host: mac, address: '192.168.1.11:8787');

      expect(outcome, isA<ReaddressRefused>());
      expect(credentials.deviceFor(const HostId('mac'))!.baseUri, Uri.parse('http://100.64.0.3:8787'));
      expect(sockets.opened, isEmpty);
    });

    test('is gated at all, unlike unpairing', () async {
      await paired();

      await pairing.readdress(host: mac, address: '192.168.1.11:8787');

      // ADR-8 gates what reaches a machine, and this decides where the bearer gets
      // sent next: without proof, somebody holding an unlocked phone could point a
      // live token at a server of their own and collect it.
      expect(biometrics.prompts, 1);
      expect(biometrics.reasons.single, contains('MacBook'));
    });

    test('a host this phone has no key for is refused', () async {
      final outcome =
          await pairing.readdress(host: const HostId('ghost'), address: '10.0.0.1:8787');

      expect(outcome, isA<ReaddressUnreadable>());
      expect(sockets.opened, isEmpty);
      expect(biometrics.prompts, 0);
    });
  });

  group('unpairing', () {
    const HostId mac = HostId('mac');

    /// Pairs for real, then clears the transport's record so the unpair's own requests
    /// are the only ones under test.
    Future<void> paired() async {
      http.enqueue(pairReply());
      await pairWith();
      http.sent.clear();
    }

    test('hands the credential back before dropping it', () async {
      await paired();
      http.enqueue('{"ok":true}');

      await pairing.unpair(mac);

      // Its own deviceId, with its own bearer. Without this the host keeps a live token
      // and a push destination for a phone that has walked away, until the TTL lapses.
      expect(http.last.method, 'DELETE');
      expect(http.last.uri.path, '/m/devices/dev_abc');
      expect(http.last.bearer, 'Bearer tok_live');
    });

    test('leaves nothing behind — no credential, no host, no socket', () async {
      await paired();
      http.enqueue('{"ok":true}');

      await pairing.unpair(mac);

      expect(credentials.devices, isEmpty);
      expect(registry.hosts, isEmpty);
      expect(registry.statusOf(mac), isNull);
      expect(store.deletes, 1);
      // The socket is gone too, not merely unreferenced: one left dialling would spend
      // its backoff earning 401s with a token that no longer exists.
      expect(sockets.channels.single.closedByClient, isTrue);
    });

    test('an unreachable host does not block it', () async {
      await paired();
      http.failWith = const TransportUnavailable('…', cause: TransportCause.timedOut);

      await pairing.unpair(mac);

      // The commonest reason to unpair is a machine that is gone. An unpair that only
      // worked while the host answered would be no way out at all — what is lost is the
      // early revoke, not the unpairing.
      expect(credentials.devices, isEmpty);
      expect(registry.hosts, isEmpty);
    });

    test('a host that refuses the revoke does not block it either', () async {
      await paired();
      http.enqueue('{"error":"Unknown device"}', status: 404);

      await pairing.unpair(mac);

      // Already revoked from the desktop is the ordinary case, and it means the phone is
      // *more* out of date than it thought, not less.
      expect(credentials.devices, isEmpty);
      expect(registry.hosts, isEmpty);
    });

    test('a host that was never paired is a no-op, not a crash', () async {
      await expectLater(pairing.unpair(const HostId('ghost')), completes);

      expect(http.sent, isEmpty);
    });

    test('its rows leave the switcher with it', () async {
      await paired();
      fleet.adoptProjects(mac, [
        const HostProject(
          project: ProjectRef(mac, 'CNVS'),
          name: 'demo',
          path: '/code/demo',
          lastOpenedAt: 1,
        ),
      ]);
      http.enqueue('{"ok":true}');

      await pairing.unpair(mac);

      // A switcher row for a machine this phone has no key for cannot be opened,
      // and a row that goes nowhere is worse than one that is missing.
      expect(fleet.projects, isEmpty);
    });

  });

  group('a second machine, alongside the first', () {
    /// The property the whole "Pair another machine" route rests on, tested where it
    /// actually lives rather than through a widget.
    ///
    /// ADR-3 makes multi-host a v1 requirement, and the store has always been keyed by
    /// host id — so this held before the UI could reach it. It is pinned now because
    /// the UI *can*: an operator adding a VPS to a phone that already has a desktop
    /// must not discover afterwards that they traded one for the other.
    test('pairing a VPS leaves the desktop credential exactly where it was', () async {
      http.enqueue(pairReply());
      await pairWith();
      final desktop = credentials.deviceFor(const HostId('mac'));

      http.enqueue(pairReply(hostId: 'vps', hostLabel: 'devbox-vps', mode: 'standalone'));
      final outcome = await pairWith(address: '100.64.0.10:8787', code: '87654321');

      expect(outcome, isA<PairingSucceeded>());
      expect(credentials.devices, hasLength(2));
      expect(credentials.deviceFor(const HostId('mac'))?.deviceToken, desktop?.deviceToken);
      expect(credentials.deviceFor(const HostId('vps'))?.mode, 'standalone');
    });

    test('both machines are registered, so both are dialled', () async {
      http.enqueue(pairReply());
      await pairWith();
      http.enqueue(pairReply(hostId: 'vps', hostLabel: 'devbox-vps', mode: 'standalone'));
      await pairWith(address: '100.64.0.10:8787', code: '87654321');

      // A credential nothing dials is a machine the operator cannot see — the same
      // shape of gap as the missing route itself.
      expect(registry.hosts.map((h) => h.id).toSet(), {const HostId('mac'), const HostId('vps')});
    });

    test('a machine paired twice replaces itself rather than doubling', () async {
      http.enqueue(pairReply());
      await pairWith();
      http.enqueue(pairReply());
      await pairWith(address: '100.64.0.9:8787', code: '87654321');

      // Re-pairing the *same* machine is a repair, not a second machine. Keyed by
      // host id, so the new address and token win and the count does not move.
      expect(credentials.devices, hasLength(1));
      expect(credentials.deviceFor(const HostId('mac'))?.baseUri.host, '100.64.0.9');
    });
  });
}
