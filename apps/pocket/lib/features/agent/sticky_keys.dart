import 'package:flutter/foundation.dart';
import 'package:xterm/xterm.dart';

enum Modifier { ctrl, alt }

/// Off, held for the next key, or held until tapped again.
enum StickyState { off, once, locked }

/// ctrl and alt as a thumb can hold them: tap once for the next key, twice to lock.
///
/// **Shared by the key bar and the phone's own keyboard** (v4 tiket 05). Before, the bar
/// kept its own ctrl and only its own caps read it, so ctrl then `c` on the phone's
/// keyboard sent a plain `c` — and ctrl+letter is the reason ctrl exists at all.
///
/// The phone's letters reach the emulator as key events (`TerminalView._onInsert` tries
/// `keyInput` first), so [wrap] adds what is held to the emulator's own input handler and
/// the keytab still does the encoding — except for a letter under alt, below.
///
/// **A held key is spent by typing, never by output.** The emulator also speaks on its own
/// — replies to the host's queries, mouse reports — and an earlier version that let go on
/// every outgoing byte lost the ctrl to a device-attributes reply (review, 2026-10-04). So
/// [spend] is called from the three places a key is actually typed: the wrapped handler,
/// the phone's text input (`TerminalFeed.onTyped`), and the key bar.
class StickyKeys extends ChangeNotifier {
  StickyKeys({DateTime Function()? clock}) : _clock = clock ?? DateTime.now;

  final DateTime Function() _clock;

  /// How close the second tap must follow the first to lock rather than let go.
  static const Duration lockWindow = Duration(milliseconds: 400);

  StickyState _ctrl = StickyState.off;
  StickyState _alt = StickyState.off;
  DateTime? _ctrlTap;
  DateTime? _altTap;

  /// Whether the lock has been named this app session. Once is enough: a hint that
  /// returns on every lock is a hint the thumb learns to ignore.
  static bool _hinted = false;

  bool _hint = false;

  /// Whether `ctrl locked · tap ctrl to release` shows now — the first lock of a session,
  /// for as long as it lasts.
  bool get lockHint => _hint;

  @visibleForTesting
  static void debugResetHint() => _hinted = false;

  StickyState get ctrl => _ctrl;
  StickyState get alt => _alt;
  bool get ctrlHeld => _ctrl != StickyState.off;
  bool get altHeld => _alt != StickyState.off;

  void tap(Modifier m) {
    final now = _clock();
    final last = m == Modifier.ctrl ? _ctrlTap : _altTap;
    final from = m == Modifier.ctrl ? _ctrl : _alt;
    final quick = last != null && now.difference(last) <= lockWindow;
    final to = switch (from) {
      StickyState.off => StickyState.once,
      StickyState.once => quick ? StickyState.locked : StickyState.off,
      StickyState.locked => StickyState.off,
    };
    if (m == Modifier.ctrl) {
      _ctrl = to;
      _ctrlTap = now;
      _hint = to == StickyState.locked && !_hinted;
      if (_hint) _hinted = true;
    } else {
      _alt = to;
      _altTap = now;
    }
    notifyListeners();
  }

  /// A key went out: what was held for one key lets go; a lock stays.
  void spend() {
    final ctrl = _ctrl == StickyState.once ? StickyState.off : _ctrl;
    final alt = _alt == StickyState.once ? StickyState.off : _alt;
    if (ctrl == _ctrl && alt == _alt) return;
    _ctrl = ctrl;
    _alt = alt;
    notifyListeners();
  }

  /// Both off — when the pane stops taking keys, nothing should be left held for later.
  void release() {
    if (!ctrlHeld && !altHeld) return;
    _ctrl = _alt = StickyState.off;
    _hint = false;
    notifyListeners();
  }

  /// The emulator's input handler, with whatever is held added to every key event.
  TerminalInputHandler wrap(TerminalInputHandler inner) => _Held(this, inner);
}

class _Held implements TerminalInputHandler {
  const _Held(this.sticky, this.inner);

  final StickyKeys sticky;
  final TerminalInputHandler inner;

  @override
  String? call(TerminalKeyboardEvent event) {
    final ctrl = event.ctrl || sticky.ctrlHeld;
    final alt = event.alt || sticky.altHeld;
    final out = (sticky.altHeld && _letter(event.key) != null)
        ? _metaLetter(event.key, ctrl: ctrl, shift: event.shift)
        : inner(ctrl == event.ctrl && alt == event.alt
            ? event
            : event.copyWith(ctrl: ctrl, alt: alt));
    sticky.spend();
    return out;
  }

  static int? _letter(TerminalKey key) {
    final i = key.index - TerminalKey.keyA.index;
    return i >= 0 && i < 26 ? i : null;
  }

  /// alt + a letter, encoded here rather than by the package: its `AltInputHandler`
  /// upper-cases the letter (`ESC B` for alt-b, which readline reads as meta-shift-b), and
  /// with ctrl also held neither of its handlers takes the key, so the bare letter went out.
  /// Meta is `ESC` in front of whatever the key would have been: the control byte under
  /// ctrl, the letter as typed otherwise.
  static String _metaLetter(TerminalKey key, {required bool ctrl, required bool shift}) {
    final i = _letter(key)!;
    final base = ctrl ? i + 1 : (shift ? 0x41 : 0x61) + i;
    return '\x1b${String.fromCharCode(base)}';
  }
}
