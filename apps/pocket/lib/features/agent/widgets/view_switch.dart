import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../page_mode.dart';

/// `Chat | Terminal` — two labelled segments, always visible, one tap each.
///
/// Replaces the sheet's grip and the composer's `TERM` button (v4 tiket 03). The ADR-6
/// addendum of 2026-10-04 answers why a switch is allowed in the header again: Terminal
/// is now a place the operator works rather than peeks into, so it earns an entry that
/// does not depend on where they scrolled.
///
/// Labelled words, not icons: the two views are the page's whole vocabulary, and a glyph
/// pair would need learning that `Chat` and `Terminal` do not.
///
/// [compact] is the mini bar's 68 × 26 version (v4 tiket 04), shown while keys are live:
/// `Chat | Term`, because `Terminal` does not fit a 32px segment at a readable size. Its
/// hit box is the bar's 36px, not 44 — the bar itself is 36.
class ViewSwitch extends StatelessWidget {
  const ViewSwitch({required this.shown, required this.onShow, this.compact = false, super.key});

  final AgentSurface shown;
  final ValueChanged<AgentSurface> onShow;
  final bool compact;

  static const double segmentWidth = 80;
  static const double segmentHeight = 32;
  static const double _track = 2;

  double get _width => compact ? 32 : segmentWidth;
  double get _height => compact ? 22 : segmentHeight;
  double get _box => compact ? 36 : kMinHitTarget;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    // One detector over a 44px box, choosing the segment by which half was hit. The track
    // stays 36px — a taller one would set the header's height — and a detector per
    // segment would stop at the visible 32px, under the thumb-sized minimum.
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapUp: (tap) {
        final to = tap.localPosition.dx < _track + _width
            ? AgentSurface.chat
            : AgentSurface.terminal;
        if (to != shown) onShow(to);
      },
      child: Padding(
        padding: EdgeInsets.symmetric(
          vertical: (_box - _height - 2 * _track) / 2,
        ),
        child: Container(
          padding: const EdgeInsets.all(_track),
          decoration: BoxDecoration(
            color: t.raise2,
            borderRadius: BorderRadius.circular(compact ? 8 : 10),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              _segment(t, AgentSurface.chat, 'Chat'),
              _segment(t, AgentSurface.terminal, compact ? 'Term' : 'Terminal'),
            ],
          ),
        ),
      ),
    );
  }

  Widget _segment(AppTokens t, AgentSurface surface, String label) {
    final on = shown == surface;

    return Semantics(
      button: true,
      selected: on,
      label: surface == AgentSurface.chat ? 'Chat' : 'Terminal',
      excludeSemantics: true,
      onTap: on ? null : () => onShow(surface),
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 180),
        curve: Curves.easeOutQuart,
        width: _width,
        height: _height,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: on ? t.keyHi : t.keyHi.withValues(alpha: 0),
          borderRadius: BorderRadius.circular(compact ? 6 : 8),
          boxShadow: [
            BoxShadow(
              color: t.shadow.withValues(alpha: on ? 0.35 : 0),
              offset: const Offset(0, 1),
              blurRadius: 3,
            ),
          ],
        ),
        child: Text(
          label,
          style: t.ui.copyWith(
            fontSize: compact ? 11 : 13,
            fontWeight: FontWeight.w500,
            color: on ? t.text : t.muted,
          ),
        ),
      ),
    );
  }
}
