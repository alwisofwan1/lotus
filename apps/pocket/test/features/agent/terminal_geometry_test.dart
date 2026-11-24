import 'package:flutter_test/flutter_test.dart';
import 'package:xterm/xterm.dart';
import 'package:lotus_pocket/features/agent/terminal_geometry.dart';

void main() {
  Terminal roomy() => Terminal(maxLines: 4000, reflowEnabled: false)
    ..resize(TerminalGeometry.roomyColumns, TerminalGeometry.roomyRows);

  group('TerminalGeometry.of — measured over what is drawn', () {
    test('a wide line that scrolled out no longer stretches the surface', () {
      // TerminalView sticks to the bottom, so only the last `viewHeight` lines are ever
      // on screen. Measuring the whole buffer sized the pan surface to a line thousands
      // of rows back: measured 2026-08-09 at 160 columns against a window whose widest
      // line was 15, leaving 145 columns of nothing to pan across.
      final t = roomy();
      t.write('${'W' * 190}\r\n');
      for (var i = 0; i < 3000; i++) {
        t.write('short $i\r\n');
      }

      // The short lines clamp up to the floor rather than down from the scrolled-out one.
      expect(TerminalGeometry.of(t).columns, TerminalGeometry.minColumns);
    });

    test('a wide line still inside the window is measured', () {
      final t = roomy();
      t.write('${'W' * 120}\r\n');
      for (var i = 0; i < 10; i++) {
        t.write('short $i\r\n');
      }

      expect(TerminalGeometry.of(t).columns, 120);
    });

    test('an alternate-screen TUI is unchanged: buffer and window are the same thing', () {
      final t = roomy();
      t.write('\x1b[?1049h');
      for (var i = 0; i < 600; i++) {
        t.write('\x1b[${(i % 48) + 1};1H\x1b[2K${'painted row ${i % 48}'.padRight(90)}');
      }

      expect(t.buffer.lines.length, TerminalGeometry.roomyRows);
      expect(TerminalGeometry.of(t).columns, 90);
    });

    test('a buffer shorter than the window keeps counting from its own top', () {
      final t = roomy();
      t.write('one\r\ntwo\r\nthree\r\n');

      expect(TerminalGeometry.of(t).rows, TerminalGeometry.minRows);
    });
  });

  group('cursorRowInWindow — where the cursor sits in the rows actually drawn', () {
    test('an alternate-screen TUI is unchanged: the window is the whole buffer', () {
      // Claude Code paints in place, so xterm recycles lines rather than growing the
      // buffer (Buffer.index → scrollUp on the alt buffer). Absolute and windowed agree.
      expect(cursorRowInWindow(absoluteCursorY: 23, totalLines: 48, rows: 48), 23);
      expect(cursorRowInWindow(absoluteCursorY: 0, totalLines: 48, rows: 48), 0);
    });

    test('a scrolling CLI is measured from the top of the window, not the buffer', () {
      // Codex redraws inline on the MAIN screen, so the buffer grows (Buffer.index →
      // lines.push) and absoluteCursorY runs into the thousands. The surface only ever
      // draws the last `rows` lines — TerminalView sticks to the bottom — so an absolute
      // row aimed the viewport thousands of lines below anything drawn, and the pane went
      // blank. Measured on a device 2026-08-09: 1200 rows deep against a 48-row box.
      expect(cursorRowInWindow(absoluteCursorY: 1200, totalLines: 1201, rows: 48), 47);
      expect(cursorRowInWindow(absoluteCursorY: 1153, totalLines: 1201, rows: 48), 0);
    });

    test('never points outside the drawn window', () {
      expect(cursorRowInWindow(absoluteCursorY: 5000, totalLines: 1201, rows: 48), 47);
      expect(cursorRowInWindow(absoluteCursorY: 2, totalLines: 1201, rows: 48), 0);
      expect(cursorRowInWindow(absoluteCursorY: -1, totalLines: 48, rows: 48), 0);
    });

    /// LOT2-103, measured on a device 2026-10-04: the emulator is built 48 rows deep and
    /// a Claude pane used 21 of them — the **top** 21. The window was taken from the
    /// bottom, so the cursor on row 16 read as row 0.
    test('a host shorter than the emulator is the top of the screen, not the bottom', () {
      expect(
        cursorRowInWindow(absoluteCursorY: 16, totalLines: 48, rows: 21, screen: 48),
        16,
      );
      // With scrollback the screen starts `screen` lines from the end.
      expect(
        cursorRowInWindow(absoluteCursorY: 1170, totalLines: 1201, rows: 21, screen: 48),
        17,
      );
    });

    test('survives a buffer shorter than the window, and a window of nothing', () {
      expect(cursorRowInWindow(absoluteCursorY: 3, totalLines: 4, rows: 48), 3);
      expect(cursorRowInWindow(absoluteCursorY: 3, totalLines: 0, rows: 0), 0);
    });
  });
}
