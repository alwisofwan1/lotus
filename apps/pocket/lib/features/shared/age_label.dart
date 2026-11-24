/// `4m` from 240000 — the compact age both Home rows and the Agent header show.
///
/// Returns null when the host sent no age at all, which is the normal case for exactly
/// the cells it is most wanted for: a runner that reports no `turn` is sent no
/// `turnAgeMs` either (`contract/fixtures/rest-bootstrap.json` — the `codex` cell
/// carries neither). Null means "draw nothing"; the alternative would be printing a
/// duration nobody measured.
///
/// Shared rather than duplicated because two surfaces render the same number, and two
/// copies would eventually disagree about where minutes become hours.
String? ageLabel(int? milliseconds) {
  if (milliseconds == null) return null;
  final seconds = milliseconds ~/ 1000;
  if (seconds < 60) return '${seconds}s';
  final minutes = seconds ~/ 60;
  if (minutes < 60) return '${minutes}m';
  return '${minutes ~/ 60}h';
}
