import 'dart:async';

import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../shared/field_glyphs.dart';
import '../../shared/glyphs.dart';
import '../../shared/tactile.dart';

/// Landscape Terminal's controls (v4 tiket 10, mockup C1): `Chat · ⌨ · ⌕ · Sessions · ⤡`,
/// floating at the top right over a terminal drawn edge to edge.
///
/// They fade after [idle] without a touch and come back on any touch of the terminal.
/// The touch is **heard, never taken**: a [Listener] sees the pointer go down and passes
/// it on, so the tap that wakes the controls still scrolls, selects or focuses what is
/// under it. Faded, they ignore pointers, so a tap where a button was lands on the text.
///
/// ⌨ stays even with keys live — decided 2026-10-05, the mockup over a read-only variant:
/// with the keyboard up about four rows remain, enough to answer a prompt without
/// turning the phone back. Crossed, it is the way to lower the keyboard.
/// What the page does when the controls leave immersion — to Chat, or back to the header.
/// A pair because they arrive together: the terminal is immersed when, and only when,
/// the page can take it out again.
class ImmersiveExits {
  const ImmersiveExits({required this.onChat, required this.onExit});

  final VoidCallback onChat;
  final VoidCallback onExit;
}

class ImmersiveControls extends StatefulWidget {
  const ImmersiveControls({
    required this.child,
    required this.live,
    required this.onChat,
    required this.onFind,
    required this.onExit,
    this.onKeys,
    this.onSessions,
    this.idle = const Duration(seconds: 3),
    super.key,
  });

  /// The terminal, under the controls.
  final Widget child;

  /// Whether keys reach the pane, so ⌨ is drawn crossed.
  final bool live;

  final VoidCallback onChat;
  final VoidCallback onFind;

  /// Leaves immersion; the phone stays turned, and the header comes back.
  final VoidCallback onExit;

  /// Null on a host with nowhere to send keys, which draws no ⌨.
  final VoidCallback? onKeys;

  /// Null when nothing handed the page a Sessions sheet.
  final VoidCallback? onSessions;

  final Duration idle;

  static const double button = 44;

  @override
  State<ImmersiveControls> createState() => _ImmersiveControlsState();
}

class _ImmersiveControlsState extends State<ImmersiveControls> {
  bool _shown = true;
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _wake();
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  void _wake() {
    _timer?.cancel();
    _timer = Timer(widget.idle, () {
      if (mounted) setState(() => _shown = false);
    });
    if (!_shown) setState(() => _shown = true);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final on = t.text;

    return Listener(
      behavior: HitTestBehavior.translucent,
      onPointerDown: (_) => _wake(),
      child: Stack(
        children: [
          Positioned.fill(child: widget.child),
          Positioned(
            top: 10,
            right: 10,
            child: IgnorePointer(
              ignoring: !_shown,
              child: AnimatedOpacity(
                opacity: _shown ? 1 : 0,
                duration: const Duration(milliseconds: 220),
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: t.raise2.withValues(alpha: 0.92),
                    borderRadius: BorderRadius.circular(14),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.all(4),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        _button(t, 'Chat', widget.onChat,
                            Text('Chat', style: t.ui.copyWith(fontSize: 13, color: on))),
                        if (widget.onKeys case final onKeys?)
                          _button(t, widget.live ? 'Lower keyboard' : 'Type to session', onKeys,
                              KeyboardGlyph(color: on, size: 17, crossed: widget.live),
                              on: widget.live),
                        _button(t, 'Find in output', widget.onFind, SearchGlyph(color: on, size: 17)),
                        if (widget.onSessions case final onSessions?)
                          _button(t, 'Sessions', onSessions, SessionsGlyph(color: on, size: 17)),
                        _button(t, 'Leave full screen', widget.onExit,
                            ExpandGlyph(color: on, direction: ExpandDirection.into, size: 16)),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Widget _button(AppTokens t, String label, VoidCallback onTap, Widget child, {bool on = false}) =>
      Semantics(
        button: true,
        toggled: on ? true : null,
        label: label,
        excludeSemantics: true,
        child: Material(
          color: on ? t.keyHi : Colors.transparent,
          borderRadius: BorderRadius.circular(10),
          child: InkWell(
            borderRadius: BorderRadius.circular(10),
            onTap: () {
              Tactile.chose();
              onTap();
            },
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                minWidth: ImmersiveControls.button,
                minHeight: ImmersiveControls.button,
              ),
              child: Padding(
                padding: const EdgeInsets.symmetric(horizontal: 8),
                child: Center(widthFactor: 1, child: child),
              ),
            ),
          ),
        ),
      );
}
