import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../app/theme/theme.dart';

/// `14:07`. Zero-padded so a column of these stays aligned in mono.
String clockLabel(DateTime at) {
  final local = at.toLocal();
  return '${local.hour.toString().padLeft(2, '0')}:${local.minute.toString().padLeft(2, '0')}';
}

const List<String> _months = [
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
];

/// `TODAY`, `YESTERDAY`, or `7 AUG`.
///
/// [now] is a parameter rather than a call to [DateTime.now] inside, so this stays a
/// pure function — a separator that renders differently depending on when the test ran
/// is a separator nobody can assert on.
String dayLabel(DateTime at, DateTime now) {
  final day = DateTime(at.toLocal().year, at.toLocal().month, at.toLocal().day);
  final today = DateTime(now.year, now.month, now.day);
  final difference = today.difference(day).inDays;

  if (difference == 0) return 'TODAY';
  if (difference == 1) return 'YESTERDAY';
  return '${day.day} ${_months[day.month - 1]}';
}

/// What a long press on a line offers: when it happened, and a way to take it with you.
///
/// **Two of the nine fixes share one gesture, and that is deliberate.** The timestamp is
/// carried on every line and was drawn nowhere; copy did not exist at all. Both are
/// things an operator wants *about a specific line*, and a phone has exactly one idiom
/// for that. Giving each its own affordance would put two controls on every row of a
/// screen whose whole design argument is that it stays quiet.
Future<void> showLineDetails(
  BuildContext context, {
  required String text,
  required DateTime at,
  DateTime? now,
}) {
  final t = context.tokens;
  final when = '${clockLabel(at)} · ${dayLabel(at, now ?? DateTime.now()).toLowerCase()}';

  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: Color.alphaBlend(t.raise, t.bg),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (sheet) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 12),
            child: Text(
              when,
              style: t.mono.copyWith(fontSize: 11.5, letterSpacing: 0.1 * 11.5, color: t.muted),
            ),
          ),
          Container(height: 1, color: t.line),
          ListTile(
            title: Text(
              'COPY',
              style: t.mono.copyWith(fontSize: 11.5, letterSpacing: 0.14 * 11.5, color: t.dim),
            ),
            onTap: () async {
              await Clipboard.setData(ClipboardData(text: text));
              if (sheet.mounted) Navigator.of(sheet).pop();
            },
          ),
        ],
      ),
    ),
  );
}
