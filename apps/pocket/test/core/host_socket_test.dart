import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/core/host_socket.dart';
import 'package:lotus_pocket/core/transport.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/server_event.dart';

import '../support/fake_transport.dart';

const HostId mac = HostId('mac');

void main() {
  late FakeTransport transport;
  late List<Duration> slept;
  late HostSocket socket;

  /// Sleeping is injected so backoff is asserted, not waited out.
  Future<void> sleeper(Duration d) async => slept.add(d);

  setUp(() {
    transport = FakeTransport();
    slept = [];
    socket = HostSocket(
      host: mac,
      // The address a paired host actually carries: what the operator typed into
      // onboarding, which is `http`. Every test here used to hand over a hand-made
      // `ws://` base — and so did `tool/smoke.dart` — which is precisely why the
      // scheme bug below could reach a live host unnoticed.
      baseUri: Uri.parse('http://100.64.0.2:8787'),
      token: () => 'tok-1',
      transport: transport,
      sleep: sleeper,
    );
  });

  tearDown(() => socket.dispose());

  Map<String, Object?> output(String pane, String chunk, int offset) => {
        'type': 'cell.output',
        'paneId': pane,
        'chunk': chunk,
        'byteOffset': offset,
      };

  group('connecting', () {
    test('close() while the handshake is pending leaves no live socket behind', () async {
      final gate = Completer<void>();
      final slow = _GatedTransport(gate.future);
      final held = HostSocket(
        host: mac,
        baseUri: Uri.parse('http://100.64.0.2:8787'),
        token: () => 'tok-1',
        transport: slow,
        sleep: sleeper,
      );

      final pending = held.connect();
      await Future<void>.delayed(Duration.zero);
      await held.close();
      gate.complete();
      await pending;

      expect(held.isConnected, isFalse);
      expect(slow.channels.single.closedByClient, isTrue);
      held.dispose();
    });

    test('close() cancels a reconnect already scheduled by a drop', () async {
      await socket.connect();
      transport.current.dropped();
      await Future<void>.microtask(() {}); // _onClosed has now scheduled its redial

      await socket.close();
      await Future<void>.delayed(Duration.zero);

      expect(transport.opened, hasLength(1));
      expect(socket.isConnected, isFalse);
    });

    test('overlapping connect callers share one dial/backoff loop', () async {
      transport.failFirst = 2;
      final waits = <Completer<void>>[];
      final held = HostSocket(
        host: mac,
        baseUri: Uri.parse('http://100.64.0.2:8787'),
        token: () => 'tok-1',
        transport: transport,
        sleep: (_) {
          final gate = Completer<void>();
          waits.add(gate);
          return gate.future;
        },
      );

      final first = held.connect();
      final second = held.connect();
      await Future<void>.delayed(Duration.zero);

      // A second caller must join the pending connect, not start its own loop.
      expect(transport.opened, hasLength(1));
      expect(waits, hasLength(1));

      held.dispose();
      for (final gate in waits) {
        gate.complete();
      }
      await Future.wait([first, second]);
    });

    test('two overlapping connect() calls leave exactly one live channel', () async {
      // A drop's reconnect and the app's own connect() can race: both pass the
      // `_channel == null` check, both open, both attach — and every frame is then
      // delivered twice.
      await Future.wait([socket.connect(), socket.connect()]);

      expect(transport.channels.where((c) => !c.closedByClient), hasLength(1));
    });

    test('dials ws:// even though the host was paired over http://', () async {
      await socket.connect();

      // `WebSocketChannel.connect` refuses anything else outright — *"only ws: and
      // wss: schemes are supported"*. Without this the socket cannot open at all,
      // which is what a live host proved on 2026-08-06: pairing succeeded over HTTP
      // and no stream connection ever existed.
      expect(transport.opened.single.scheme, 'ws');
    });

    test('a host behind TLS is dialled over wss://', () async {
      final secure = HostSocket(
        host: mac,
        baseUri: Uri.parse('https://lotus.example.com:8443'),
        token: () => 'tok-1',
        transport: transport,
        sleep: sleeper,
      );

      await secure.connect();

      // The VPS case (ADR-3): downgrading to `ws` here would send a device token
      // over the open internet in clear text.
      expect(transport.opened.single.scheme, 'wss');
      secure.dispose();
    });

    test('carries the token in the query string, never a header', () async {
      await socket.connect();

      final uri = transport.opened.single;
      expect(uri.path, '/m/stream');
      // Browsers cannot send headers on a WebSocket at all (ADR-10), so this is
      // the property that keeps a Flutter web build possible.
      expect(uri.queryParameters['token'], 'tok-1');
    });

    test('reads the token per connection, so a refresh is picked up', () async {
      var current = 'tok-1';
      final refreshing = HostSocket(
        host: mac,
        baseUri: Uri.parse('ws://h:1'),
        token: () => current,
        transport: transport,
        sleep: sleeper,
      );

      await refreshing.connect();
      current = 'tok-2';
      transport.current.dropped();
      await pumpEventQueue();

      expect(transport.opened.last.queryParameters['token'], 'tok-2');
      refreshing.dispose();
    });

    test('surfaces frames as typed events, host identity attached', () async {
      final seen = <ServerEvent>[];
      socket.events.listen(seen.add);
      await socket.connect();

      transport.current.emit({
        'type': 'fleet.changed',
        'cells': [
          {
            'paneId': 'p-1',
            'workspaceId': 'ws',
            'agentType': 'claude',
            'title': 'Atlas',
            'status': 'live',
            'isAlive': true,
          }
        ],
      });
      await pumpEventQueue();

      final fleet = seen.single as FleetChangedEvent;
      expect(fleet.cells.single.ref.toString(), 'mac/p-1');
    });

    test('skips a frame it does not know instead of tearing down the stream', () async {
      final seen = <ServerEvent>[];
      socket.events.listen(seen.add);
      await socket.connect();

      transport.current
        ..emit({'type': 'quantum.entangled'})
        // A frame this app once knew and no longer does: `chat.token` was removed on
        // 2026-08-06 because nothing ever published it. A host still sending it must be
        // tolerated, not fatal — that is ADR-10's rule in both directions.
        ..emit({'type': 'chat.token', 'requestId': 'r1', 'token': 'hi'})
        ..emit({'type': 'cell.truncated', 'paneId': 'p-1', 'requestedFromByte': 0, 'servedFromByte': 9});
      await pumpEventQueue();

      expect(seen, hasLength(1));
      expect(seen.single, isA<CellTruncatedEvent>());
    });
  });

  group('subscribing and resuming', () {
    test('subscribe names the pane, and null detaches', () async {
      await socket.connect();

      socket.subscribe('p-1');
      socket.subscribe(null);

      expect(transport.current.sent, [
        {'type': 'subscribe', 'paneId': 'p-1'},
        {'type': 'subscribe', 'paneId': null},
      ]);
    });

    /// The point of tracking offsets: after a drop, the app must ask for what it
    /// missed rather than for everything (the ring buffer is only 64 KB) or for
    /// nothing (a silent hole in the transcript).
    test('a reconnect resumes the subscribed pane from the last byte seen', () async {
      await socket.connect();
      socket.subscribe('p-1');
      transport.current
        ..emit(output('p-1', 'npm test\n', 4096))
        ..emit(output('p-1', 'ok\n', 4099));
      await pumpEventQueue();

      transport.current.dropped();
      await pumpEventQueue();

      // `contains` on a List compares with ==, and two equal Maps are not == —
      // so the expectation has to be a matcher, not a literal.
      expect(transport.current.sent,
          contains(equals({'type': 'resume', 'paneId': 'p-1', 'fromByte': 4099})));
    });

    test('an offset from another pane is not used to resume this one', () async {
      await socket.connect();
      socket.subscribe('p-1');
      transport.current
        ..emit(output('p-2', 'other pane\n', 9999))
        ..emit(output('p-1', 'mine\n', 12));
      await pumpEventQueue();

      transport.current.dropped();
      await pumpEventQueue();

      expect(transport.current.sent,
          contains(equals({'type': 'resume', 'paneId': 'p-1', 'fromByte': 12})));
    });

    test('with nothing subscribed, a reconnect asks for no backfill at all', () async {
      await socket.connect();
      transport.current.dropped();
      await pumpEventQueue();

      expect(transport.current.sent, isEmpty);
    });
  });

  group('reconnecting', () {
    test('backs off, and the delay grows rather than hammering the host', () async {
      transport.failFirst = 3;

      await socket.connect();

      expect(slept, [
        const Duration(milliseconds: 500),
        const Duration(seconds: 1),
        const Duration(seconds: 2),
      ]);
      expect(socket.isConnected, isTrue);
    });

    test('the delay is capped, so a host that sleeps all night is still polled', () async {
      transport.failFirst = 8;

      await socket.connect();

      expect(slept.last, HostSocket.maxBackoff);
      expect(slept.every((d) => d <= HostSocket.maxBackoff), isTrue);
    });

    /// A WebSocket does not reconnect itself, unlike EventSource — so this is our
    /// job, and `dispose` must be the one thing that stops it. Otherwise closing a
    /// screen leaves a socket reopening forever in the background.
    test('dispose stops reconnecting for good', () async {
      await socket.connect();

      socket.dispose();
      transport.current.dropped();
      await pumpEventQueue();

      expect(transport.opened, hasLength(1));
    });

    test('closing for background is deliberate, and does not reconnect', () async {
      await socket.connect();

      await socket.close();
      await pumpEventQueue();

      expect(transport.current.closedByClient, isTrue);
      expect(transport.opened, hasLength(1));
      expect(socket.isConnected, isFalse);
    });

    test('reopening after a background close starts a fresh connection', () async {
      await socket.connect();
      await socket.close();

      await socket.connect();

      expect(transport.opened, hasLength(2));
      expect(socket.isConnected, isTrue);
    });
  });

  group('a host that answers and refuses', () {
    test('gives up instead of retrying a refusal for ever', () async {
      // A refused upgrade is not a sleeping machine. Retrying it on the same ladder
      // hides the cause behind a spinner, and the comment on `_tokenReader` already
      // named this exact hazard: "a socket that reopens with the stale token would
      // 401 forever". Bounded rather than zero because Dart drops the status code —
      // a host restarting behind a 502 is indistinguishable from a dead credential,
      // and one of those clears itself.
      transport.failFirst = 1000;
      transport.failWith = TransportCause.rejected;

      await socket.connect().timeout(const Duration(seconds: 5));

      expect(socket.isConnected, isFalse);
      expect(transport.opened.length, HostSocket.maxRejectedAttempts);
    });

    test('reports the cause on every attempt, so it is never a silent spinner', () async {
      final causes = <TransportCause>[];
      final s = HostSocket(
        host: mac,
        baseUri: Uri.parse('http://100.64.0.2:8787'),
        token: () => 'tok-1',
        transport: transport,
        sleep: sleeper,
        onAttemptFailed: (f) => causes.add(f.cause),
      );
      addTearDown(s.dispose);
      transport.failFirst = 1000;
      transport.failWith = TransportCause.rejected;

      await s.connect().timeout(const Duration(seconds: 5));

      expect(causes, everyElement(TransportCause.rejected));
      expect(causes, isNotEmpty);
    });

    test('still retries a sleeping host without limit', () async {
      // The bound is for refusals only. A host that never answers is the state this
      // app lives in, and giving up on it would be a regression.
      transport.failFirst = 12;
      transport.failWith = TransportCause.timedOut;

      await socket.connect().timeout(const Duration(seconds: 5));

      expect(socket.isConnected, isTrue);
      expect(transport.opened.length, 13);
    });
  });
}

/// A transport whose handshake the test releases by hand.
class _GatedTransport extends FakeTransport {
  _GatedTransport(this.gate);

  final Future<void> gate;

  @override
  Future<MessageChannel> open(Uri uri) async {
    final channel = await super.open(uri);
    await gate;
    return channel;
  }
}
