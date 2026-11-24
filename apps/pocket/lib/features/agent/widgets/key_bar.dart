import 'package:flutter/material.dart';
import '../../../models/runner_family.dart';
import 'package:flutter/services.dart';
import 'package:xterm/xterm.dart';

import '../../../app/theme/app_tokens.dart';
import '../../../app/theme/surface_tokens.dart';
import '../../shared/tactile.dart';
import '../sticky_keys.dart';
import 'arrow_pad.dart';
import 'bar_key.dart';

/// Keys a phone keyboard does not have, for a terminal that now takes them.
///
/// **Nothing here writes an escape sequence — but one.** Every press goes through
/// `Terminal.keyInput` or `Terminal.charInput`, so the bytes are produced by the same
/// emulator that is drawing the pane — it knows the cursor-key mode because it parsed
/// the stream that set it. A second opinion built into this widget could only ever
/// disagree with the first, and would be wrong exactly when it mattered. The exception
/// is `S-enter` ([BarKey.bytes]): there the keytab's answer was measured to be wrong.
///
/// **Two rows and an arrow pad, nothing to scroll** (v4 tiket 05, B2). The single row this
/// replaced showed about seven caps at 360dp and hid the rest behind a sideways scroll —
/// which is where the arrows were. Row 1 is what every pane reads (`esc` `tab` `ctrl` `alt`
/// and this runner's lead key); row 2 is this runner's own four plus `paste`; the arrows
/// are a round pad spanning both.
///
/// **ctrl and alt are shared with the phone's keyboard** through [StickyKeys]: ctrl then
/// `c` typed on the phone is `^C`. While ctrl is held, row 2 becomes the five control keys
/// a thumb reaches for, so the common ones are one tap even then.
///
/// What is *in* row 2 still follows the **runner**, from `cell.provider`: a Claude pane
/// gets the keys its TUI reads, a shell gets the ones a shell reads.
class KeyBar extends StatefulWidget {
  const KeyBar({required this.terminal, required this.provider, required this.sticky, super.key});

  final Terminal terminal;

  /// `claude`, `codex`, a custom runner id, or null. Only the Claude family gets the
  /// TUI row; everything else is treated as a shell, which is the safer default — those
  /// keys do something everywhere.
  final String? provider;

  /// ctrl and alt, held for the next key or locked — owned by the terminal, because the
  /// phone's keyboard reads them too, and spent there when a byte leaves.
  final StickyKeys sticky;

  /// The visible cap; its hit box adds 2px above and below to reach 44.
  static const double capHeight = 40;

  @override
  State<KeyBar> createState() => _KeyBarState();
}

class _KeyBarState extends State<KeyBar> {
  static const List<BarKey> _lead = [
    BarKey('esc', key: TerminalKey.escape),
    BarKey('tab', key: TerminalKey.tab),
  ];

  /// The one key this runner's operator reaches for first: cycling permission mode is
  /// what a Claude pane asks about, and `^C` is what a shell asks about.
  /// Words rather than `⇧⇥` and `␛␛`: those drew as two specks on a phone (LOT2-104).
  static const _claudeLead = BarKey('S-tab', key: TerminalKey.tab, semantics: 'Shift Tab', shift: true);
  static const _shellLead = BarKey('^C', char: 'c', semantics: 'Control C');

  /// What a Claude TUI reads that the phone's keyboard cannot type: interrupt twice to
  /// rewind, todos, verbose, and a new line that does not send. Four, to fit the row;
  /// `@` `#` `!` were dropped from the old scrolling row because the phone types them.
  static const List<BarKey> _claude = [
    BarKey('esc²', key: TerminalKey.escape, semantics: 'Escape twice', twice: true),
    BarKey('^T', char: 't', semantics: 'Control T'),
    BarKey('^R', char: 'r', semantics: 'Control R'),
    // **Not `keyInput(enter, shift: true)`.** The keytab makes that `ESC O M`, and the
    // real `claude` CLI read it as Enter and sent a half-written prompt (measured in a
    // PTY, 2026-10-05). `ESC CR` — Option+Enter — broke the line and sent nothing; `^J`
    // did too but runs the line in a shell. It replaced `/`, which the phone types.
    BarKey('S-enter', bytes: '\x1b\r', semantics: 'Shift Enter, new line'),
  ];

  /// What a shell reads, once `^C` has already been given a place up front. `-` and `/`
  /// left with the scroll: the phone types them.
  static const List<BarKey> _shell = [
    BarKey('^D', char: 'd', semantics: 'Control D'),
    BarKey('^Z', char: 'z', semantics: 'Control Z'),
    BarKey('|', char: '|'),
    BarKey('~', char: '~'),
  ];

  /// Row 2 while ctrl is held: the controls a thumb actually sends.
  static const List<BarKey> _control = [
    BarKey('^C', char: 'c', semantics: 'Control C'),
    BarKey('^D', char: 'd', semantics: 'Control D'),
    BarKey('^R', char: 'r', semantics: 'Control R'),
    BarKey('^L', char: 'l', semantics: 'Control L'),
    BarKey('^Z', char: 'z', semantics: 'Control Z'),
  ];

  bool get _isClaudeFamily => RunnerFamily.of(widget.provider).isClaudeFamily;

  void _press(BarKey k) {
    Tactile.chose();
    final terminal = widget.terminal;
    final sticky = widget.sticky;
    // The glyph carries its own modifier where it names one — `^T` is Ctrl+T whether or
    // not the sticky Ctrl is lit, because a key labelled with a modifier that then
    // needed the modifier would be a riddle.
    final named = k.semantics?.startsWith('Control ') ?? false;
    final ctrl = sticky.ctrlHeld || named;
    final alt = sticky.altHeld;
    final shift = k.shift;

    if (k.bytes case final bytes?) {
      terminal.textInput(bytes);
    } else if (k.char case final char?) {
      // `charInput` only speaks modifiers: it encodes Ctrl-letter and Alt-letter and
      // **returns false without emitting anything** for a plain character (measured
      // against the package, `terminal.dart:265`). A `/` sent that way vanished. Plain
      // text is `textInput`'s job, and it is also the fallback for a combination the
      // keytab has no encoding for, such as Ctrl-`/`.
      final handled = (ctrl || alt) && terminal.charInput(char.codeUnitAt(0), ctrl: ctrl, alt: alt);
      if (!handled) terminal.textInput(char);
    } else if (k.key case final key?) {
      terminal.keyInput(key, ctrl: ctrl, alt: alt, shift: shift);
      if (k.twice) terminal.keyInput(key, ctrl: ctrl, alt: alt, shift: shift);
    }
    // A cap is a key typed, so what was held for one key lets go — `charInput` passes
    // neither the wrapped handler nor `textInput`, which spend it for the other paths.
    sticky.spend();
  }

  /// Reads the clipboard into the pane, as a paste rather than as keystrokes.
  ///
  /// `Terminal.paste` wraps it in bracketed-paste markers when the program asked for
  /// them, which is what stops a shell from running every line of a multi-line paste as
  /// it arrives — the difference between pasting a command and pasting a script.
  Future<void> _paste() async {
    Tactile.chose();
    final data = await Clipboard.getData(Clipboard.kTextPlain);
    final text = data?.text;
    if (text == null || text.isEmpty) return;
    widget.terminal.paste(text);
    widget.sticky.spend();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return ListenableBuilder(
      listenable: widget.sticky,
      builder: (context, _) {
        final sticky = widget.sticky;
        final held = sticky.ctrlHeld;
        return Container(
          decoration: BoxDecoration(
            color: t.termBg,
            border: Border(top: BorderSide(color: t.line)),
          ),
          padding: const EdgeInsets.fromLTRB(5, 4, 8, 4),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (sticky.lockHint)
                Padding(
                  padding: const EdgeInsets.fromLTRB(3, 2, 0, 4),
                  child: Text(
                    'ctrl locked · tap ctrl to release',
                    style: t.mono.copyWith(fontSize: 11, color: t.muted),
                  ),
                ),
              Row(
                children: [
                  Expanded(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        _row([
                          for (final k in _lead) _cap(t, k),
                          _modifier(t, 'ctrl', sticky.ctrl, () => sticky.tap(Modifier.ctrl)),
                          _modifier(t, 'alt', sticky.alt, () => sticky.tap(Modifier.alt)),
                          _cap(t, _isClaudeFamily ? _claudeLead : _shellLead),
                        ]),
                        const SizedBox(height: 2),
                        _row(held
                            ? [for (final k in _control) _cap(t, k, hi: true)]
                            : [
                                for (final k in _isClaudeFamily ? _claude : _shell) _cap(t, k),
                                _cap(t, const BarKey('paste', semantics: 'Paste'), onTap: _paste),
                              ]),
                      ],
                    ),
                  ),
                  const SizedBox(width: 6),
                  ArrowPad(onArrow: (key) => widget.terminal.keyInput(key)),
                ],
              ),
            ],
          ),
        );
      },
    );
  }

  /// Equal shares of the row: with nothing to scroll there is a width to divide, and a
  /// thumb finds `esc` by where it is, not by how wide its word is.
  Widget _row(List<Widget> caps) => Row(children: [for (final c in caps) Expanded(child: c)]);

  /// A 40px cap inside a 44px hit box; the 3px sides make the 6px gap between caps.
  Widget _hit({
    required String label,
    required VoidCallback onTap,
    required Color fill,
    required Widget child,
    bool? toggled,
  }) =>
      Semantics(
        button: true,
        toggled: toggled,
        label: label,
        excludeSemantics: true,
        child: InkWell(
          onTap: onTap,
          borderRadius: BorderRadius.circular(8),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 3, vertical: 2),
            child: Container(
              key: const ValueKey('cap'),
              constraints: const BoxConstraints(minHeight: KeyBar.capHeight),
              alignment: Alignment.center,
              decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(8)),
              child: child,
            ),
          ),
        ),
      );

  Widget _cap(AppTokens t, BarKey k, {VoidCallback? onTap, bool hi = false}) => _hit(
        label: k.semantics ?? k.label,
        onTap: onTap ?? () => _press(k),
        fill: hi ? t.keyHi : t.key,
        // Shrinks rather than wraps: `S-enter` is a little wider than a cap at 360dp.
        child: FittedBox(
          fit: BoxFit.scaleDown,
          child: Text(k.label, style: t.mono.copyWith(fontSize: 12, color: hi ? t.text : t.dim)),
        ),
      );

  /// Held for one key reads raised; locked reads pressed in — the app spends its two
  /// colours on *you are needed* and *it failed*, and a modifier is neither.
  Widget _modifier(AppTokens t, String label, StickyState state, VoidCallback onTap) {
    final locked = state == StickyState.locked;
    return _hit(
      label: label,
      toggled: state != StickyState.off,
      onTap: () {
        Tactile.chose();
        onTap();
      },
      fill: switch (state) {
        StickyState.off => t.key,
        StickyState.once => t.keyHi,
        StickyState.locked => t.text,
      },
      child: Text(
        label,
        style: t.mono.copyWith(
          fontSize: 12,
          color: locked ? t.bg : (state == StickyState.once ? t.text : t.dim),
        ),
      ),
    );
  }
}
