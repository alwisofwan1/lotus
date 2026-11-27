import '../core/transport.dart';

/// Distinct failure states guide different operator actions (`issues/06`).
sealed class HostFailure {
  const HostFailure();

  /// Stable slug for logs and diagnostics. Not user-facing copy.
  String get code;

  /// Whether retrying the same request could plausibly succeed without the
  /// operator doing something first.
  bool get retryable;

  /// Maps a transport outcome to a cause, using the one signal that actually
  /// separates "asleep" from "not running": a machine that is asleep never answers,
  /// while a machine that is awake with no Lotus **refuses** the connection.
  factory HostFailure.fromTransport({
    required bool routable,
    required bool refused,
    required bool timedOut,
  }) {
    if (!routable) return const TailnetDown();
    if (refused) return const LotusNotRunning();
    if (timedOut) return const HostAsleep();
    return const HostUnknownFailure();
  }

  /// The same mapping, from what a transport actually reports.
  ///
  /// Lives here rather than in one caller because both transports fail this way and
  /// both `hosts/` and `data/` have to name the cause. Two copies of this table would
  /// eventually disagree about which silence means asleep.
  static HostFailure fromCause(TransportCause cause) => switch (cause) {
        TransportCause.refused => const LotusNotRunning(),
        TransportCause.timedOut => const HostAsleep(),
        TransportCause.unroutable => const TailnetDown(),
        TransportCause.rejected => const HostRefused(),
        TransportCause.unknown => const HostUnknownFailure(),
      };
}

/// A rejected WebSocket upgrade does not identify a credential failure; retries are bounded by [HostSocket.maxRejectedAttempts].
class HostRefused extends HostFailure {
  const HostRefused();

  @override
  String get code => 'host_refused';

  @override
  bool get retryable => false;
}

/// No route to the host at all: Tailscale is off, logged out, or the tailnet
/// changed underneath us (R-9).
class TailnetDown extends HostFailure {
  const TailnetDown();

  @override
  String get code => 'tailnet_down';

  @override
  bool get retryable => true;
}

/// Routable but silent. The desktop case this product exists for: the operator
/// walked away and the MacBook slept (R-8, and Lotus has no keep-awake today).
class HostAsleep extends HostFailure {
  const HostAsleep();

  @override
  String get code => 'host_asleep';

  @override
  bool get retryable => true;
}

/// The machine is awake and refused the connection — nothing is listening, so
/// Lotus itself is not running. Different action entirely: start the app.
class LotusNotRunning extends HostFailure {
  const LotusNotRunning();

  @override
  String get code => 'lotus_not_running';

  @override
  bool get retryable => false;
}

/// Expired and revoked credentials require re-pairing but convey different causes (`device-store.ts`).
class CredentialExpired extends HostFailure {
  const CredentialExpired();

  @override
  String get code => 'credential_expired';

  @override
  bool get retryable => false;
}

/// 401 with a credential the host no longer knows: revoked from the desktop, or
/// past the 30-day ceiling. Only a fresh pairing code gets back in.
class CredentialRevoked extends HostFailure {
  const CredentialRevoked();

  @override
  String get code => 'credential_revoked';

  @override
  bool get retryable => false;
}

/// Kept deliberately: an unclassified failure must be visible as unclassified
/// rather than dressed up as one of the four above. A wrong diagnosis sends the
/// operator to fix something that was never broken.
class HostUnknownFailure extends HostFailure {
  const HostUnknownFailure();

  @override
  String get code => 'unknown';

  @override
  bool get retryable => true;
}
