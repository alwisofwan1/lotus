import 'dart:async';

import 'package:web_socket_channel/web_socket_channel.dart';

import 'socket_cause.dart';
import 'transport.dart';

/// The real socket, behind the seam.
///
/// `WebSocketChannel.connect` is the first-party recipe and works on native and web
/// alike — the reason ADR-10's `?token=` query matters: a browser cannot put a
/// bearer on a WebSocket handshake at all.
class WebSocketTransport implements Transport {
  const WebSocketTransport({this.connectTimeout = const Duration(seconds: 8)});

  /// Long enough for a tailnet round-trip on cellular, short enough that a sleeping
  /// host is called sleeping while the operator is still looking at the screen.
  final Duration connectTimeout;

  @override
  Future<MessageChannel> open(Uri uri) async {
    final channel = WebSocketChannel.connect(uri);
    try {
      await channel.ready.timeout(connectTimeout);
    } on TimeoutException {
      unawaited(channel.sink.close());
      throw const TransportUnavailable('no answer before the deadline',
          cause: TransportCause.timedOut);
    } on Object catch (error) {
      unawaited(channel.sink.close());
      throw TransportUnavailable('$error', cause: causeOf(error));
    }
    return _ChannelAdapter(channel);
  }
}

/// Adapts `web_socket_channel` to the narrow contract the rest of the app uses, so
/// no other file has to know which package won.
class _ChannelAdapter implements MessageChannel {
  _ChannelAdapter(this._channel);

  final WebSocketChannel _channel;
  final Completer<void> _closed = Completer<void>();
  Stream<String>? _messages;

  @override
  Stream<String> get messages => _messages ??= _channel.stream.map((event) {
        // A host that sends binary is a host we do not understand; treat it as
        // empty text rather than crashing the only screen the operator has.
        return event is String ? event : '';
      }).map<String>((e) => e).transform(_completeOnDone(_closed));

  @override
  Future<void> get closed => _closed.future;

  @override
  void send(String data) => _channel.sink.add(data);

  @override
  Future<void> close([int? code]) async {
    await _channel.sink.close(code);
    if (!_closed.isCompleted) _closed.complete();
  }
}

/// Completes [signal] when the stream ends for any reason — dropped, closed, or
/// failed. `HostSocket` only needs "it is over"; why it ended is judged elsewhere.
StreamTransformer<String, String> _completeOnDone(Completer<void> signal) =>
    StreamTransformer<String, String>.fromHandlers(
      handleError: (error, stack, sink) {
        if (!signal.isCompleted) signal.complete();
      },
      handleDone: (sink) {
        if (!signal.isCompleted) signal.complete();
        sink.close();
      },
    );
