import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/agent/ansi_guard.dart';
import 'package:xterm/xterm.dart';

/// The handshake Claude Code opens a session with: xterm's `modifyOtherKeys`, a
/// *private* sequence marked by the `>` before its parameters.
const String modifyOtherKeys = '\x1b[>4;2m';

/// Flags on the cell at [column] after writing [input] to a real emulator.
int flagsAfter(String input, {int column = 1}) {
  final terminal = Terminal(maxLines: 100, reflowEnabled: false);
  terminal.resize(120, 45);
  terminal.write(input);
  final line = terminal.buffer.lines[terminal.buffer.cursorY];
  final cell = CellData.empty();
  line.getCellData(column, cell);
  return cell.flags;
}

String guarded(String input) => AnsiGuard().pass(input);

void main() {
  group('the bug this exists for', () {
    test('xterm.dart reads a private SGR as a real one — underline and faint', () {
      // Reduced from 12,979 bytes captured off a live host on 2026-08-08, where 584 of
      // 584 cells came back underlined while the stream contained `ESC[4m` zero times.
      // `CSI > 4 ; 2 m` negotiates keyboard reporting and means nothing on screen; the
      // library ignores the `>` and applies SGR 4 (underline) and 2 (faint).
      expect(flagsAfter('$modifyOtherKeys X'), CellFlags.underline | CellFlags.faint);
    });

    test('and nothing resets it, so every later cell inherits it', () {
      final flags = flagsAfter('$modifyOtherKeys hello world', column: 8);

      expect(flags & CellFlags.underline, isNot(0));
    });

    test('through the guard, the same bytes leave the cell untouched', () {
      expect(flagsAfter(guarded('$modifyOtherKeys X')), 0);
    });
  });

  group('what must survive, because the screen depends on it', () {
    test('the alternate screen — a TUI has nothing to draw on without it', () {
      // Shares the private prefix and is the single most load-bearing sequence here
      // (`issues/03`): it is what an agent's TUI actually draws on.
      expect(guarded('\x1b[?1049hbody'), '\x1b[?1049hbody');
    });

    test('ordinary colour and attributes', () {
      expect(guarded('\x1b[38;2;215;119;87mx\x1b[0m'), '\x1b[38;2;215;119;87mx\x1b[0m');
    });

    test('a genuine underline the agent asked for', () {
      expect(flagsAfter(guarded('\x1b[4m X')) & CellFlags.underline, isNot(0));
    });

    test('private sequences that do not end in m are none of this class\'s business', () {
      expect(guarded('\x1b[>1u\x1b[<u'), '\x1b[>1u\x1b[<u');
    });

    test('plain text is returned exactly, including newlines', () {
      expect(guarded('one\ntwo\r\n'), 'one\ntwo\r\n');
    });
  });

  group('telling a screen-painter from a line-printer', () {
    test('ordinary output claims nothing', () {
      final guard = AnsiGuard();
      guard.pass('commit 4536 fix(pocket): a subject\n\x1b[38;5;153mgreen\x1b[0m\n');

      expect(guard.paintsScreen, isFalse);
    });

    test('erasing and addressing the cursor does', () {
      final guard = AnsiGuard();
      guard.pass('\x1b[2J\x1b[12;1Hredraw');

      expect(guard.paintsScreen, isTrue);
    });

    test('the alternate-screen switch is deliberately not the signal', () {
      // It is announced once at session start and the host replays a 64 KB ring, so by
      // the time a phone attaches to a working agent it has scrolled out. A detector
      // built on it calls every real TUI line-based — measured on a device 2026-08-08,
      // and it reflowed a Claude session into overlapping nonsense.
      final guard = AnsiGuard();
      guard.pass('\x1b[?1049h');

      expect(guard.paintsScreen, isFalse);
    });

    test('once true it stays true, because the two mistakes cost differently', () {
      final guard = AnsiGuard();
      guard.pass('\x1b[2J\x1b[1;1H');
      guard.pass('just some text with no escapes at all\n');

      // Pinning line-based output wastes width; reflowing a screen destroys it.
      expect(guard.paintsScreen, isTrue);
    });

    test('a private toggle is not cursor addressing', () {
      final guard = AnsiGuard();
      guard.pass('\x1b[?25l\x1b[?2004h');

      expect(guard.paintsScreen, isFalse);
    });
  });

  group('a sequence cut in half by the network', () {
    test('is withheld and rejoined rather than passed through as fragments', () {
      final guard = AnsiGuard();

      // `OutputBuffer` guarantees whole chunks in order, but says nothing about where a
      // chunk *ends*. Split naively, these two halves look harmless and the emulator
      // reassembles the very sequence this class removes.
      expect(guard.pass('before\x1b[>4'), 'before');
      expect(guard.pass(';2mafter'), 'after');
    });

    test('a kept sequence split the same way still arrives whole', () {
      final guard = AnsiGuard();

      expect(guard.pass('a\x1b[?10'), 'a');
      expect(guard.pass('49hb'), '\x1b[?1049hb');
    });

    test('a lone trailing ESC is held, not emitted', () {
      final guard = AnsiGuard();

      expect(guard.pass('tail\x1b'), 'tail');
      expect(guard.pass('[0mx'), '\x1b[0mx');
    });
  });

  group('Kitty graphics unsupported by the Pocket emulator', () {
    test('drops a complete image command without leaking its PNG payload', () {
      const kittyPng = '\x1b_Ga=T,f=100,m=0;iVBORw0KGgoAAAANSUhEUgAA\x1b\\';

      expect(guarded('before$kittyPng after'), 'before after');
    });

    test('drops one image command split across network frames', () {
      final guard = AnsiGuard();

      expect(guard.pass('before\x1b_Ga=T,f=100,m=1;iVBORw0'), 'before');
      expect(guard.pass('KGgoAAAANSUhEUgAA\x1b\\after'), 'after');
    });

    test(
      'holds a split string terminator until it can close the image command',
      () {
        final guard = AnsiGuard();

        expect(guard.pass('\x1b_Ga=T,f=100,m=0;iVBORw0KGgo\x1b'), '');
        expect(guard.pass('\\prompt> '), 'prompt> ');
      },
    );

    test('preserves a non-Kitty APC command', () {
      const otherApc = '\x1b_other-protocol\x1b\\';

      expect(guarded(otherApc), otherApc);
    });
  });
}
