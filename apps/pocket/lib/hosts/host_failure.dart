import '../core/transport.dart';

/// Why a host cannot be reached — as a type, because "failed to connect" is not
/// an answer an operator can act on.
///
/// `issues/06` requires four states to be told apart, since each has a different
/// next move: the tailnet is down, the host is asleep, Lotus is not running, or the
/// credential is gone. The **wording** waits for that ticket; the type exists now
/// so a fifth state cannot slip in without a decision — a `switch` over a sealed
/// class refuses to compile until it is handled.
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

/// Something answered the handshake and turned it down.
///
/// Deliberately NOT `CredentialExpired`: Dart discards the HTTP status from a failed
/// WebSocket upgrade, so a rejected token and a host restarting behind a 502 arrive
/// identically. Calling it a credential problem would be a guess wearing the clothes of a
/// fact — and the operator would be sent to re-pair a host that was merely rebooting.
///
/// Not [LotusNotRunning] either: that state means nothing is listening, and here something
/// is. Not retryable, because the socket has already ridden out a restart's worth of
/// attempts by the time this surfaces ([HostSocket.maxRejectedAttempts]).
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

/// 401 with a token that has simply aged out of its TTL, and cannot be refreshed
/// because the host applies the exact same TTL check to a refresh (`device-store.ts`).
///
/// **Distinct from [CredentialRevoked] for what it tells the operator, not for what
/// it lets them do next.** Both end at the same pairing screen — the host has no way
/// to renew a token past its own TTL, refreshed or not — but they are different facts:
/// this one means "you were away too long", that one means "the desktop revoked you".
/// Conflating them would have the operator wondering if they did something wrong when
/// the answer is just the clock. `Credentials.refreshLead` exists to keep this state
/// rare — 24 hours of lead against a 72-hour TTL means only an absence genuinely past
/// three days reaches here at all.
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
