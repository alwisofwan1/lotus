import 'dart:convert';

import 'api_failure.dart';
import 'transport.dart';

/// How a reply that is not OK becomes an [ApiFailure].
///
/// Split out of `host_api.dart` so that file stays about the routes. Everything here is
/// about one question — what did the host actually say — and none of it needs a client.

/// `POST /m/pair` refusals, which are the only ones with no bearer behind them.
///
/// 429 is a case of its own because the operator's move differs: the code in their hand
/// may be fine, and the host is either throttling this source or locked out after five
/// failures (`packages/host/src/adapters/mobile/pair-route.ts`). The host's own sentence
/// is carried through — it is the only side that knows which of the two it is.
ApiFailure? pairingFailure(HttpReply reply) => switch (reply.status) {
      401 => const PairingRejected(),
      429 => TooManyPairingAttempts(reasonIn(reply)),
      _ => null,
    };

ApiFailure classify(HttpReply reply) => switch (reply.status) {
      401 => const HostUnauthorized(),
      400 => HostRejected(reasonIn(reply)),
      _ => HostFaulted(status: reply.status, reason: reasonIn(reply)),
    };

Map<String, Object?> decode(HttpReply reply) {
  final Object? json;
  try {
    json = jsonDecode(reply.body);
  } on FormatException catch (error) {
    // A proxy's HTML error page reaching the only screen the operator has must read
    // as "the host answered something odd", not as a crash.
    throw HostFaulted(status: reply.status, reason: 'body is not JSON: $error');
  }
  if (json is! Map<String, Object?>) {
    throw HostFaulted(status: reply.status, reason: 'body is not a JSON object');
  }
  return json;
}

/// Valid JSON of the wrong shape surfaces from a `fromJson` as a [TypeError]; a fault
/// the callers already handle, not a crash on the only screen the operator has.
T parseShape<T>(T Function() parse) {
  try {
    return parse();
  } on TypeError catch (e) {
    throw HostFaulted(status: 200, reason: 'unexpected response shape: $e');
  }
}

/// The host's own words for a failure. Every error body on this surface is
/// `{ "error": string }`, but a proxy in between owes us nothing.
String reasonIn(HttpReply reply) {
  try {
    final json = jsonDecode(reply.body);
    if (json is Map<String, Object?> && json['error'] is String) return json['error']! as String;
  } on FormatException {
    // Fall through to the raw body below.
  }
  final body = reply.body.trim();
  return body.length <= 200 ? body : '${body.substring(0, 200)}…';
}
