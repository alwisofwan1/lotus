import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../app/theme/theme.dart';

/// One labelled input on the pairing form.
///
/// Filled, no border — the composer's treatment (`.input` in the locked mockup), so
/// the one screen with no mockup of its own still reads as the same app rather than
/// as default Material dropped into a dark theme.
class PairingField extends StatelessWidget {
  const PairingField({
    required this.label,
    required this.controller,
    required this.hint,
    this.mono = false,
    this.keyboardType,
    this.inputFormatters,
    this.autofocus = false,
    this.focusNode,
    super.key,
  });

  final String label;
  final TextEditingController controller;
  final String hint;

  /// Whether the value is technical. An address and an 8-digit code are both read
  /// character by character against another screen, and a proportional font makes
  /// that harder than it needs to be.
  final bool mono;

  final TextInputType? keyboardType;
  final List<TextInputFormatter>? inputFormatters;
  final bool autofocus;
  final FocusNode? focusNode;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final base = mono ? t.mono : t.ui;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: t.ui.copyWith(fontSize: 11.5, color: t.muted),
        ),
        const SizedBox(height: 7),
        TextField(
          controller: controller,
          autofocus: autofocus,
          focusNode: focusNode,
          keyboardType: keyboardType,
          inputFormatters: inputFormatters,
          autocorrect: false,
          enableSuggestions: false,
          style: base.copyWith(fontSize: 14.5, color: t.text),
          cursorColor: t.text,
          decoration: InputDecoration(
            hintText: hint,
            hintStyle: base.copyWith(fontSize: 14.5, color: t.muted),
            filled: true,
            fillColor: t.raise,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(16),
              borderSide: BorderSide.none,
            ),
            contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 13),
          ),
        ),
      ],
    );
  }
}
