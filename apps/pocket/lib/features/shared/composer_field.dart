import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';
import 'composer_keys.dart';

/// The words, across the full width of the composer's box.
///
/// **14.5, up from 13** — the size `mockups/lotus-pocket.pen` sets, and the one this
/// surface should always have had: it is the only place in the app the operator *writes*
/// rather than reads, and it was set smaller than the transcript it answers.
///
/// It carries no padding of its own. The box around it already insets by the drawing's
/// numbers, and a second inset here would stop the first line sitting where the drawing
/// puts it — which is the whole difference between a field and a field in a box.
class ComposerField extends StatelessWidget {
  const ComposerField({
    required this.controller,
    required this.keys,
    required this.hint,
    required this.enabled,
    this.focusNode,
    super.key,
  });

  final TextEditingController controller;

  /// What the return key does here, and how tall this may get.
  final ComposerKeys keys;

  final String hint;
  final bool enabled;
  final FocusNode? focusNode;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final style = t.ui.copyWith(fontSize: 14.5, height: 1.45, color: t.text);

    return TextField(
      controller: controller,
      focusNode: focusNode,
      enabled: enabled,
      style: style,
      cursorColor: t.text,
      minLines: 1,
      maxLines: keys.maxLines,
      keyboardType: keys.keyboardType,
      textInputAction: keys.action,
      decoration: InputDecoration(
        isDense: true,
        border: InputBorder.none,
        contentPadding: EdgeInsets.zero,
        hintText: hint,
        hintStyle: style.copyWith(color: t.muted),
      ),
    );
  }
}
