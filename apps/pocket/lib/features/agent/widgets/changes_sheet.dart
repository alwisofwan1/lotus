import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../../data/agent_outcome.dart';
import '../../../models/cell_result.dart';
import 'finished_card.dart';

/// The full account of what a turn left behind — as a sheet, not as a row in the chat.
///
/// The contents are unchanged: [FinishedCard] still decides what the two sources say
/// and which of them it is quoting. What changed on 2026-09-08 is **where it lives**.
/// In the transcript it competed with the agent's last sentence and with the composer,
/// and it appeared after every turn whether or not it had anything to report. Here it
/// appears when asked, takes only the height it needs, and the file list gets the width
/// a path deserves.
///
/// Reached from [TurnTail], the one line the transcript keeps.
Future<void> showChangesSheet(
  BuildContext context, {
  AgentOutcome? outcome,
  CellResult? result,
  void Function(String path)? onShowDiff,
}) {
  final t = context.tokens;
  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    // The list can be long — a turn that touched twenty files is exactly when this is
    // opened — and a sheet that cannot scroll would hide the tail of it.
    isScrollControlled: true,
    builder: (context) => SafeArea(
      top: false,
      child: Container(
        decoration: BoxDecoration(
          // A shade above the app floor, which is what every other raised surface in
          // this app does; the sheet is the container, so the card inside drops its own
          // border rather than drawing a second edge (`bare`).
          color: Color.alphaBlend(t.raise, t.bg),
          border: Border(top: BorderSide(color: t.lineStrong)),
          borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
        ),
        padding: const EdgeInsets.fromLTRB(16, 10, 16, 18),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 34,
              height: 4,
              margin: const EdgeInsets.only(bottom: 12),
              decoration: BoxDecoration(
                color: t.lineStrong,
                borderRadius: BorderRadius.circular(2),
              ),
            ),
            Flexible(
              child: SingleChildScrollView(
                child: FinishedCard(
                  outcome: outcome,
                  result: result,
                  onShowDiff: onShowDiff,
                  bare: true,
                ),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
