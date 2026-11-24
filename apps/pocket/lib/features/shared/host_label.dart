/// How a host's id reads on screen.
///
/// The mockup wrote `mac` and `vps`, which were names invented for the mockup. What a
/// real host sends is its machine hostname — measured 2026-08-06:
/// `Alwis-MacBook-Air.local`. In the Agent header that string sits beside the project
/// in a corner that shares a line with the persona, and at full length it squeezed
/// `Atlas` down to `A...` — the most important word on the page losing to the least.
///
/// `.local` is the mDNS suffix. It is true and it is useless to a human: every machine
/// on the network has it, so it distinguishes nothing, which is the only job this label
/// has (R-10). Dropping it is not shortening for its own sake.
String shortHostLabel(String hostId) {
  const suffix = '.local';
  final trimmed = hostId.trim();
  if (trimmed.length <= suffix.length || !trimmed.endsWith(suffix)) return trimmed;
  return trimmed.substring(0, trimmed.length - suffix.length);
}

/// The machine's name where a screen prints it, or **empty when it qualifies nothing**.
///
/// The label has exactly one job: keeping two same-named projects apart (R-10). With a
/// single paired machine there is nothing to keep apart — every row would carry the
/// same word — and that word is not small: a real host announces itself as
/// `Alwis-MacBook-Air.local`, which sat beside project names it dwarfed in the title,
/// in every switcher row, and in the Agent header's corner.
///
/// This is [shortHostLabel]'s own argument, applied one step further: a label every row
/// shares distinguishes nothing, so dropping it is not shortening for its own sake.
///
/// One function rather than a rule repeated at three call sites, because three copies
/// is how they begin to disagree (`issues/11`).
String hostQualifier(String hostLabel, {required int pairedHosts}) =>
    pairedHosts < 2 ? '' : shortHostLabel(hostLabel);

/// What to pre-fill the "name this machine" field with.
///
/// Deliberately not clever. `.local` goes, then the first segment before a `-`:
/// `Alwis-MacBook-Air.local` → `Alwis`, `vps-frankfurt` → `vps`, `studio` → `studio`.
/// It is wrong about as often as it is right, and that is acceptable **because the
/// field is editable at the moment it is offered** — a bad guess costs one tap, and
/// costs it exactly once.
///
/// The alternative, a rule that inspects the machine to produce something better,
/// would be wrong on some machine too and would be wrong invisibly, in a function
/// nobody thinks to look at. The person holding the phone already knows the answer;
/// the guess exists to save typing, not to replace them.
String suggestedNickname(String hostLabel) {
  final base = shortHostLabel(hostLabel);
  final head = base.split('-').first.trim();
  return head.isEmpty ? base : head;
}
