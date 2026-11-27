import 'dart:io';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'transport.dart';

/// Keep shared classification platform-independent and distinguish refused connections from silent hosts.
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

/// Unwrap socket exceptions without guessing other failures such as TLS errors.
SocketException? _socketErrorIn(Object error) => switch (error) {
      final SocketException e => e,
      WebSocketChannelException(inner: final SocketException e) => e,
      _ => null,
    };

/// Match the handshake text because Dart discards status and the channel wraps a different exception type.
bool _isRefusedUpgrade(Object error) {
  final inner = error is WebSocketChannelException ? error.inner : error;
  return '$inner'.contains('was not upgraded to websocket');
}
