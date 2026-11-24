import 'dart:async';
import 'dart:convert';

import 'package:lotus_pocket/core/transport.dart';

/// A socket the test drives by hand.
///
/// The seam ADR-13 no. 4 asks for: `HostSocket` can be exercised end to end with no
/// tailnet, no host, and no phone — frames go in, behaviour comes out.
class FakeChannel implements MessageChannel {
  FakeChannel();

  final _incoming = StreamController<String>();
  final List<Map<String, Object?>> sent = [];
  final Completer<void> _done = Completer<void>();
  bool closedByClient = false;
  int? closeCode;

  /// Pushes one frame as if the host had sent it.
  void emit(Map<String, Object?> frame) => _incoming.add(jsonEncode(frame));

  /// Ends the connection the way a network drop does: no code, no warning.
  void dropped() {
    if (!_done.isCompleted) _done.complete();
    _incoming.close();
  }

  @override
  Stream<String> get messages => _incoming.stream;

  @override
  Future<void> get closed => _done.future;

  @override
  void send(String data) => sent.add(jsonDecode(data) as Map<String, Object?>);

  @override
  Future<void> close([int? code]) async {
    closedByClient = true;
    closeCode = code;
    dropped();
  }
}

/// One request as the fake saw it, so a test can assert the route, the bearer and
/// the body without a host.
class SentRequest {
  const SentRequest({
    required this.method,
    required this.uri,
    required this.headers,
    required this.body,
  });

  final String method;
  final Uri uri;
  final Map<String, String> headers;
  final String? body;

  String? get bearer => headers['Authorization'];

  /// The body decoded, for asserting what was actually posted.
  Map<String, Object?> get json => jsonDecode(body!) as Map<String, Object?>;
}

/// Answers requests from a queue and records every one — the seam that lets the
/// whole `/m/*` surface be tested against `contract/fixtures/` with no host alive
/// (ADR-13 no. 4).
class FakeHttpTransport implements HttpTransport {
  final List<SentRequest> sent = [];
  final List<HttpReply> _queued = [];

  /// When set, every request fails this way instead of answering — a sleeping host.
  TransportUnavailable? failWith;

  SentRequest get last => sent.last;

  /// Queues one answer. Calls consume these in order, so a test can script a
  /// sequence (a 401, then a refreshed token, then the retry).
  void enqueue(String body, {int status = 200}) =>
      _queued.add(HttpReply(status: status, body: body));

  /// Leaves the next request hanging until [release].
  ///
  /// The only way to get two requests genuinely in flight at once, which is what
  /// a slow host looks like — and the state that any "don't start a second one"
  /// guard is actually about. Without it a test can only ever observe calls that
  /// have already finished, where such a guard is invisible.
  Completer<void>? _held;

  void holdNext() => _held = Completer<void>();

  void release() {
    final held = _held;
    _held = null;
    if (held != null && !held.isCompleted) held.complete();
  }

  @override
  Future<HttpReply> send({
    required String method,
    required Uri uri,
    Map<String, String> headers = const {},
    String? body,
  }) async {
    sent.add(SentRequest(method: method, uri: uri, headers: headers, body: body));
    // Claimed on arrival, so only the request that found the hold waits on it.
    final held = _held;
    if (held != null) {
      _held = null;
      await held.future;
    }
    final failure = failWith;
    if (failure != null) throw failure;
    // An empty queue answering `{}` keeps a test that only cares about the request
    // from having to script a reply it never reads.
    return _queued.isEmpty ? const HttpReply(status: 200, body: '{}') : _queued.removeAt(0);
  }
}

/// Answers by **route**, so one route can be slow while another is not.
///
/// [FakeHttpTransport] cannot express that, and the reason is worth stating because it
/// looks like a limitation and is really a shape mismatch. `AgentRepository.load` starts
/// `transcript` and `permission` before awaiting either — deliberately, so a screen costs
/// one round trip rather than two. Holding the first *reply* therefore hands the
/// transcript's body to the permission call and shifts every answer after it by one, so
/// the failure a test then observes belongs to the fake and not to the app.
///
/// A slow host is the state the Agent pager's ordering bugs actually live in
/// (`issues/12`), so it has to be a condition a test can declare rather than a race it
/// has to win.
class RouteAwareTransport implements HttpTransport {
  /// What each route answers. Set once; a route answers the same body every time,
  /// because these tests are about *when* an answer lands, never about what it says.
  String transcript = '{}';
  String permission = '{}';

  final List<SentRequest> sent = [];

  /// While true, `GET …/transcript` parks until [release] — and only that route.
  bool holdTranscript = false;

  final List<Completer<void>> _held = [];

  /// How many times a route was asked, which is how a test proves a cached page was
  /// **not** re-fetched on the way back.
  int callsTo(String route) => sent.where((r) => r.uri.path.endsWith('/$route')).length;

  void release() {
    for (final gate in _held) {
      if (!gate.isCompleted) gate.complete();
    }
    _held.clear();
  }

  @override
  Future<HttpReply> send({
    required String method,
    required Uri uri,
    Map<String, String> headers = const {},
    String? body,
  }) async {
    sent.add(SentRequest(method: method, uri: uri, headers: headers, body: body));
    final path = uri.path;
    if (path.endsWith('/transcript')) {
      if (holdTranscript) {
        final gate = Completer<void>();
        _held.add(gate);
        await gate.future;
      }
      return HttpReply(status: 200, body: transcript);
    }
    if (path.endsWith('/permission')) return HttpReply(status: 200, body: permission);
    return const HttpReply(status: 200, body: '{}');
  }
}

/// Hands out [FakeChannel]s and records every URI it was asked to open — which is
/// how a test checks that the token rides the query string and never a header.
class FakeTransport implements Transport {
  FakeTransport({this.failFirst = 0});

  /// How many opens should throw before one succeeds, for backoff tests.
  int failFirst;

  /// Cause reported by the first failure.
  TransportCause failWith = TransportCause.unknown;

  /// Cause reported by every failure after the first — a machine that refuses and
  /// then goes to sleep is a real sequence, not a contrived one.
  TransportCause? failWithAfterFirst;

  int _failures = 0;

  final List<Uri> opened = [];
  final List<FakeChannel> channels = [];

  FakeChannel get current => channels.last;

  @override
  Future<MessageChannel> open(Uri uri) async {
    opened.add(uri);
    if (failFirst > 0) {
      failFirst -= 1;
      final cause = _failures == 0 ? failWith : (failWithAfterFirst ?? failWith);
      _failures += 1;
      throw TransportUnavailable('fake failure', cause: cause);
    }
    final channel = FakeChannel();
    channels.add(channel);
    return channel;
  }
}
