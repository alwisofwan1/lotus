/// Host replies and operator diagnoses belong to separate layers; transport failures are not replies (ADR-13 no. 3).
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

/// Keep throttling distinct from an invalid code because the operator can retry (`packages/host/.../pair-route.ts`).
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

/// Expired credentials require re-pairing; biometric retry cannot renew them (`packages/host/.../device-store.ts`).
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
