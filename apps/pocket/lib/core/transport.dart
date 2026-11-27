/// The seam enables testing and platform-specific socket implementations (ADR-13 no. 4).
abstract interface class Transport {
  /// Opens a connection, or throws [TransportUnavailable] if it cannot.
  Future<MessageChannel> open(Uri uri);
}

/// Mutations use HTTP for bearer and audit attribution; the seam supports isolated tests (ADR-8, ADR-13 no. 4).
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

/// The host layer diagnoses transport failures; refused and timed-out connections remain distinct.
enum TransportCause {
  /// Nothing is listening. The machine answered — with a refusal.
  refused,

  /// No answer at all within the deadline.
  timedOut,

  /// The address could not be resolved or has no route.
  unroutable,

  /// A rejected handshake is not necessarily unauthorized: Dart discards its HTTP status.
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
