import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/core/host_socket.dart';
import 'package:lotus_pocket/core/transport.dart';
import 'package:lotus_pocket/core/ws_transport.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/server_event.dart';

/// The one test here that touches a real socket.
///
/// Everything above `Transport` is proven with a fake, which is the point of the
/// seam — but a seam with nothing real behind it is an untested assumption. This
/// runs an actual WebSocket server, so the package choice, the query-string token,
/// and the close signal are all exercised for real.
void main() {
  late HttpServer server;
  late Uri uri;
  final List<String> received = [];
  final List<Uri> handshakes = [];
  WebSocket? peer;

  setUp(() async {
    received.clear();
    handshakes.clear();
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    uri = Uri.parse('ws://127.0.0.1:${server.port}');
    server.listen((request) async {
      handshakes.add(request.uri);
      final socket = await WebSocketTransformer.upgrade(request);
      peer = socket;
      socket.listen(
        (data) => received.add(data as String),
        onDone: () {},
        cancelOnError: true,
      );
    });
  });

  tearDown(() async {
    await peer?.close();
    await server.close(force: true);
  });

  test('opens a real socket and carries the token in the query string', () async {
    const transport = WebSocketTransport();

    final channel = await transport.open(uri.replace(
      path: '/m/stream',
      queryParameters: {'token': 'tok-1'},
    ));

    expect(handshakes.single.path, '/m/stream');
    expect(handshakes.single.queryParameters['token'], 'tok-1');
    await channel.close();
  });

  test('frames travel both ways', () async {
    const transport = WebSocketTransport();
    final channel = await transport.open(uri);
    final inbound = <String>[];
    channel.messages.listen(inbound.add);

    channel.send('{"type":"ping"}');
    await Future<void>.delayed(const Duration(milliseconds: 50));
    peer!.add('{"type":"chat.token","requestId":"r1","token":"hi"}');
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(received, ['{"type":"ping"}']);
    expect(inbound, hasLength(1));
    await channel.close();
  });

  test('the closed future completes when the server hangs up', () async {
    const transport = WebSocketTransport();
    final channel = await transport.open(uri);
    channel.messages.listen((_) {});
    var done = false;
    unawaited(channel.closed.then((_) => done = true));

    await peer!.close();
    await Future<void>.delayed(const Duration(milliseconds: 50));

    expect(done, isTrue, reason: 'HostSocket only reconnects because it learns this');
  });

  /// The distinction the whole `HostFailure` taxonomy rests on, measured rather than
  /// assumed: nothing listening on a closed port **refuses**, and that is what tells
  /// "Lotus is not running" apart from "the machine is asleep".
  test('a closed port is reported as refused, not as a timeout', () async {
    final closed = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final deadUri = Uri.parse('ws://127.0.0.1:${closed.port}');
    await closed.close();
    const transport = WebSocketTransport();

    await expectLater(
      transport.open(deadUri),
      throwsA(isA<TransportUnavailable>()
          .having((e) => e.cause, 'cause', TransportCause.refused)),
    );
  });

  test('an address with no route is reported as unroutable', () async {
    const transport = WebSocketTransport(connectTimeout: Duration(seconds: 2));

    await expectLater(
      transport.open(Uri.parse('ws://host.invalid.example:9999')),
      throwsA(isA<TransportUnavailable>().having(
        (e) => e.cause,
        'cause',
        anyOf(TransportCause.unroutable, TransportCause.timedOut),
      )),
    );
  });

  /// End to end over a real socket: `HostSocket` parses what the host sends, tracks
  /// the offset, and asks for exactly the missed bytes after a drop.
  test('HostSocket resumes from the last byte after a real disconnect', () async {
    final socket = HostSocket(
      host: const HostId('mac'),
      baseUri: uri,
      token: () => 'tok-1',
      transport: const WebSocketTransport(),
      sleep: (_) async {},
    );
    final events = <ServerEvent>[];
    socket.events.listen(events.add);

    await socket.connect();
    socket.subscribe('p-1');
    await Future<void>.delayed(const Duration(milliseconds: 50));
    peer!.add('{"type":"cell.output","paneId":"p-1","chunk":"npm test\\n","byteOffset":4096}');
    await Future<void>.delayed(const Duration(milliseconds: 50));

    await peer!.close();
    await Future<void>.delayed(const Duration(milliseconds: 200));

    expect(events.single, isA<CellOutputEvent>());
    expect(received, contains('{"type":"resume","paneId":"p-1","fromByte":4096}'));
    socket.dispose();
  });
}
