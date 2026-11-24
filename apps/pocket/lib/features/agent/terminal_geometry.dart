import 'package:xterm/xterm.dart';

/// How close to look at a pinned screen. **Not** whether to reflow it.
///
/// That distinction is the whole shape of this control. Whether a pane may be reflowed
/// is a question about the bytes with exactly one right answer — `issues/03` proved
/// re-wrapping a coordinate-addressed screen turns it into overlapping nonsense, and a
/// toggle for it is a button that breaks the render. Shipped as one anyway, and a phone
/// showed the result on 2026-08-08: `fort)ifying…`, ` for updatesfor 3s`, two lines
/// occupying one. Removed. What is left is the question a terminal app actually asks.
enum TerminalZoom {
  /// The host's whole width, scaled to the screen. Where every visit starts.
  fit,

  /// One cell per cell. Readable, and panned.
  actual,
}

/// How the emulator is drawn on a screen far narrower than the host's.
enum TerminalFit {
  /// Reflowed to the phone's width, scrolled vertically like any other text.
  ///
  /// Correct for **line-based** output — `git log`, test runs, stack traces, build
  /// output — which is most of what a pane emits. `issues/03` only ever measured the
  /// other case, and the conclusion it reached there (pin and pan) was applied to
  /// everything; this is the half that was being punished for the other half's problem.
  flow,

  /// Drawn at the host's own width and panned.
  ///
  /// The only correct choice for a TUI on the alternate screen: it addresses the cursor
  /// by coordinate, so re-wrapping it produces overlapping nonsense (`issues/03`).
  pinned,
}

/// Where the cursor sits **inside the rows the surface actually draws**.
///
/// The distinction is the difference between a pinned pane rendering and a pinned pane
/// going blank, and it comes down to what kind of CLI is on the other end.
///
/// `xterm`'s `absoluteCursorY` is `cursorY + scrollBack` (`buffer.dart`). On the
/// **alternate screen** — Claude Code — nothing scrolls: `Buffer.index` calls
/// `scrollUp`, lines are recycled in place, `scrollBack` stays 0, and the absolute row is
/// already a row on screen. On the **main screen** — Codex, which redraws inline instead
/// of taking over the terminal — `Buffer.index` calls `lines.push`, the buffer grows, and
/// the absolute row runs to thousands.
///
/// The surface draws one window of that buffer: `TerminalView` sticks to the bottom, so
/// what is on screen is always the last `rows` lines. Aiming a viewport at the absolute
/// row therefore pointed it thousands of lines past everything drawn, and the pane went
/// blank — measured on a device 2026-08-09 at 18,495px of translate against a 739px box.
///
/// **The window is the top of the emulator's screen, not the bottom of its buffer**
/// (LOT2-103, measured on a device 2026-10-04). The emulator is [screen] rows deep —
/// [TerminalGeometry.roomyRows] — and a host using fewer draws in the *top* [rows] of
/// it. Taken from the bottom, a 21-row Claude pane in a 48-row emulator put the cursor on
/// row 16 at row 0. [screen] defaults to [rows], where the two windows are the same.
int cursorRowInWindow({
  required int absoluteCursorY,
  required int totalLines,
  required int rows,
  int? screen,
}) {
  if (rows <= 0) return 0;
  final depth = screen ?? rows;
  final firstDrawn = totalLines > depth ? totalLines - depth : 0;
  return (absoluteCursorY - firstDrawn).clamp(0, rows - 1);
}

/// The size a pane is actually using, measured from what it drew.
///
/// **Measured, not assumed, and that replaces a hardcoded 120×45.** The client cannot
/// ask: `cols`/`rows` appear nowhere on the `/m/*` surface, re-verified 2026-08-08. The
/// old constant was chosen to be "wide enough for any plausible host", which bought a
/// correct render and paid for it with ~27 blank columns and ~33 blank rows the operator
/// had to pan across — the single loudest complaint about this screen.
///
/// Reading it back off the buffer is not a trick: the emulator has already laid every
/// cell out, so the widest line it drew *is* the width the host is using.
class TerminalGeometry {
  const TerminalGeometry({required this.columns, required this.rows});

  final int columns;
  final int rows;

  /// What a pinned emulator is built at, before anything is known.
  ///
  /// Generous on purpose — see [TerminalGeometry.of]. Wide enough to contain any
  /// plausible host so the measurement is real, deep enough that a full-screen TUI is
  /// not clipped at the bottom.
  static const int roomyColumns = 160;
  static const int roomyRows = 48;

  /// Wide enough that a pane which has drawn almost nothing still has room to grow into
  /// its first real line, rather than being re-pinned on every frame.
  static const int minColumns = 40;

  /// A ceiling, not an expectation. Past this the pan is unusable anyway, and a runaway
  /// line should not stretch the surface to the horizon.
  static const int maxColumns = 200;

  static const int minRows = 10;

  /// Measures the widest and lowest cell the pane has actually drawn.
  ///
  /// **Only truthful while the emulator is wider than the host**, and that dependency is
  /// the whole reason the pinned emulator is built generously wide rather than at the
  /// last measurement. Size it to the answer and the answer becomes the question: cells
  /// past the emulator's own width are never stored, so the measurement can only ever
  /// report back the number it was given. Measured 2026-08-08 on a device — an emulator
  /// pinned to 80 columns reported the host as exactly 80.
  ///
  /// [Terminal.viewWidth] is not used for the same reason, one step earlier: it is what
  /// the *client* asked for, never what the host is doing.
  /// Measured over the **window the surface draws**, not the whole buffer.
  ///
  /// `TerminalView` sticks to the bottom, so the last `viewHeight` lines are the only
  /// ones ever on screen. Scanning everything sized the pan surface to a line that had
  /// scrolled away thousands of rows earlier — measured 2026-08-09 at 160 columns
  /// against a window whose widest visible line was 15, so the operator panned across
  /// 145 columns of nothing to reach content that no longer existed.
  ///
  /// For an alternate-screen TUI the two are the same set of lines, so nothing changes
  /// there. For a scrolling CLI it also stops the cost growing with the session: the
  /// scan is per PTY chunk, and at a full 4000-line buffer it was 0.48 ms against
  /// 0.008 ms for a one-screen buffer — 97% of the whole per-chunk path.
  factory TerminalGeometry.of(Terminal terminal) {
    final buffer = terminal.buffer;
    final total = buffer.lines.length;
    final drawn = terminal.viewHeight;
    final first = total > drawn ? total - drawn : 0;

    var widest = 0;
    var lowest = 0;

    for (var y = first; y < total; y++) {
      final used = buffer.lines[y].getTrimmedLength();
      if (used == 0) continue;
      if (used > widest) widest = used;
      lowest = y - first + 1;
    }

    return TerminalGeometry(
      columns: widest.clamp(minColumns, maxColumns),
      rows: lowest.clamp(minRows, drawn),
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is TerminalGeometry && other.columns == columns && other.rows == rows;

  @override
  int get hashCode => Object.hash(columns, rows);

  @override
  String toString() => '$columns×$rows';
}
