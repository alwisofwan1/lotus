import 'dart:async';
import 'dart:convert';

import '../models/host_id.dart';
import '../models/server_event.dart';
import 'transport.dart';

/// Suspends for [d]. Injected so backoff can be asserted instead of waited out.
typedef Sleeper = Future<void> Function(Duration d);

/// One WebSocket to one host — the only place in the app that owns socket
/// lifecycle (ADR-13 no. 5).
///
/// Reconnecting is our job: a `WebSocket` does not do it by itself, unlike
/// `EventSource`. And because the only replay source is the 64 KB PTY ring buffer,
/// recovery means asking `resume { paneId, fromByte }` for the pane being watched —
/// not replaying everything, and not silently accepting a hole.
class HostSocket {
  HostSocket({
    required this.host,
    required this.baseUri,
    required String Function() token,
    required this.transport,
    required this.sleep,
    this.onConnected,
    this.onAttemptFailed,
  }) : _tokenReader = token;

  final HostId host;

  /// Injected collaborators stay visible rather than hidden behind underscores:
  /// Dart cannot name a private parameter, and what this object depends on is worth
  /// reading at the call site anyway (ADR-13 no. 4).
  final Uri baseUri;
  final Transport transport;
  final Sleeper sleep;

  /// Called each time a connection is established, including after a drop.
  final void Function()? onConnected;

  /// Called for **every** failed attempt, not just the first.
  ///
  /// Retrying is this class's job, but hiding why it is retrying is not: the
  /// operator needs the cause named, and it can change between attempts (a host that
  /// refuses, then sleeps).
  final void Function(TransportUnavailable failure)? onAttemptFailed;

  /// Read per connection, not once: a 12-hour TTL can be refreshed while the app
  /// runs, and a socket that reopens with the stale token would 401 forever.
  final String Function() _tokenReader;

  static const Duration firstBackoff = Duration(milliseconds: 500);

  /// Capped so a host that sleeps all night is still polled on the hour scale a
  /// person expects — an uncapped doubling would drift into hours.
  static const Duration maxBackoff = Duration(seconds: 15);

  /// How many times a REFUSED upgrade is retried before the loop gives up.
  ///
  /// Not one, and not unlimited. Dart drops the status code from a failed handshake, so a
  /// dead credential and a host restarting behind a 502 look identical here — three attempts
  /// ride out the restart, and stopping after them keeps a rejected token from spinning
  /// behind a progress indicator for ever. The comment on [_tokenReader] named this hazard
  /// long before anything handled it.
  static const int maxRejectedAttempts = 3;

  final StreamController<ServerEvent> _events = StreamController<ServerEvent>.broadcast();
  Stream<ServerEvent> get events => _events.stream;

  MessageChannel? _channel;
  StreamSubscription<String>? _messages;

  /// Pane currently tailed, and how far its output has been seen. Kept per pane so a
  /// resume can never quote an offset that belongs to a different cell.
  String? _subscribed;
  final Map<String, int> _offsets = {};

  /// The highest conversation cursor seen per cell, kept here for the same reason [_offsets]
  /// is: the socket is the one thing that sees every frame *and* every reconnect, so it can
  /// repair itself without any store having to notice the connection dropped.
  final Map<String, int> _conversationCursors = {};

  bool _disposed = false;
  bool _wantConnection = false;
  Future<void>? _connecting;

  bool get isConnected => _channel != null;

  /// Opens the connection, retrying with backoff until it succeeds.
  ///
  /// Returns once connected. It does not throw on a refused host: unreachable is a
  /// state this app lives in, not an error to unwind through.
  Future<void> connect() {
    if (_disposed) return Future.value();
    _wantConnection = true;
    // One loop at a time: a drop's reconnect racing the app's own call would
    // otherwise run two dial/backoff loops and attach two channels (doubled frames).
    return _connecting ??= _dial().whenComplete(() => _connecting = null);
  }

  Future<void> _dial() async {
    var attempt = 0;
    var rejected = 0;

    while (_wantConnection && !_disposed && _channel == null) {
      try {
        final channel = await transport.open(_streamUri());
        if (!_wantConnection || _disposed) {
          // close() or dispose() landed during the handshake: nobody wants this socket.
          unawaited(channel.close());
          return;
        }
        _attach(channel);
        return;
      } on TransportUnavailable catch (failure) {
        onAttemptFailed?.call(failure);
        if (failure.cause == TransportCause.rejected) {
          rejected += 1;
          if (rejected >= maxRejectedAttempts) {
            _wantConnection = false;
            return;
          }
        } else {
          rejected = 0;
        }
        await sleep(backoffFor(attempt));
        attempt += 1;
      }
    }
  }

  /// Exponential from [firstBackoff], clamped at [maxBackoff].
  static Duration backoffFor(int attempt) {
    final ms = firstBackoff.inMilliseconds * (1 << attempt);
    return ms >= maxBackoff.inMilliseconds ? maxBackoff : Duration(milliseconds: ms);
  }

  /// Tails one pane, or detaches with null. The host replaces the previous
  /// subscription rather than adding to it — one tail per connection.
  void subscribe(String? paneId) {
    _subscribed = paneId;
    _send({'type': 'subscribe', 'paneId': paneId});
  }

  /// Closes deliberately — app going to background (ADR-13 no. 5). No reconnect
  /// follows: a phone will kill the socket anyway, and one that claims to be alive
  /// while dead is the most confusing failure there is.
  Future<void> close([int? code]) async {
    _wantConnection = false;
    final channel = _channel;
    _channel = null;
    await _messages?.cancel();
    _messages = null;
    await channel?.close(code);
  }

  void dispose() {
    _disposed = true;
    _wantConnection = false;
    _messages?.cancel();
    _channel?.close();
    _channel = null;
    _events.close();
  }

  Uri _streamUri() => baseUri.replace(
        scheme: _socketScheme,
        path: '/m/stream',
        queryParameters: {'token': _tokenReader()},
      );

  /// The socket scheme for the address this host was paired at.
  ///
  /// **Not a formality.** A paired host's `baseUri` is the address the operator typed
  /// into onboarding, so it is `http` or `https` — and `WebSocketChannel.connect`
  /// refuses those outright: *"only ws: and wss: schemes are supported"*. Handing the
  /// base URI straight to the transport meant the socket could never open in
  /// production, while every test and `tool/smoke.dart` passed because each of them
  /// constructed a `ws://` base by hand. Measured against a live host on 2026-08-06:
  /// HTTP paired, `mobile-devices.json` gained the device, and no TCP connection to
  /// the stream port ever existed.
  String get _socketScheme => switch (baseUri.scheme) {
        'https' || 'wss' => 'wss',
        _ => 'ws',
      };

  void _attach(MessageChannel channel) {
    _channel = channel;
    onConnected?.call();
    _messages = channel.messages.listen(_onMessage);
    channel.closed.then((_) => _onClosed());

    // Re-establish what the previous connection was showing. Without this the
    // operator is left staring at output that stopped mid-line.
    final pane = _subscribed;
    if (pane != null) {
      _send({'type': 'subscribe', 'paneId': pane});
      final from = _offsets[pane];
      if (from != null) {
        _send({'type': 'resume', 'paneId': pane, 'fromByte': from});
      }
    }
    _resumeConversations();
  }

  /// Asks for every conversation delta this app missed while the socket was down.
  ///
  /// All followed cells in one message: the pager holds a window of neighbours, and a
  /// reconnect has to repair them together rather than one round trip each.
  void _resumeConversations() {
    if (_conversationCursors.isEmpty) return;
    _send({
      'type': 'conversation.resume',
      'cursors': [
        for (final entry in _conversationCursors.entries)
          {'paneId': entry.key, 'cursor': entry.value},
      ],
    });
  }

  void _onMessage(String raw) {
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      return; // A frame we cannot read is not a reason to drop the connection.
    }
    if (decoded is! Map<String, Object?>) return;

    final event = ServerEvent.fromJson(decoded, host: host);
    if (event == null) return; // Unknown type — ADR-10 says skip, not throw.

    if (event is CellOutputEvent) _offsets[event.paneId] = event.byteOffset;
    if (event is ConversationFrame && event.cursor > 0) {
      final seen = _conversationCursors[event.paneId] ?? 0;
      // Highest wins: a resume replays in order, but a live delta can overtake a backfill.
      if (event.cursor > seen) _conversationCursors[event.paneId] = event.cursor;
    }
    if (!_events.isClosed) _events.add(event);
  }

  void _onClosed() {
    if (_channel == null) return; // Already closed on purpose.
    _channel = null;
    _messages?.cancel();
    _messages = null;
    // A turn later: a channel that closes the instant it attaches must find the finished
    // connect() already cleared from `_connecting`, not join it and never redial.
    unawaited(Future(() {
      if (_wantConnection && !_disposed) unawaited(connect());
    }));
  }

  void _send(Map<String, Object?> frame) => _channel?.send(jsonEncode(frame));
}
