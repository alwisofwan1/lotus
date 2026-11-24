import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/core/transport.dart';
import 'package:lotus_pocket/core/ws_transport.dart';

void main() {
  test('an upgrade the host answers and refuses is not a network failure', () async {
    // Verified against a real server: Dart reports a non-101 response as
    // `WebSocketException: … was not upgraded to websocket` and drops the status
    // code, so 401 and 502 are indistinguishable here. What IS knowable is that the
    // host answered — and that must not be filed as `unknown` beside a mangled URL.
    final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    server.listen((req) {
      req.response.statusCode = HttpStatus.unauthorized;
      req.response.close();
    });
    addTearDown(() => server.close(force: true));

    await expectLater(
      const WebSocketTransport().open(Uri.parse('ws://127.0.0.1:${server.port}')),
      throwsA(isA<TransportUnavailable>()
          .having((f) => f.cause, 'cause', TransportCause.rejected)),
    );
  });
}
