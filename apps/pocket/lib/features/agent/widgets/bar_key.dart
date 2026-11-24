import 'package:flutter/foundation.dart';
import 'package:xterm/xterm.dart';

/// One key, as the emulator will encode it.
@immutable
class BarKey {
  const BarKey(
    this.label, {
    this.key,
    this.char,
    this.bytes,
    this.semantics,
    this.shift = false,
    this.twice = false,
  });

  final String label;

  /// A named key — the emulator's keytab decides the bytes, which is the only place
  /// that knows whether this pane wants `ESC [ A` or `ESC O A` for an arrow.
  final TerminalKey? key;

  /// A character, sent with whatever modifiers are held.
  final String? char;

  final String? semantics;

  /// Exact bytes, for the one key whose keytab encoding is wrong for the program reading
  /// it — `S-enter` (see `KeyBar`'s Claude row). Sent as they are, modifiers ignored.
  final String? bytes;

  /// Sent with shift — `S-tab`.
  final bool shift;

  /// Sent twice from one press — `esc²`, the rewind, which half a press would not be.
  final bool twice;
}
