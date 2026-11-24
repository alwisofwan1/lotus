import 'dart:async';

import 'package:http/http.dart' as http;

import 'socket_cause.dart';
import 'transport.dart';

/// The real HTTP client, behind the seam.
///
/// `package:http` is the Dart team's own, and — unlike `dart:io`'s `HttpClient` — it
/// works on native and web alike, which keeps the spike harness (`flutter run -d
/// web-server`) on the same code path as the phone.
class PackageHttpTransport implements HttpTransport {
  PackageHttpTransport({http.Client? client, this.timeout = const Duration(seconds: 10)})
      : _client = client ?? http.Client();

  final http.Client _client;

  /// A little longer than the socket's 8s: a cold `/m/bootstrap` fans out to the
  /// desktop API and back, where a socket upgrade only has to be accepted.
  final Duration timeout;

  @override
  Future<HttpReply> send({
    required String method,
    required Uri uri,
    Map<String, String> headers = const {},
    String? body,
  }) async {
    final request = http.Request(method, uri)..headers.addAll(headers);
    if (body != null) request.body = body;

    try {
      final response = await _client.send(request).timeout(timeout);
      final text = await response.stream.bytesToString().timeout(timeout);
      return HttpReply(status: response.statusCode, body: text);
    } on TimeoutException {
      throw const TransportUnavailable('no answer before the deadline',
          cause: TransportCause.timedOut);
    } on Object catch (error) {
      // A reply with a bad status is not a failure here — it is returned above. So
      // anything landing in this catch really did fail to complete a round trip.
      throw TransportUnavailable('$error', cause: causeOf(error));
    }
  }

  void close() => _client.close();
}
