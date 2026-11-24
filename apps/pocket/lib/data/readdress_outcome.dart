/// What one attempt at moving a host to a new address did.
///
/// Three cases, and deliberately none of them about reachability: re-addressing does
/// not dial anything. It rewrites where this phone will look, and the socket then
/// succeeds or fails on its own and reports itself through the registry, the way it
/// does for every other host. A "could not reach it" case here would be this screen
/// inventing a second, worse copy of the diagnosis it is already displaying.
sealed class ReaddressOutcome {
  const ReaddressOutcome();

  /// Stable slug for logs. Not user-facing copy — that lives in `features/`.
  String get code;
}

/// Stored and reconnecting. The token is the same one: a machine that changed IP is
/// still the machine that issued it.
class ReaddressDone extends ReaddressOutcome {
  const ReaddressDone();

  @override
  String get code => 'readdressed';
}

/// The typed address never resolved into something dialable. Caught before anything is
/// written, so a slip leaves the old address intact and the host still reachable if it
/// ever was.
class ReaddressUnreadable extends ReaddressOutcome {
  const ReaddressUnreadable(this.reason);

  final String reason;

  @override
  String get code => 'address_unreadable';
}

/// Proof of presence was not given.
///
/// Gated where unpairing is not, and the asymmetry is the point (see
/// `PairingRepository.readdress`): refusing here changes nothing and everything keeps
/// working, while a gate on unpairing could trap a phone holding a dead credential it
/// is not allowed to drop.
class ReaddressRefused extends ReaddressOutcome {
  const ReaddressRefused();

  @override
  String get code => 'refused';
}
