/// The socket seam.
///
/// `HostSocket` talks to this, never to `web_socket_channel`, for two reasons: the
/// store above it becomes testable without a tailnet (ADR-13 no. 4), and the choice
/// of package stays replaceable — the web build and the native build do not agree
/// on what a WebSocket can do.
abstract interface class Transport {
  /// Opens a connection, or throws [TransportUnavailable] if it cannot.
  Future<MessageChannel> open(Uri uri);
}

/// The HTTP seam — the other half of ADR-13 no. 4, and the half every mutation
/// travels on (ADR-8: mutations stay on HTTP so each carries its own bearer and
/// lands in the audit trail as one request).
///
/// Deliberately narrower than any HTTP client: no interceptors, no retry, no JSON.
/// `HostApi` layers those on top, which is what keeps `package:http` replaceable and
/// lets the whole `/m/*` surface be exercised against `contract/fixtures/` with no
/// host alive.
abstract interface class HttpTransport {
  /// Performs one request, or throws [TransportUnavailable] if it never arrived.
  ///
  /// A reply is a reply whatever its status: 401 and 404 are answers this app acts
  /// on, so they come back as [HttpReply] rather than as exceptions. Only a request
  /// that never reached the host throws.
  Future<HttpReply> send({
    required String method,
    required Uri uri,
    Map<String, String> headers,
    String? body,
  });
}

/// One HTTP answer, still untyped. Kept as text because the only decoder is
/// `HostApi`, and a seam that parsed JSON would have opinions the fixtures test.
class HttpReply {
  const HttpReply({required this.status, required this.body});

  final int status;
  final String body;

  bool get isOk => status >= 200 && status < 300;
}

/// One open connection: text frames in both directions, and a future that completes
/// when it ends for any reason.
abstract interface class MessageChannel {
  Stream<String> get messages;

  /// Completes when the connection is over — dropped, closed by either side, or
  /// failed. Nothing distinguishes those here on purpose: the cause is a
  /// `HostFailure` question, and it is answered where reachability is judged.
  Future<void> get closed;

  void send(String data);

  Future<void> close([int? code]);
}

/// Why a connection could not be opened, at the level a transport can actually
/// tell — not yet a diagnosis.
///
/// The mapping to something an operator can act on happens in `hosts/`, because
/// only that layer knows whether a credential exists and what the host is for. The
/// distinction that matters most is already here though: **refused** and
/// **timedOut** are different machines' behaviour, not two words for "down".
enum TransportCause {
  /// Nothing is listening. The machine answered — with a refusal.
  refused,

  /// No answer at all within the deadline.
  timedOut,

  /// The address could not be resolved or has no route.
  unroutable,

  /// The host answered and refused to upgrade the connection.
  ///
  /// Not a network problem, and deliberately not called "unauthorized": Dart drops the
  /// HTTP status from a failed WebSocket handshake, so a rejected credential and a host
  /// restarting behind a 502 arrive identically. What is knowable is that something
  /// answered — which is already more than [unknown] says.
  rejected,

  /// Anything else. Kept separate so an unclassified failure is visible as such
  /// rather than dressed up as one of the above.
  unknown,
}

/// Thrown by [Transport.open] when the connection could not be established.
class TransportUnavailable implements Exception {
  const TransportUnavailable(this.reason, {this.cause = TransportCause.unknown});

  final String reason;
  final TransportCause cause;

  @override
  String toString() => 'TransportUnavailable(${cause.name}): $reason';
}
