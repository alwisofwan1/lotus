import 'package:flutter/material.dart';

import '../page_mode.dart';

/// Chat and Terminal as siblings: one shown, the other kept, a 180ms crossfade between.
///
/// Replaces `TerminalSheet` (v4 tiket 03). The sheet left 34px of Chat showing and closed
/// only by dragging its grip; the switch in the header makes both of those unnecessary.
///
/// **An `IndexedStack` that can fade**, not a widget swap. The view left behind stays
/// mounted — Offstage once the fade ends — so Terminal's emulator, scroll and zoom, and
/// Chat's scroll position, are where the operator left them (tiket 02). No slide: the two
/// views are not stacked in space, so motion that says *from the right* would be a claim
/// about a layout that does not exist. Under reduce-motion the swap is instant.
class AgentViews extends StatefulWidget {
  const AgentViews({required this.shown, required this.chat, required this.terminal, super.key});

  final AgentSurface shown;
  final Widget chat;

  /// Built by the owner only once Terminal has been opened, so a page that never opens
  /// it never lays out an emulator.
  final Widget terminal;

  static const Duration fade = Duration(milliseconds: 180);

  @override
  State<AgentViews> createState() => _AgentViewsState();
}

class _AgentViewsState extends State<AgentViews> with SingleTickerProviderStateMixin {
  /// 0 is Chat, 1 is Terminal.
  late final AnimationController _toTerminal = AnimationController(
    vsync: this,
    duration: AgentViews.fade,
    value: widget.shown == AgentSurface.terminal ? 1 : 0,
  );

  late final Animation<double> _eased =
      CurvedAnimation(parent: _toTerminal, curve: Curves.easeOutQuart);

  @override
  void didUpdateWidget(AgentViews old) {
    super.didUpdateWidget(old);
    if (old.shown == widget.shown) return;
    final target = widget.shown == AgentSurface.terminal ? 1.0 : 0.0;
    if (MediaQuery.disableAnimationsOf(context)) {
      _toTerminal.value = target;
    } else {
      _toTerminal.animateTo(target);
    }
  }

  @override
  void dispose() {
    _toTerminal.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
        animation: _eased,
        builder: (context, _) {
          final v = _eased.value;
          final onTerminal = widget.shown == AgentSurface.terminal;
          return Stack(
            fit: StackFit.expand,
            children: [
              _layer(AgentSurface.chat, widget.chat, opacity: 1 - v, target: !onTerminal),
              _layer(AgentSurface.terminal, widget.terminal, opacity: v, target: onTerminal),
            ],
          );
        },
      );

  /// Keyed so the two layers keep their elements — and so their state — whichever one
  /// is on top. Only the view being shown takes touches or reaches the screen reader,
  /// even mid-fade.
  Widget _layer(AgentSurface which, Widget child, {required double opacity, required bool target}) =>
      Offstage(
        key: ValueKey(which),
        offstage: opacity <= 0.001,
        child: IgnorePointer(
          ignoring: !target,
          child: ExcludeSemantics(
            excluding: !target,
            child: Opacity(opacity: opacity.clamp(0.0, 1.0), child: child),
          ),
        ),
      );
}
