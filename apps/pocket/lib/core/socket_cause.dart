import 'dart:io';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'transport.dart';

/// Classifies a failed connection attempt, for the socket and the HTTP client alike.
///
/// Extracted out of `WebSocketTransport` when the HTTP half arrived: both need the
/// same verdict, and the alternative was one implementation importing the other.
/// The seam itself stays free of `dart:io` this way — only the implementations
/// behind it are platform-bound.
///
/// Refused vs silent is the distinction the whole `HostFailure` taxonomy rests on:
/// an awake machine with no Lotus **refuses**, a sleeping one never answers. The
/// errno set is spelled out because the same condition has three numbers —
/// 61 on macOS/BSD, 111 on Linux, 1225 on Windows.
TransportCause causeOf(Object error) {
  if (_isRefusedUpgrade(error)) return TransportCause.rejected;
  final socketError = _socketErrorIn(error);
  if (socketError == null) return TransportCause.unknown;

  const refusedCodes = {61, 111, 1225};
  final code = socketError.osError?.errorCode;
  if (code != null && refusedCodes.contains(code)) return TransportCause.refused;

  final message = '${socketError.message} ${socketError.osError?.message}'.toLowerCase();
  if (message.contains('refused')) return TransportCause.refused;
  if (message.contains('failed host lookup') || message.contains('no route')) {
    return TransportCause.unroutable;
  }
  if (message.contains('timed out')) return TransportCause.timedOut;
  return TransportCause.unknown;
}

/// Digs the `SocketException` out of whatever the socket package wrapped it in.
///
/// `package:http` needs no arm of its own: its `_ClientSocketException` *implements*
/// `SocketException` and forwards `osError`, so the first arm already reads the real
/// errno through it. Its other failures (a TLS handshake, a malformed URL) stay
/// `unknown`, which is the honest answer rather than a guessed one.
SocketException? _socketErrorIn(Object error) => switch (error) {
      final SocketException e => e,
      WebSocketChannelException(inner: final SocketException e) => e,
      _ => null,
    };

/// Whether the host answered the handshake and declined to upgrade it.
///
/// Matched on TEXT, for two reasons that both had to be measured rather than assumed:
///
/// 1. `dart:io` throws the status line away — every non-101 response raises the same bare
///    exception, so there is no code to read and 401 cannot be told from 502 here.
/// 2. The wrapped exception is **not** `dart:io`'s `WebSocketException`. `web_socket_channel`
///    carries its own class of the same name, so `inner is WebSocketException` is `false`
///    against the `dart:io` import — silently, which is how a type check here would fail
///    while looking correct.
///
/// The phrase is the literal both classes carry, and it is specific enough not to collide.
bool _isRefusedUpgrade(Object error) {
  final inner = error is WebSocketChannelException ? error.inner : error;
  return '$inner'.contains('was not upgraded to websocket');
}
