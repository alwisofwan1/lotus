import '../../models/cell.dart';

/// The state word in the header's status line — `needs you`, `working`, `idle`.
///
/// A word per state rather than the latest output line, which the header used to carry
/// on a row of its own (v4 tiket 03 folds the header into one row). What the agent is
/// doing *right now* is still on screen: at the foot of the transcript, as [liveLabel].
/// `needs you` is the only one painted amber, and it is a different word as well as a
/// different colour, so the state never rests on colour alone.
String stateLabel(Cell cell) {
  if (cell.needsInput) return 'needs you';
  if (!cell.turnKnown) return cell.neverAsks ? 'never asks' : 'state unknown';
  if (cell.isIdle) return 'idle';
  return 'working';
}

/// The same phrase again at the end of the transcript, but only while the agent is
/// actually working.
///
/// Null for every other state on purpose. `needs you` is the header's amber and must not
/// be echoed in a second place; an idle agent has finished; and an agent whose turn is
/// unknown has nothing live to report — a marker beside "state unknown" would be a claim
/// the app cannot support, which is the failure `MVP.md` spends a whole rule avoiding.
String? liveLabel(Cell cell) {
  if (cell.needsInput || !cell.turnKnown || cell.isIdle) return null;
  final doing = cell.lastOutputPreview ?? cell.turn;
  if (doing == null || doing.trim().isEmpty) return null;
  return '${cell.title.toLowerCase()} · $doing';
}
