import '../../models/cell.dart';
import '../shared/age_label.dart';

/// How one row of Home reads — derived from a [Cell], with no widget involved.
///
/// Pulled out of the row widget so the rules are testable as values rather than by
/// pumping a widget tree and reading rendered text. Everything here comes from the
/// locked mockup (`design/pocket-flow.html`, `.item` / `.state` / `.line2`) and
/// `MVP.md` §2; nothing here decides colour or size — that is the widget's job, and
/// it takes them from `context.tokens`.
class CellPresentation {
  const CellPresentation({
    required this.name,
    required this.runner,
    required this.state,
    required this.detail,
    required this.detailIsMono,
    required this.emphasised,
  });

  /// Persona name, never the pane id — the operator thinks "Atlas", not `cell-7f3a`.
  final String name;

  /// The runner, rendered small and mono — the host's own name for it (`acme`,
  /// `Claude Code`) when it sends one, else the family (`claude`, `codex`).
  ///
  /// The desktop's node header prints the same string, and that is the point: the two
  /// screens were describing one cell with two different words.
  final String runner;

  /// The uppercase status word: `waiting`, `running`, `unknown`, `error`, or
  /// whatever else the host reports.
  final String state;

  /// The second line. Empty when there is genuinely nothing to say — the widget
  /// then draws no line at all rather than an empty one that still takes height.
  final String detail;

  /// Whether [detail] is machine output (mono) or the agent's own words (sans).
  ///
  /// The mockup splits these deliberately: `6 of 13 suites` and
  /// `never asks · quiet 4m` are mono, while the question a waiting agent is asking
  /// (`Delete src/legacy/shim.ts?`) is sans. Same discipline as the Agent page —
  /// mono is what it DID, prose is what it SAID.
  final bool detailIsMono;

  /// The one row allowed to shout: bigger name, full-strength text, amber mark and
  /// state. True only for a cell actually waiting on the operator (`MVP.md` §2).
  final bool emphasised;

  factory CellPresentation.of(Cell cell) {
    final waiting = cell.needsInput;
    return CellPresentation(
      name: cell.title,
      runner: cell.runner,
      state: _state(cell),
      detail: _detail(cell),
      // A waiting cell's detail is the question it is asking; everyone else's is
      // status output.
      detailIsMono: !waiting,
      emphasised: waiting,
    );
  }

  /// The word at the row's right edge, lowercase, in the operator's vocabulary.
  ///
  /// `needs you` rather than `waiting` because it says who it is waiting *for*; `quiet`
  /// rather than `unknown` because that is the word `HomeSummary` already uses for the
  /// same cells, and an uppercase UNKNOWN on every Codex row read as an alarm about
  /// nothing (measured on a paired phone, 2026-08-27: four rows, four UNKNOWNs). Any
  /// other turn the host names passes through as-is — a new state stays visible.
  static String _state(Cell cell) {
    if (cell.needsInput) return 'needs you';
    if (!cell.turnKnown) return 'quiet';
    return cell.turn!;
  }

  static String _detail(Cell cell) {
    // A cell that can never ask explains its own silence, because silence from this
    // runner means something different than silence from a Claude cell.
    if (!cell.turnKnown && cell.neverAsks) {
      final quiet = ageLabel(cell.turnAgeMs);
      return quiet == null ? 'never asks' : 'never asks · quiet $quiet';
    }
    // A waiting cell's line is its question (the preview *is* the prompt then); for
    // everyone else the ask outranks the tail — `explain the uncommitted changes` tells
    // the operator more than `❯ ` or the last test name ever will.
    final headline = cell.headline;
    if (!cell.needsInput && headline != null && headline.isNotEmpty) return headline;
    final preview = cell.lastOutputPreview;
    if (preview != null && preview.isNotEmpty) return preview;
    // No output to quote, but the host did say *how long* it has been like this — and
    // that is the headline an operator glancing down a list actually wants: `idle 12m`
    // is "safe to ignore", `quiet 4m` is "nothing heard, not long". Measured on a paired
    // phone (2026-08-27): four rows, none with a preview, so every second line was
    // blank and the list had nothing to say about any of them. Still empty when the
    // host sent no age either — a line invented from nothing would be the placeholder
    // the test below forbids.
    final age = ageLabel(cell.turnAgeMs);
    return age == null ? '' : '${_state(cell)} $age';
  }
}
