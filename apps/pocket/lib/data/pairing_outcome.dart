import '../hosts/host_failure.dart';
import '../models/pairing.dart';

/// What one attempt at pairing did.
///
/// Same rule as [MutationOutcome]: a case exists only when the operator's next move
/// differs. That is a sharper filter here than anywhere else in the app, because
/// onboarding is the screen where a wrong diagnosis costs the most — it is the only
/// screen, there is nothing else to look at, and every failure looks identical from
/// the outside ("it did not pair").
///
/// The wording each case is rendered with is **provisional**: `issues/06` owns the
/// final copy for the reachability states and is still blocked on `issues/02`. The
/// distinctions are not provisional, which is why they are types.
sealed class PairingOutcome {
  const PairingOutcome();

  /// Stable slug for logs. Not user-facing copy — that lives in `features/`.
  String get code;
}

/// Paired. The credential is stored, the host is registered, and its socket is
/// already dialling.
class PairingSucceeded extends PairingOutcome {
  const PairingSucceeded(this.device);

  final PairedDevice device;

  @override
  String get code => 'paired';
}

/// The address never resolved into something dialable — a typo, caught here.
class PairingAddressUnreadable extends PairingOutcome {
  const PairingAddressUnreadable(this.reason);

  final String reason;

  @override
  String get code => 'address_unreadable';
}

/// 401 from `POST /m/pair`: wrong code, already used, or past its five minutes.
///
/// Not a reachability failure and must never be shown as one — the phone reached the
/// host perfectly well. The fix is a new code on the desktop, and only that.
class PairingCodeRefused extends PairingOutcome {
  const PairingCodeRefused();

  @override
  String get code => 'code_refused';
}

/// 429 from `POST /m/pair`: the host is throttling this source, or redeeming is locked
/// out after five failed codes (`issues/09`).
///
/// Neither a refused code nor a broken host, and that is the whole reason it exists:
/// the code in the operator's hand may be perfectly good, and waiting is a move no
/// other case here asks for. [reason] is the host's own sentence — it is the only side
/// that knows whether this is ten seconds or a fresh code.
class PairingThrottled extends PairingOutcome {
  const PairingThrottled(this.reason);

  final String reason;

  @override
  String get code => 'throttled';
}

/// The request never arrived. [failure] already separates the tailnet being down from
/// a sleeping machine from a machine with no Lotus running — the distinction
/// `MobileTab.tsx` makes on the desktop side, and the reason that taxonomy exists.
class PairingUnreachable extends PairingOutcome {
  const PairingUnreachable(this.failure);

  final HostFailure failure;

  @override
  String get code => 'unreachable';
}

/// Something answered, and it was not a host that pairs: a 400, a 5xx, or a proxy's
/// HTML. Carries what came back rather than replacing it with friendlier copy — this
/// is the case where the operator's own eyes are the best diagnostic left.
class PairingHostFaulted extends PairingOutcome {
  const PairingHostFaulted(this.reason);

  final String reason;

  @override
  String get code => 'host_faulted';
}
