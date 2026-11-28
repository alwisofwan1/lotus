import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../../models/cell.dart';
import '../../shared/field_glyphs.dart';
import '../../shared/glyphs.dart';
import '../../shared/tactile.dart';
import '../page_mode.dart';
import 'view_switch.dart';

/// The header while keys are live: `‹ · ● Atlas mac · Chat|Term · ⌨̸`, 36px (mockup B2).
///
/// Replaces [AgentTopBar] for as long as the phone's keyboard is up (v4 tiket 04). With
/// the keyboard taking half the glass, the full header's 54px is three terminal lines the
/// operator needs more than the drawer behind the title. What survives is what typing
/// needs: who this is, whether it is still working, the way to Chat, and the way to lower
/// the keyboard.
///
/// Its controls are 44 wide but only 36 tall, because the bar is. It sits right under the
/// status bar, so a tap that lands a little high still lands on it.
class MiniBar extends StatelessWidget {
  const MiniBar({
    required this.cell,
    required this.hostLabel,
    required this.onBack,
    required this.onShow,
    required this.onKeysOff,
    super.key,
  });

  final Cell cell;

  /// Already qualified, as in [AgentTopBar.hostLabel]: empty when it tells nothing.
  final String hostLabel;

  /// Leaves the page, exactly as the full header's `‹` does.
  final VoidCallback onBack;

  final ValueChanged<AgentSurface> onShow;

  /// Lowers the keyboard. Keys go off with it: a pane that keeps taking keys with no
  /// keyboard on screen is the one state this page must never be in.
  final VoidCallback onKeysOff;

  static const double height = 36;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final asks = cell.needsInput;
    final working = cell.turnKnown && !cell.isIdle && !asks;

    return Container(
      height: height,
      decoration: BoxDecoration(
        color: t.termBg,
        border: Border(bottom: BorderSide(color: t.line)),
      ),
      child: Row(
        children: [
          _button(context, 
            label: 'Back',
            onTap: onBack,
            child: Chevron(color: t.text, direction: ChevronDirection.left, size: 11, stroke: 1.8),
          ),
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: asks ? t.waiting : (working ? t.live : t.faint),
            ),
          ),
          const SizedBox(width: 6),
          Flexible(
            child: Text(
              cell.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: t.ui.copyWith(fontSize: 14, fontWeight: FontWeight.w500, color: t.text),
            ),
          ),
          if (hostLabel.isNotEmpty) ...[
            const SizedBox(width: 6),
            Text(hostLabel, style: t.mono.copyWith(fontSize: 11, color: t.muted)),
          ],
          const Spacer(),
          ViewSwitch(shown: AgentSurface.terminal, onShow: onShow, compact: true),
          _button(context, 
            label: 'Hide keyboard',
            onTap: () {
              Tactile.chose();
              onKeysOff();
            },
            child: KeyboardGlyph(color: t.dim, size: 17, crossed: true),
          ),
        ],
      ),
    );
  }

  Widget _button(BuildContext context, {required String label, required VoidCallback onTap, required Widget child}) =>
      Semantics(
        button: true,
        label: label,
        excludeSemantics: true,
        child: InkWell(
          onTap: onTap,
          borderRadius: context.shape.radius(ShapeRole.key),
          child: SizedBox(width: kMinHitTarget, height: height, child: Center(child: child)),
        ),
      );
}
