import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../shared/tactile.dart';

/// What the header's one text slot says. Never two at once, and `none` draws nothing.
enum HeaderAction {
  none(null),
  stop('Stop'),
  done('Done');

  const HeaderAction(this.label);
  final String? label;
}

/// A plain word on a 48dp target, like iOS `Done`: no border, no fill.
class HeaderActionButton extends StatelessWidget {
  const HeaderActionButton({required this.action, required this.onTap, super.key});

  final HeaderAction action;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final label = action.label;
    if (label == null) return const SizedBox.shrink();
    final t = context.tokens;
    return InkWell(
      onTap: () {
        Tactile.chose();
        onTap();
      },
      borderRadius: context.shape.radius(ShapeRole.pill),
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 48, minWidth: 48),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 10),
          child: Center(
            widthFactor: 1,
            child: Text(label, style: t.ui.copyWith(fontSize: 15, fontWeight: FontWeight.w500, color: t.text)),
          ),
        ),
      ),
    );
  }
}
