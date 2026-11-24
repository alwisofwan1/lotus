import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/core/transport.dart';
import 'package:lotus_pocket/data/fleet_repository.dart';
import 'package:lotus_pocket/data/fleet_store.dart';
import 'package:lotus_pocket/hosts/biometric_gate.dart';
import 'package:lotus_pocket/hosts/credentials.dart';
import 'package:lotus_pocket/hosts/host_failure.dart';
import 'package:lotus_pocket/hosts/host_registry.dart';
import 'package:lotus_pocket/hosts/paired_host.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/pairing.dart';

import '../support/fake_security.dart';
import '../support/fake_transport.dart';

/// The cold start, which for a phone is the *normal* start.
const HostId mac = HostId('mac');
const HostId vps = HostId('vps');

final Directory fixtures = Directory('../../contract/fixtures');

/// A bootstrap payload for one host, with the cells named so a test can tell the two
/// hosts' contributions apart.
String bootstrapFor(HostId host, {List<String> panes = const ['p-1'], String? waiting}) {
  final base = jsonDecode(File('${fixtures.path}/rest-bootstrap.json').readAsStringSync())
      as Map<String, Object?>;
  return jsonEncode({
    ...base,
    'hostId': host.value,
    'hostLabel': host.value,
    'cells': [
      for (final pane in panes)
        {
          'paneId': pane,
          'workspaceId': 'CNVS',
          'agentType': 'claude',
          'title': pane,
          'status': 'live',
          'isAlive': true,
          'turn': ?(pane == waiting ? 'needs-input' : null),
        },
    ],
  });
}

void main() {
  late FakeHttpTransport http;
  late FakeTransport sockets;
  late FleetStore store;
  late Credentials credentials;
  late HostRegistry registry;
  late FleetRepository repository;

  final now = DateTime.utc(2026, 8, 5, 12);

  PairedDevice device(HostId id) => PairedDevice(
        deviceToken: 'tok-${id.value}',
        deviceId: 'dev_a1',
        expiresAt: now.add(const Duration(hours: 12)),
        hardExpiresAt: now.add(const Duration(days: 30)),
        hostId: id,
        hostLabel: id.value,
        mode: 'client',
        caps: const HostCaps(protocol: 1, features: ['fleet']),
        baseUri: Uri.parse('http://${id.value}:9877'),
      );

  PairedHost host(HostId id) => PairedHost(
        id: id,
        label: id.value,
        baseUri: Uri.parse('http://${id.value}:9877'),
        mode: 'client',
        caps: const HostCaps(protocol: 1, features: ['fleet', 'dispatch']),
      );

  setUp(() {
    http = FakeHttpTransport();
    sockets = FakeTransport();
    credentials = Credentials(
      store: InMemorySecureStore(),
      now: () => now,
      gate: BiometricGate(FakeBiometrics()),
    );
    registry = HostRegistry(
      transport: sockets,
      httpTransport: http,
      tokenReader: credentials.tokenFor,
      sleep: (_) async {},
    );
    store = FleetStore(registry.events);
    repository = FleetRepository(registry: registry, store: store, credentials: credentials);
  });

  tearDown(() {
    repository.dispose();
    store.dispose();
    registry.dispose();
  });

  /// What a host sends the instant a socket attaches — the only signal the phone
  /// gets that says "your picture of this machine may be out of date".
  Map<String, Object?> helloFrom(HostId id) => {
        'type': 'hello',
        'hostId': id.value,
        'hostLabel': id.value,
        'mode': 'client',
        'hostCaps': {'protocol': 1, 'features': ['fleet']},
      };

  group('a socket coming back', () {
    /// Registers, connects, and lets the socket settle — without enqueuing a reply,
    /// so the bootstrap under test is the only HTTP this host has been asked for.
    Future<void> connected() async {
      registry.add(host(mac));
      await credentials.remember(device(mac));
      registry.connect(mac);
      await pumpEventQueue();
      http.sent.clear();
    }

    test('re-reads the host, which is the only way projects ever refresh', () async {
      await connected();
      expect(store.projects, isEmpty);
      http.enqueue(bootstrapFor(mac));

      sockets.channels.single.emit(helloFrom(mac));
      await pumpEventQueue();

      // `projects[]` rides only on `GET /m/bootstrap`; the live socket carries
      // `fleet.changed`, which is cells and nothing else. Without this a project
      // opened on the machine after cold start stayed invisible until the app was
      // killed and reopened (ADR-14, `issues/09`).
      expect(http.last.uri.path, '/m/bootstrap');
      expect(
        store.projects.map((p) => p.workspaceId),
        containsAll(['ws-lotus', 'ws-terax']),
      );
    });

    test('a second hello while one is still in flight is dropped', () async {
      await connected();
      // The host is slow, which is the state this guard is about: a socket having a
      // bad time says `hello` on every attach, and each one starting its own
      // bootstrap would pile requests onto a machine that is already struggling.
      http.holdNext();
      http.enqueue(bootstrapFor(mac));

      sockets.channels.single
        ..emit(helloFrom(mac))
        ..emit(helloFrom(mac))
        ..emit(helloFrom(mac));
      await pumpEventQueue();

      expect(http.sent.where((r) => r.uri.path == '/m/bootstrap'), hasLength(1));

      http.release();
      await pumpEventQueue();
    });
  });

  test('fills the store from every paired host, in one pass', () async {
    registry
      ..add(host(mac))
      ..add(host(vps));
    await credentials.remember(device(mac));
    await credentials.remember(device(vps));
    http
      ..enqueue(bootstrapFor(mac, panes: const ['p-1', 'p-2']))
      ..enqueue(bootstrapFor(vps, panes: const ['p-9']));

    final report = await repository.hydrate();

    expect(report.complete, isTrue);
    expect(report.answered, containsAll([mac, vps]));
    expect(store.cells, hasLength(3));
    expect(store.cells.map((c) => c.host).toSet(), {mac, vps});
  });

  test('asks for the whole fleet, never one project', () async {
    registry.add(host(mac));
    await credentials.remember(device(mac));
    http.enqueue(bootstrapFor(mac));

    await repository.hydrate();

    // The route filters its cells when given a `workspaceId`, and the `elsewhere` row
    // exists precisely to show a waiting agent in *another* project (ADR-3, second
    // revision). A filtered cold start cannot build it.
    expect(http.last.uri.queryParameters, isEmpty);
    expect(http.last.uri.path, '/m/bootstrap');
  });

  test('the merged order is the one Home and the pager share', () async {
    registry
      ..add(host(mac))
      ..add(host(vps));
    await credentials.remember(device(mac));
    await credentials.remember(device(vps));
    http
      ..enqueue(bootstrapFor(mac, panes: const ['p-1']))
      ..enqueue(bootstrapFor(vps, panes: const ['p-9'], waiting: 'p-9'));

    await repository.hydrate();

    // Ordering is computed in one place (ADR-12 no. 1), so a cold start cannot produce
    // a different order than the socket updates that follow it.
    expect(store.cells.first.host, vps);
    expect(store.cells.first.needsInput, isTrue);
  });

  test('a host that answers is not held up by one that does not', () async {
    registry
      ..add(host(mac))
      ..add(host(vps));
    await credentials.remember(device(mac));
    await credentials.remember(device(vps));
    // The first host asked is the sleeping one.
    http.failWith = const TransportUnavailable('asleep', cause: TransportCause.timedOut);

    final report = await repository.hydrate();

    // R-11: the screen must not wait on the slowest machine. Both are reported, and
    // neither failure removes the other's answer.
    expect(report.complete, isFalse);
    expect(report.failed[mac], isA<HostAsleep>());
    expect(report.failed[vps], isA<HostAsleep>());
  });

  test('a sleeping host is marked stale rather than emptied', () async {
    registry.add(host(mac));
    await credentials.remember(device(mac));
    http.enqueue(bootstrapFor(mac, panes: const ['p-1']));
    await repository.hydrate();
    expect(store.cells, hasLength(1));

    // Second pass: the mac has since gone to sleep.
    http.failWith = const TransportUnavailable('asleep', cause: TransportCause.timedOut);
    final report = await repository.hydrate();

    expect(report.answered, isEmpty);
    // R-9: a fleet that suddenly empties reads as "all my work is gone".
    expect(store.cells, hasLength(1));
    expect(store.isStale(mac), isTrue);
  });

  test('a refused connection is Lotus not running, not a sleeping machine', () async {
    registry.add(host(mac));
    await credentials.remember(device(mac));
    http.failWith = const TransportUnavailable('refused', cause: TransportCause.refused);

    final report = await repository.hydrate();

    expect(report.failed[mac], isA<LotusNotRunning>());
  });

  test('a 401 is diagnosed by the layer that owns the clock', () async {
    registry.add(host(mac));
    await credentials.remember(device(mac));
    http.enqueue('{"error":"Unauthorized"}', status: 401);

    final report = await repository.hydrate();

    // Token still inside its TTL, so it was revoked rather than aged out.
    expect(report.failed[mac], isA<CredentialRevoked>());
    expect(registry.statusOf(mac)!.failure, isA<CredentialRevoked>());
  });

  test('a host answering as someone else is refused, not merged', () async {
    registry.add(host(mac));
    await credentials.remember(device(mac));
    // The tailnet name now points at the VPS.
    http.enqueue(bootstrapFor(vps));

    final report = await repository.hydrate();

    // Filing the VPS's cells under `mac` would put them behind a socket that is not
    // theirs, and R-10's wrong-repo dispatch is one tap away.
    expect(report.failed.containsKey(mac), isTrue);
    expect(store.cells, isEmpty);
  });

  test('with nothing paired there is nothing to report', () async {
    final report = await repository.hydrate();

    expect(report.complete, isTrue);
    expect(report.anyAnswered, isFalse);
    expect(http.sent, isEmpty);
  });
}
