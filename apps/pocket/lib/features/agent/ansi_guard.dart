/// Drops terminal protocols this emulator mis-parses, before it sees them.
///
/// Two measured incompatibilities live here:
///
/// * Claude Code opens a session with `CSI > 4 ; 2 m` — xterm's `modifyOtherKeys`
///   handshake. `xterm.dart` 4.0.0 ignores its private prefix and applies underline and
///   faint to every later cell.
/// * Codex can emit terminal-pet PNGs through Kitty graphics (`APC G ... ST`). The
///   emulator has no Kitty renderer and exposes the encoded image body as Base64 text.
///
/// Proven by feeding the library 12,979 captured bytes and reading the cell flags back:
/// 584 of 584 cells carried underline, while the stream contained `ESC[4m` zero times.
/// Reduced to three lines: `write('\x1b[>4;2m X')` → flags `0xa`.
///
/// Dropping those inputs costs nothing on this surface: private `m` sequences negotiate
/// keyboard behaviour for a read-only terminal (ADR-6), and an unsupported graphics
/// protocol has no visible representation the emulator could preserve.
///
/// CSI handling remains deliberately narrow: only a private prefix **and** a final `m`
/// are dropped.
/// `CSI ? 1049 h` (the alternate screen) shares the private prefix and must survive —
/// it is the single most load-bearing sequence on this screen, because it is what a TUI
/// draws on (`issues/03`).
///
/// Lives in `features/` rather than in `OutputBuffer`, whose own doc is explicit that it
/// is "deliberately **not** an ANSI interpreter": this is a property of the emulator
/// being fed, so it belongs beside it. The day the emulator is replaced, this is deleted
/// with it rather than left behind in the data layer.
class AnsiGuard {
  /// A sequence split across two socket frames, held until its final byte arrives.
  ///
  /// Not optional. `OutputBuffer` guarantees whole chunks in order but says nothing
  /// about where a chunk *ends*, and an escape sequence cut in half by the network
  /// would otherwise be passed through as two harmless-looking fragments — reassembled
  /// by the emulator into the very sequence this class exists to remove.
  String _pending = '';

  /// Whether a Kitty graphics APC is being discarded until its string terminator.
  ///
  /// This is state rather than a buffered string because an image payload can be many
  /// megabytes. Holding the payload would replace a rendering bug with a memory spike.
  bool _droppingKittyGraphics = false;

  bool _addressesCursor = false;

  /// Whether this pane paints a screen rather than printing lines.
  ///
  /// **Not `CSI ? 1049 h`, and that correction cost a device round.** The alternate
  /// screen is announced exactly once, when the session starts — and the host replays a
  /// 64 KB ring, so by the time a phone attaches to a working agent that announcement
  /// has long scrolled out. Detection built on it reports "line-based" for every TUI the
  /// operator actually opens, and reflowing a TUI is the one thing `issues/03` proved
  /// destroys it.
  ///
  /// What is checked instead is what a screen-painter *keeps doing*: addressing the
  /// cursor by coordinate and erasing regions to redraw them. Those recur on every
  /// frame, so the signal is present in any window of bytes rather than only in the
  /// first one.
  ///
  /// Sticky, because the cost is asymmetric: pinning line-based output wastes some
  /// width, while reflowing a screen destroys it.
  bool get paintsScreen => _addressesCursor;

  static const int _escape = 0x1b;
  static const int _bracket = 0x5b; // [
  static const int _underscore = 0x5f; // _
  static const int _capitalG = 0x47; // G

  /// Whether a byte may open a private parameter list: `<`, `=`, `>`, `?`.
  static bool _isPrivatePrefix(int c) => c >= 0x3c && c <= 0x3f;

  /// Parameter bytes of a CSI sequence: digits, `;`, `:`, and the private prefixes.
  static bool _isParameter(int c) => c >= 0x30 && c <= 0x3f;

  /// Intermediate bytes — space through `/`. Rare, but part of the grammar.
  static bool _isIntermediate(int c) => c >= 0x20 && c <= 0x2f;

  /// Final byte of a CSI sequence: `@` through `~`.
  static bool _isFinal(int c) => c >= 0x40 && c <= 0x7e;

  /// Passes [chunk] through, minus the sequences above.
  ///
  /// Returns everything that is safe to render now; an unterminated sequence at the end
  /// is withheld and prepended to the next call.
  String pass(String chunk) {
    final input = _pending.isEmpty ? chunk : _pending + chunk;
    _pending = '';

    final out = StringBuffer();
    var i = 0;

    while (i < input.length) {
      if (_droppingKittyGraphics) {
        final end = input.indexOf('\x1b\\', i);
        if (end < 0) {
          // ST itself may straddle socket frames. Retain only its possible ESC prefix,
          // never the image body.
          if (input.codeUnitAt(input.length - 1) == _escape) {
            _pending = input.substring(input.length - 1);
          }
          return out.toString();
        }
        _droppingKittyGraphics = false;
        i = end + 2;
        continue;
      }

      final c = input.codeUnitAt(i);

      // Kitty graphics is an APC introduced by `ESC _ G` and closed by ST (`ESC \\`).
      // xterm.dart has no graphics implementation, so passing the command through makes
      // its Base64-encoded PNG body visible as terminal text.
      if (c == _escape &&
          i + 1 < input.length &&
          input.codeUnitAt(i + 1) == _underscore) {
        if (i + 2 >= input.length) {
          _pending = input.substring(i);
          return out.toString();
        }
        if (input.codeUnitAt(i + 2) == _capitalG) {
          _droppingKittyGraphics = true;
          i += 3;
          continue;
        }
      }

      // Anything that is not the start of a CSI sequence is copied verbatim. That is
      // the overwhelming majority of the stream, and it never gets inspected twice.
      if (c != _escape || i + 1 >= input.length || input.codeUnitAt(i + 1) != _bracket) {
        // An `ESC` as the very last character could still begin one.
        if (c == _escape && i + 1 >= input.length) {
          _pending = input.substring(i);
          return out.toString();
        }
        out.writeCharCode(c);
        i++;
        continue;
      }

      final start = i;
      var j = i + 2;
      final private = j < input.length && _isPrivatePrefix(input.codeUnitAt(j));

      while (j < input.length && _isParameter(input.codeUnitAt(j))) {
        j++;
      }
      while (j < input.length && _isIntermediate(input.codeUnitAt(j))) {
        j++;
      }

      // Ran out before the final byte: hold the fragment rather than guess at it.
      if (j >= input.length || !_isFinal(input.codeUnitAt(j))) {
        _pending = input.substring(start);
        return out.toString();
      }

      final finalByte = input.codeUnitAt(j);
      final isSgr = finalByte == 0x6d; // m
      if (!private) _noteScreenPainting(finalByte);
      if (!(private && isSgr)) out.write(input.substring(start, j + 1));
      i = j + 1;
    }

    return out.toString();
  }

  /// The final bytes that mean "put the cursor somewhere" or "erase this to redraw it".
  ///
  /// `H`/`f` absolute position, `A`/`B`/`C`/`D` relative moves, `J`/`K` erase in
  /// display/line, `d`/`G` absolute row/column. Deliberately **not** `\r` or `\n`,
  /// which every ordinary command emits, and not the private `?` forms — a mouse or
  /// bracketed-paste toggle says nothing about how the output is shaped.
  static const Set<int> _screenPainting = {
    0x48, 0x66, // H f
    0x41, 0x42, 0x43, 0x44, // A B C D
    0x4a, 0x4b, // J K
    0x64, 0x47, // d G
  };

  void _noteScreenPainting(int finalByte) {
    if (_screenPainting.contains(finalByte)) _addressesCursor = true;
  }
}
