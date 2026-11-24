import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/core/transport.dart';
import 'package:lotus_pocket/data/fleet_store.dart';
import 'package:lotus_pocket/hosts/host_failure.dart';
import 'package:lotus_pocket/hosts/host_registry.dart';
import 'package:lotus_pocket/hosts/paired_host.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/host_id.dart';

import '../support/fake_transport.dart';

const HostId mac = HostId('mac');
const HostId vps = HostId('vps');

PairedHost host(HostId id, {String mode = 'client', List<String>? features}) => PairedHost(
      id: id,
      label: id.value,
      baseUri: Uri.parse('ws://${id.value}:8787'),
      mode: mode,
      caps: HostCaps(
        protocol: 1,
        features: features ?? const ['fleet', 'stream', 'transcript', 'permission', 'stt'],
      ),
    );

Map<String, Object?> fleetFrame(String paneId, {String? turn}) => {
      'type': 'fleet.changed',
      'cells': [
        {
          'paneId': paneId,
          'workspaceId': 'CNVS',
          'agentType': 'claude',
          'title': 'Atlas',
          'status': 'live',
          'isAlive': true,
          'turn': ?turn,
        }
      ],
    };

void main() {
  late FakeTransport transport;
  late FakeHttpTransport httpTransport;
  late HostRegistry registry;

  setUp(() {
    transport = FakeTransport();
    httpTransport = FakeHttpTransport();
    registry = HostRegistry(
      transport: transport,
      httpTransport: httpTransport,
      tokenReader: (h) => 'tok-${h.value}',
      sleep: (_) async {},
    );
  });

  tearDown(() => registry.dispose());

  group('fan-out', () {
    test('each host gets its own socket, with its own token', () async {
      registry
        ..add(host(mac))
        ..add(host(vps));

      registry.connectAll();
      await pumpEventQueue();

      final tokens = transport.opened.map((u) => u.queryParameters['token']).toSet();
      expect(tokens, {'tok-mac', 'tok-vps'});
    });

    test('frames from both hosts arrive on one stream, tagged', () async {
      final seen = <String>[];
      registry.events.listen((e) => seen.add(e.$1.value));
      registry
        ..add(host(mac))
        ..add(host(vps));
      registry.connectAll();
      await pumpEventQueue();

      transport.channels[0].emit(fleetFrame('p-1'));
      transport.channels[1].emit(fleetFrame('p-1'));
      await pumpEventQueue();

      expect(seen, ['mac', 'vps']);
    });

    /// The wiring ADR-12 describes, end to end and with no host in sight: two
    /// sockets, one merged list, ordered once.
    test('a FleetStore fed by the registry merges both hosts', () async {
      final store = FleetStore(registry.events);
      registry
        ..add(host(mac))
        ..add(host(vps));
      registry.connectAll();
      await pumpEventQueue();

      transport.channels[0].emit(fleetFrame('p-1'));
      transport.channels[1].emit(fleetFrame('p-1', turn: 'needs-input'));
      await pumpEventQueue();

      expect(store.cells, hasLength(2));
      // Waiting first, whichever host it is on.
      expect(store.cells.first.host, vps);
      store.dispose();
    });
  });

  group('re-pairing a host already here', () {
    /// The ordinary way back in: a token past its 72-hour TTL cannot be refreshed, so
    /// onboarding pairs the same host again. `Credentials` keeps the entry so that
    /// screen can name which host it is — which means `add` meets a host it already
    /// has, and must not simply overwrite the maps.
    test('does not leave a second subscription delivering every frame twice',
        () async {
      final seen = <String>[];
      registry.events.listen((e) => seen.add(e.$1.value));
      registry.add(host(mac));
      registry.connectAll();
      await pumpEventQueue();

      registry.add(host(mac));
      registry.connectAll();
      await pumpEventQueue();

      transport.current.emit(fleetFrame('p-1'));
      await pumpEventQueue();

      // One frame, one event. Doubling here would double every cell in `FleetStore`.
      expect(seen, ['mac']);
    });

    test('closes the socket that was dialling with the dead token', () async {
      registry.add(host(mac));
      registry.connectAll();
      await pumpEventQueue();
      final first = transport.current;

      registry.add(host(mac));
      await pumpEventQueue();

      // Left open, it would keep retrying with a credential the host has already
      // refused — and count against nothing but the operator's battery.
      expect(first.closedByClient, isTrue);
    });

    test('the host is listed once, with its new address', () async {
      registry.add(host(mac));
      registry.add(PairedHost(
        id: mac,
        label: 'MacBook',
        baseUri: Uri.parse('http://100.64.0.9:8787'),
        mode: 'client',
        caps: const HostCaps(protocol: 1, features: ['fleet']),
      ));

      expect(registry.hosts, hasLength(1));
      expect(registry.statusOf(mac)!.host.baseUri.host, '100.64.0.9');
      expect(registry.apiFor(mac)!.baseUri.host, '100.64.0.9');
    });
  });

  group('one paired host is one thing', () {
    test('a paired host gets an HTTP surface too, carrying its own token', () async {
      registry.add(host(mac));

      final api = registry.apiFor(mac);
      expect(api, isNotNull);

      httpTransport.enqueue('{"ok":true}');
      await api!.dispatch('p-1', 'run the tests');

      // Same credential as the socket, resolved in one place rather than two.
      expect(httpTransport.last.bearer, 'Bearer tok-mac');
      expect(httpTransport.last.uri.path, '/m/cell/p-1/dispatch');
    });

    test('a host that was never paired has no API to hand out', () {
      expect(registry.apiFor(vps), isNull);
    });
  });

  group('hello is the current truth about a host', () {
    Map<String, Object?> helloFrame({required String mode, required List<String> features}) => {
          'type': 'hello',
          'hostId': 'mac',
          'hostLabel': 'MacBook Pro',
          'mode': mode,
          'hostCaps': {'protocol': 1, 'features': features},
        };

    test('capabilities gained since pairing become visible', () async {
      // Paired when the desktop had no hook pipeline, so Chat was rightly hidden.
      registry.add(host(mac, features: const ['fleet', 'stream']));
      expect(registry.statusOf(mac)!.host.hasChat, isFalse);

      registry.connect(mac);
      await pumpEventQueue();
      transport.channels[0].emit(
        helloFrame(mode: 'client', features: const ['fleet', 'stream', 'transcript', 'permission']),
      );
      await pumpEventQueue();

      // Deciding from what was advertised at pairing time would keep Chat hidden on a
      // desktop that has since gained it.
      expect(registry.statusOf(mac)!.host.hasChat, isTrue);
      expect(registry.statusOf(mac)!.host.label, 'MacBook Pro');
    });

    test('capabilities lost since pairing stop being offered', () async {
      registry.add(host(mac));
      expect(registry.statusOf(mac)!.host.canTranscribe, isTrue);

      registry.connect(mac);
      await pumpEventQueue();
      // The same machine redeployed as a Standalone Host: no hook pipeline, no STT.
      transport.channels[0].emit(
        helloFrame(mode: 'standalone', features: const ['fleet', 'stream', 'dispatch']),
      );
      await pumpEventQueue();

      final host_ = registry.statusOf(mac)!.host;
      expect(host_.canTranscribe, isFalse);
      expect(host_.hasChat, isFalse);
      expect(host_.isStandalone, isTrue);
    });

    test('the base URI is not taken from the frame', () async {
      registry.add(host(mac));
      final before = registry.statusOf(mac)!.host.baseUri;

      registry.connect(mac);
      await pumpEventQueue();
      transport.channels[0].emit(helloFrame(mode: 'client', features: const ['fleet']));
      await pumpEventQueue();

      // Where a host lives is what the operator paired with; a frame arriving over
      // that very connection cannot be the authority on it.
      expect(registry.statusOf(mac)!.host.baseUri, before);
    });
  });

  group('naming the cause', () {
    /// Failures here are transient by design: with a retry behind them, the status
    /// heals as soon as a connection lands. So the diagnosis is observed **as it is
    /// reported**, which is also how the UI sees it.
    List<String?> watchFailures() {
      final seen = <String?>[];
      registry.addListener(() => seen.add(registry.statusOf(mac)?.failure?.code));
      return seen;
    }

    test('a refused connection means Lotus is not running, not that the mac slept',
        () async {
      transport
        ..failFirst = 1
        ..failWith = TransportCause.refused;
      registry.add(host(mac));
      final seen = watchFailures();

      registry.connect(mac);
      await pumpEventQueue();

      expect(seen, contains('lotus_not_running'));
    });

    test('silence means the host is asleep', () async {
      transport
        ..failFirst = 1
        ..failWith = TransportCause.timedOut;
      registry.add(host(mac));
      final seen = watchFailures();

      registry.connect(mac);
      await pumpEventQueue();

      expect(seen, contains('host_asleep'));
    });

    test('no route means the tailnet', () async {
      transport
        ..failFirst = 1
        ..failWith = TransportCause.unroutable;
      registry.add(host(mac));
      final seen = watchFailures();

      registry.connect(mac);
      await pumpEventQueue();

      expect(seen, contains('tailnet_down'));
    });

    /// A cause can change between attempts — a machine that refuses, then sleeps.
    /// Reporting only the first would leave the operator fixing yesterday's problem.
    test('a later attempt can change the diagnosis', () async {
      transport
        ..failFirst = 2
        ..failWith = TransportCause.refused
        ..failWithAfterFirst = TransportCause.timedOut;
      registry.add(host(mac));
      final seen = watchFailures();

      registry.connect(mac);
      await pumpEventQueue();

      expect(seen.indexOf('lotus_not_running'), lessThan(seen.indexOf('host_asleep')));
    });

    test('connecting clears the failure rather than leaving it on screen', () async {
      transport
        ..failFirst = 1
        ..failWith = TransportCause.refused;
      registry.add(host(mac));

      registry.connect(mac);
      await pumpEventQueue();

      final status = registry.statusOf(mac)!;
      expect(status.connected, isTrue);
      expect(status.failure, isNull);
    });

    /// The same 401 means two different things, and only the clock separates them.
    test('401 is expired or revoked depending on the token, not the status code', () {
      registry.add(host(mac));

      registry.reportUnauthorized(mac, tokenStillValid: false);
      expect(registry.statusOf(mac)!.failure, isA<CredentialExpired>());

      registry.reportUnauthorized(mac, tokenStillValid: true);
      expect(registry.statusOf(mac)!.failure, isA<CredentialRevoked>());
    });
  });

  /// Dart drops the status of a refused WebSocket upgrade, so the registry asks over
  /// HTTP — where the 401 survives — before telling the operator to re-pair.
  group('a refused upgrade is diagnosed over HTTP', () {
    late bool usable;
    late HostRegistry diagnosing;
    // Holds the socket's backoff, so the diagnosis lands before any retry could.
    late Completer<void> backoff;

    setUp(() {
      usable = false;
      backoff = Completer<void>();
      transport
        ..failFirst = 1
        ..failWith = TransportCause.rejected;
      diagnosing = HostRegistry(
        transport: transport,
        httpTransport: httpTransport,
        tokenReader: (h) => 'tok-${h.value}',
        sleep: (_) => backoff.future,
        tokenStillValid: (_) => usable,
      );
    });

    tearDown(() => diagnosing.dispose());

    test('a 401 past the TTL is an expired credential, and the socket stops', () async {
      httpTransport.enqueue('{"error":"Unauthorized"}', status: 401);
      diagnosing.add(host(mac));

      diagnosing.connect(mac);
      await pumpEventQueue();

      expect(httpTransport.last.uri.path, '/m/devices');
      expect(httpTransport.last.bearer, 'Bearer tok-mac');
      expect(diagnosing.statusOf(mac)!.failure, isA<CredentialExpired>());
      expect(diagnosing.statusOf(mac)!.connected, isFalse);

      // One refused attempt, then nothing: retrying a dead token only blurs the verdict.
      backoff.complete();
      await pumpEventQueue();
      expect(transport.opened, hasLength(1));
      expect(diagnosing.statusOf(mac)!.failure, isA<CredentialExpired>());
    });

    test('a 401 inside the TTL is a revoked credential', () async {
      usable = true;
      httpTransport.enqueue('{"error":"Unauthorized"}', status: 401);
      diagnosing.add(host(mac));

      diagnosing.connect(mac);
      await pumpEventQueue();

      expect(diagnosing.statusOf(mac)!.failure, isA<CredentialRevoked>());
    });

    test('a host that still takes the bearer leaves the refusal as it was', () async {
      // The credential is fine, so whatever refused the upgrade was not the token —
      // and the socket keeps retrying, which here lets it connect.
      diagnosing.add(host(mac));
      final seen = <String?>[];
      diagnosing.addListener(() => seen.add(diagnosing.statusOf(mac)?.failure?.code));

      diagnosing.connect(mac);
      await pumpEventQueue();
      backoff.complete();
      await pumpEventQueue();

      expect(seen, contains('host_refused'));
      expect(seen, isNot(contains('credential_expired')));
      expect(diagnosing.statusOf(mac)!.connected, isTrue);
    });

    test('is skipped when nothing can tell expired from revoked', () async {
      registry.add(host(mac));

      registry.connect(mac);
      await pumpEventQueue();

      expect(httpTransport.sent, isEmpty);
    });
  });

  group('lifecycle', () {
    test('going to background closes every socket on purpose', () async {
      registry
        ..add(host(mac))
        ..add(host(vps));
      registry.connectAll();
      await pumpEventQueue();

      await registry.closeAll();

      expect(transport.channels.every((c) => c.closedByClient), isTrue);
      expect(registry.statuses.every((s) => !s.connected), isTrue);
    });

    test('coming back opens fresh connections', () async {
      registry.add(host(mac));
      registry.connectAll();
      await pumpEventQueue();
      await registry.closeAll();

      registry.connectAll();
      await pumpEventQueue();

      expect(transport.opened, hasLength(2));
      expect(registry.statusOf(mac)!.connected, isTrue);
    });
  });

  group('what a host can do', () {
    test('a standalone host reports no Chat, so the UI can decide before opening', () {
      final vpsHost = host(vps, mode: 'standalone', features: const ['fleet', 'stream']);

      expect(vpsHost.isStandalone, isTrue);
      expect(vpsHost.hasChat, isFalse);
      expect(vpsHost.canTranscribe, isFalse);
    });

    /// Asked of the capabilities, not derived from the mode: a desktop older than
    /// those routes must be handled the same way as a VPS.
    test('a desktop that predates the Chat routes is treated like one without them', () {
      final oldDesktop = host(mac, features: const ['fleet', 'stream', 'dispatch']);

      expect(oldDesktop.isStandalone, isFalse);
      expect(oldDesktop.hasChat, isFalse);
    });
  });
}
