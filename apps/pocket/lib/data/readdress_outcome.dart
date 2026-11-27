/// Readdressing changes the route; the socket owns reachability diagnosis.
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

/// Gate readdressing because it redirects credentials, while unpairing must remain available.
class ReaddressRefused extends ReaddressOutcome {
  const ReaddressRefused();

  @override
  String get code => 'refused';
}
