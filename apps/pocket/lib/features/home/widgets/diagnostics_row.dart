import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';

/// The one row that is not a project.
///
/// Separated by a hairline and set in the quietest weight the screen has, because it is
/// the only row here that is never the reason the operator opened it. It sits outside
/// the scrolling list so a long fleet cannot push the only route to Diagnostics off
/// the bottom. The rule this follows is the mockup's: `hairline` divides two kinds of
/// row, it does not fence one of them into a box.
///
/// **It moved out of the switcher sheet on 2026-08-11, before that sheet lost its
/// reason to exist.** `PLAN.md` §4.2 put Diagnostics at the foot of the switcher rather
/// than behind a tab, and the sheet was the only surface that carried it — so retiring
/// the sheet first and relocating after would have shipped a version of the app with no
/// route at all to the screen that says whether a silent fleet is unpaired, unreachable,
/// or simply quiet. The foot of the project index is the same position, one level up.
class DiagnosticsRow extends StatelessWidget {
  const DiagnosticsRow({required this.onSelect, super.key});

  final VoidCallback onSelect;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Container(
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: t.line)),
      ),
      child: InkWell(
        onTap: onSelect,
        splashColor: t.raise,
        highlightColor: t.raise,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 16),
          child: Text(
            'Diagnostics',
            style: t.ui.copyWith(fontSize: 14.5, color: t.muted),
          ),
        ),
      ),
    );
  }
}
