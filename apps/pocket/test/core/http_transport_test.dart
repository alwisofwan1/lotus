import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/core/http_transport.dart';
import 'package:lotus_pocket/core/transport.dart';

/// The HTTP twin of `ws_transport_test`: the one place a real request is made.
///
/// Everything above `HttpTransport` is proven with a fake against
/// `contract/fixtures/`, which is the point of the seam — but a seam with nothing
/// real behind it is an untested assumption. So the package choice, the bearer
/// header, the body round-trip, and the failure classification are exercised for
/// real here, once.
void main() {
  late HttpServer server;
  late Uri baseUri;
  final List<HttpRequest> seen = [];
  final List<String> bodies = [];

  /// What the next request is answered with. Set per test.
  int status = 200;
  String reply = '{}';
  Duration delay = Duration.zero;

  setUp(() async {
    seen.clear();
    bodies.clear();
    status = 200;
    reply = '{}';
    delay = Duration.zero;

    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    baseUri = Uri.parse('http://127.0.0.1:${server.port}');
    server.listen((request) async {
      seen.add(request);
      bodies.add(await utf8.decoder.bind(request).join());
      if (delay > Duration.zero) await Future<void>.delayed(delay);
      request.response.statusCode = status;
      request.response.headers.contentType = ContentType.json;
      request.response.write(reply);
      await request.response.close();
    });
  });

  tearDown(() async => server.close(force: true));

  test('carries method, path, headers and body to a real server', () async {
    final transport = PackageHttpTransport();
    reply = '{"ok":true}';

    final result = await transport.send(
      method: 'POST',
      uri: baseUri.replace(path: '/m/cell/p-1/dispatch'),
      headers: const {
        'Authorization': 'Bearer tok-1',
        'Content-Type': 'application/json',
      },
      body: '{"text":"run the tests"}',
    );

    expect(seen.single.method, 'POST');
    expect(seen.single.uri.path, '/m/cell/p-1/dispatch');
    expect(seen.single.headers.value('authorization'), 'Bearer tok-1');
    expect(bodies.single, '{"text":"run the tests"}');
    expect(result.status, 200);
    expect(result.body, '{"ok":true}');
    transport.close();
  });

  test('the bearer rides a header here, unlike the socket that must use a query', () async {
    final transport = PackageHttpTransport();

    await transport.send(
      method: 'GET',
      uri: baseUri.replace(path: '/m/bootstrap'),
      headers: const {'Authorization': 'Bearer tok-2'},
    );

    // ADR-10 puts the token in `?token=` on the WS upgrade only because browsers
    // cannot set headers there. HTTP has no such excuse, so a token in the query
    // string would leak into logs for no reason.
    expect(seen.single.uri.queryParameters, isEmpty);
    expect(seen.single.headers.value('authorization'), 'Bearer tok-2');
    transport.close();
  });

  test('a non-2xx status comes back as a reply, not as a throw', () async {
    final transport = PackageHttpTransport();
    status = 401;
    reply = '{"error":"Unauthorized"}';

    final result = await transport.send(method: 'GET', uri: baseUri.replace(path: '/m/bootstrap'));

    // 401 and 404 are answers this app acts on. A seam that threw would force
    // `HostApi` to reconstruct the status from an exception.
    expect(result.status, 401);
    expect(result.isOk, isFalse);
    expect(result.body, contains('Unauthorized'));
    transport.close();
  });

  test('a closed port is reported as refused, not as a timeout', () async {
    final free = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    final port = free.port;
    await free.close();
    final transport = PackageHttpTransport();

    await expectLater(
      transport.send(method: 'GET', uri: Uri.parse('http://127.0.0.1:$port/m/bootstrap')),
      throwsA(isA<TransportUnavailable>()
          .having((e) => e.cause, 'cause', TransportCause.refused)),
    );
    transport.close();
  });

  test('an address with no route is reported as unroutable', () async {
    final transport = PackageHttpTransport(timeout: const Duration(seconds: 2));

    await expectLater(
      transport.send(method: 'GET', uri: Uri.parse('http://host.invalid./m/bootstrap')),
      throwsA(isA<TransportUnavailable>().having(
        (e) => e.cause,
        'cause',
        // A resolver that answers "no such host" and one that never answers are
        // both honest here; what matters is that neither reads as `refused`.
        anyOf(TransportCause.unroutable, TransportCause.timedOut),
      )),
    );
    transport.close();
  });

  test('a host that answers too slowly is a timeout', () async {
    final transport = PackageHttpTransport(timeout: const Duration(milliseconds: 150));
    delay = const Duration(seconds: 3);

    await expectLater(
      transport.send(method: 'GET', uri: baseUri.replace(path: '/m/bootstrap')),
      throwsA(isA<TransportUnavailable>()
          .having((e) => e.cause, 'cause', TransportCause.timedOut)),
    );
    transport.close();
  });
}
