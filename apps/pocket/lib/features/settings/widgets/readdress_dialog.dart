import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';

/// Asks where a host lives now, and pops with what was typed.
///
/// **Prefilled with the current origin, scheme and all.** Trimming it to `host:port`
/// would read better and would be a real bug: `readAddress` defaults a scheme-less
/// address to `http`, so a host that had paired over `https` would be silently
/// downgraded by an operator who only meant to change four digits.
///
/// It decides nothing. `PairingRepository.readdress` owns the gate, the parse and the
/// order of the writes — this collects a string.
class ReaddressDialog extends StatefulWidget {
  const ReaddressDialog({required this.label, required this.origin, super.key});

  final String label;

  /// `http://192.168.1.11:8787` — what the diagnostics screen is already showing.
  final String origin;

  @override
  State<ReaddressDialog> createState() => _ReaddressDialogState();
}

class _ReaddressDialogState extends State<ReaddressDialog> {
  late final TextEditingController _address =
      TextEditingController(text: widget.origin);

  @override
  void dispose() {
    _address.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return AlertDialog(
      backgroundColor: Color.alphaBlend(t.raise, t.bg),
      title: Text(
        'Where is ${widget.label} now?',
        style: t.ui.copyWith(fontSize: 16, fontWeight: FontWeight.w500, color: t.text),
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            // Says what this does *not* do, because that is the part nobody guesses:
            // the pairing survives, so there is no code to fetch and no walk to the
            // machine — which is the entire reason this exists rather than an unpair.
            'This phone keeps its key and starts looking here instead. Lotus shows the '
            'address under Mobile access.',
            style: t.ui.copyWith(fontSize: 13, height: 1.5, color: t.muted),
          ),
          const SizedBox(height: 16),
          TextField(
            controller: _address,
            autofocus: true,
            keyboardType: TextInputType.url,
            autocorrect: false,
            enableSuggestions: false,
            style: t.mono.copyWith(fontSize: 14, color: t.text),
            cursorColor: t.text,
            decoration: InputDecoration(
              filled: true,
              fillColor: t.raise,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(14),
                borderSide: BorderSide.none,
              ),
              contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            ),
            onSubmitted: (value) => Navigator.of(context).pop(value),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text('Cancel', style: t.ui.copyWith(fontSize: 13.5, color: t.dim)),
        ),
        TextButton(
          onPressed: () => Navigator.of(context).pop(_address.text),
          child: Text(
            'Move it',
            style: t.ui.copyWith(fontSize: 13.5, fontWeight: FontWeight.w600, color: t.text),
          ),
        ),
      ],
    );
  }
}
