import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';

/// Keychain entries that could not be parsed.
///
/// At the bottom and unstyled: it is empty on every phone that has not hit the bug it
/// reports. Shown at all because the alternative is a host that silently does not
/// exist, which reads exactly like never having paired it.
class UnreadableEntries extends StatelessWidget {
  const UnreadableEntries({required this.keys, super.key});

  final List<String> keys;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.only(top: 22),
      decoration: BoxDecoration(border: Border(top: BorderSide(color: t.line))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            keys.length == 1
                ? '1 stored entry could not be read'
                : '${keys.length} stored entries could not be read',
            style: t.ui.copyWith(fontSize: 12.5, color: t.error),
          ),
          const SizedBox(height: 8),
          for (final key in keys)
            Padding(
              padding: const EdgeInsets.only(bottom: 3),
              child: Text(key, style: t.mono.copyWith(fontSize: 11, color: t.muted)),
            ),
        ],
      ),
    );
  }
}
