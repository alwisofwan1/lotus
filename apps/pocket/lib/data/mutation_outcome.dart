import '../hosts/host_failure.dart';

/// Distinct outcomes represent different operator actions and require exhaustive handling.
sealed class MutationOutcome {
  const MutationOutcome();

  /// Stable slug for logs and diagnostics. Not user-facing copy — that belongs to
  /// `features/`, which is also the only layer allowed to have opinions about wording.
  String get code;

  bool get succeeded => this is MutationSent;
}

/// The host accepted it. The agent's own reply arrives over the socket, not here.
class MutationSent extends MutationOutcome {
  const MutationSent();

  @override
  String get code => 'sent';
}

/// Proof of presence was not given: cancelled, or a lockout (ADR-12 no. 4).
///
/// Nothing was sent. The operator can simply try again, which is why this is not an
/// error state — it is the gate doing its job.
class MutationRefused extends MutationOutcome {
  const MutationRefused();

  @override
  String get code => 'refused';
}

/// The credential is beyond renewal — only a fresh pairing code gets back in.
class MutationNeedsPairing extends MutationOutcome {
  const MutationNeedsPairing({this.cause});

  /// Named when a 401 said which of the two it was: revoked from the desktop, or aged
  /// out. Null when the ceiling was reached locally and no host was asked.
  final HostFailure? cause;

  @override
  String get code => 'needs_pairing';
}

/// `stop` on a pane with no live session behind it (a 404).
///
/// Expected rather than broken: the agent already exited. The fleet list is what is
/// stale, so the operator's move is to refresh it, not to retry the stop.
class MutationNoLiveSession extends MutationOutcome {
  const MutationNoLiveSession(this.paneId);

  final String paneId;

  @override
  String get code => 'no_live_session';
}

/// The host understood the request and refused it — a 400, so our bug. Carries the
/// host's own words rather than friendlier copy that would hide it.
class MutationRejected extends MutationOutcome {
  const MutationRejected(this.reason);

  final String reason;

  @override
  String get code => 'rejected';
}

/// The request never arrived. [failure] already names what to do about it — wake the
/// mac, start Lotus, check the tailnet — because that taxonomy exists for this.
class MutationUnreachable extends MutationOutcome {
  const MutationUnreachable(this.failure);

  final HostFailure failure;

  @override
  String get code => 'unreachable';
}

/// Keep unpaired-host state distinct from network failure; 503 can indicate a workspace is not ready.
class MutationHostNotReady extends MutationOutcome {
  const MutationHostNotReady(this.reason);

  /// The host's own sentence, kept for Diagnostics; the notice is written here.
  final String reason;

  @override
  String get code => 'host_not_ready';
}

class MutationUnknownHost extends MutationOutcome {
  const MutationUnknownHost();

  @override
  String get code => 'unknown_host';
}
