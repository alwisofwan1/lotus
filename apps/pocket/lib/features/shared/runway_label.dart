/// `44m`, `19h`, `29d` — how much of a credential is left.
///
/// Coarser as the number grows, and that is the point rather than a rounding
/// convenience: at 29 days the operator is reading "not soon", at 44 minutes they are
/// reading "before I put the phone down". Printing `29d 4h 12m` would give the same
/// weight to a digit nobody acts on.
///
/// Only defined for a duration that is still ahead. Expiry and the 30-day ceiling are
/// **words**, not numbers — `CredentialRunway.expired` and `pastCeiling` decide them,
/// because "-3h" is a value the reader has to interpret and "expired" is not.
String runwayLabel(Duration left) {
  if (left.inHours < 1) return '${left.inMinutes}m';
  // **72, not 24 or 48.** That is the TTL, so the token's whole range stays in hours and
  // `61h` can be compared against the number the operator was told. Rolling over at a day
  // would print `2d` for a credential whose limit is quoted in hours, and the reader would
  // have to convert to know whether it was fine. The ceiling is 30 days and never reaches
  // down here, so it keeps its own unit for free.
  if (left.inHours < 72) return '${left.inHours}h';
  return '${left.inDays}d';
}
