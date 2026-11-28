import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../../app/theme/theme.dart';
import '../../../data/measurement_log.dart';

/// Fase 0's only surface on this phone
/// (`plans/session-history-hardening/issues/01`): what `OutputBuffer`,
/// `LiveTranscript` and `TerminalFeed` have been counting since the app opened, one
/// JSON line per event in the format that ticket fixes.
///
/// **A copy action, not a live view.** `issues/01`'s own "Cara" section asks for
/// exactly that — a share/copy action reaching a JSONL an operator can hand to
/// whoever reads the Fase 0 numbers — and [MeasurementLog] is deliberately not a
/// `ChangeNotifier` (see its own doc), so the count below is a snapshot from when
/// this screen was opened or last refreshed, not something that ticks up live while
/// it is on screen.
///
/// Sits where `UnreadableEntries` does on this same screen: quiet, at the bottom,
/// asking nothing of an operator who has not come here for it.
class MeasurementLogBlock extends StatelessWidget {
  const MeasurementLogBlock({required this.measurements, super.key});

  final MeasurementLog measurements;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final count = measurements.length;
    final dropped = measurements.droppedLines;

    return Container(
      margin: const EdgeInsets.only(top: 8),
      padding: const EdgeInsets.only(top: 22),
      decoration: BoxDecoration(border: Border(top: BorderSide(color: t.line))),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Fase 0 measurement log',
            style: t.ui.copyWith(fontSize: 12.5, fontWeight: FontWeight.w500, color: t.muted),
          ),
          const SizedBox(height: 4),
          Text(
            _summary(count, dropped),
            style: t.mono.copyWith(fontSize: 11, color: t.muted),
          ),
          const SizedBox(height: 10),
          Semantics(
            button: true,
            child: InkWell(
              // Disabled rather than hidden: an empty log is still the honest answer
              // to "is this wired up", and hiding the row would look like it is not.
              onTap: count == 0 ? null : () => _copy(context),
              borderRadius: context.shape.radius(ShapeRole.block),
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
                decoration: BoxDecoration(
                  border: Border.all(color: t.lineStrong),
                  borderRadius: context.shape.radius(ShapeRole.block),
                ),
                child: Text(
                  'Copy log',
                  style: t.ui.copyWith(fontSize: 12.5, fontWeight: FontWeight.w500, color: t.dim),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }

  static String _summary(int count, int dropped) {
    if (count == 0) return 'Nothing recorded yet this session.';
    if (dropped == 0) return '$count line(s) recorded this session.';
    // Worth saying out loud: a summary built from a log that dropped its own oldest
    // lines is exactly the kind of silently-short measurement this ticket exists to
    // catch elsewhere, and this surface must not repeat it about itself.
    return '$count line(s) held, $dropped older line(s) dropped to stay bounded.';
  }

  Future<void> _copy(BuildContext context) async {
    await Clipboard.setData(ClipboardData(text: measurements.copyText()));
    if (!context.mounted) return;
    ScaffoldMessenger.maybeOf(context)
        ?.showSnackBar(SnackBar(content: Text('Copied ${measurements.length} line(s)')));
  }
}
