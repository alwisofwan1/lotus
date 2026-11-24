/// Why an HTTP call to a host did not give an answer the caller can use.
///
/// Separate from `HostFailure` on purpose, and the split is the whole design: this
/// says what the **host replied**, `HostFailure` says what the **operator should do**.
/// Only `hosts/` can bridge them, because deciding expired-vs-revoked needs the clock
/// and the stored expiry, which `core/` does not have (ADR-13 no. 3).
///
/// Sealed so a new status cannot be handled by accident: a `switch` over these
/// refuses to compile until the new case is named.
///
/// [TransportUnavailable] is deliberately *not* one of these. A request that never
/// arrived is not a reply, and flattening the two would lose the refused/asleep
/// distinction the failure taxonomy rests on.
sealed class ApiFailure implements Exception {
  const ApiFailure();

  /// Stable slug for logs and diagnostics. Not user-facing copy.
  String get code;
}

/// 401 from `POST /m/pair` — the code was wrong, already used, or timed out.
///
/// Not [HostUnauthorized]: there is no token yet, so "refresh the credential" is not
/// a path that exists here. The operator needs a new code from the desktop.
class PairingRejected extends ApiFailure {
  const PairingRejected();

  @override
  String get code => 'pairing_rejected';
}

/// 429 from `POST /m/pair` — the host is throttling this source, or redeeming is
/// locked out after too many failed codes (`packages/host/.../pair-route.ts`).
///
/// Distinct from [PairingRejected] because the operator's move differs: nothing is
/// wrong with the code they hold, and typing it again in ten seconds may well work.
/// Carries the host's own sentence, since only the host knows which of the two it is.
class TooManyPairingAttempts extends ApiFailure {
  const TooManyPairingAttempts(this.reason);

  final String reason;

  @override
  String get code => 'pairing_throttled';
}

/// 401 on a route that carried a bearer. Left unclassified on purpose — see the note
/// on [ApiFailure] about who is allowed to decide expired-vs-revoked.
class HostUnauthorized extends ApiFailure {
  const HostUnauthorized();

  @override
  String get code => 'unauthorized';
}

/// 401 from `POST /m/devices/refresh` — this credential can never be renewed again.
///
/// A distinct type because the host refuses to refresh a token that is *already* past
/// its 12-hour TTL, exactly as it refuses one past the 30-day ceiling
/// (`packages/host/.../device-store.ts`). So there is no "ask for biometrics and
/// retry" here: the only way back in is a fresh pairing code.
class RefreshRefused extends ApiFailure {
  const RefreshRefused();

  @override
  String get code => 'refresh_refused';
}

/// 401 from `/m/devices/renew*` — the host would not take this device's hardware-key
/// signature: no key on record, revoked, or a nonce that went stale. A new pairing code
/// is the only way back, exactly as for [RefreshRefused].
class RenewalRefused extends ApiFailure {
  const RenewalRefused();

  @override
  String get code => 'renewal_refused';
}

/// 404 from `POST /m/cell/:paneId/stop` — the pane has no live session behind it.
///
/// An expected state rather than a fault: the agent already exited, or the host set
/// no `sessionId`. "That cell is gone" is actionable; "error" is not.
class NoLiveSession extends ApiFailure {
  const NoLiveSession(this.paneId);

  final String paneId;

  @override
  String get code => 'no_live_session';
}

/// 400 — the host understood the request and refused it. That makes it our bug, so
/// the host's own words are carried rather than replaced with friendlier copy.
class HostRejected extends ApiFailure {
  const HostRejected(this.reason);

  final String reason;

  @override
  String get code => 'rejected';

  @override
  String toString() => 'HostRejected: $reason';
}

/// Anything else: a 5xx, an unexpected status, or a body that is not JSON at all.
///
/// Kept as one type because the operator's next move is the same for all of them —
/// look at the host — while splitting them would invent distinctions the reply does
/// not actually support.
class HostFaulted extends ApiFailure {
  const HostFaulted({required this.status, required this.reason});

  final int status;
  final String reason;

  @override
  String get code => 'faulted';

  @override
  String toString() => 'HostFaulted($status): $reason';
}
