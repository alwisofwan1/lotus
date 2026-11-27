import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';

/// The other row that is not a project: bringing a new one onto a machine.
///
/// **It joins `DiagnosticsRow` in the foot band rather than sitting beside the search
/// dock**, and the distinction matters because `project_search_field.dart` already
/// refused a `+` there, with its reason written down: starting an agent needs a project,
/// so a `+` on the index would have to ask which one and saves no tap at all.
///
/// That argument is still right and it does not reach this row — what is made here is the
/// *project*, and the index is the only screen that can make one precisely because it is
/// the only screen that has not picked one yet. The position still respects the refusal:
/// outside the scrolling list, in the thumb's reach, in the band that already exists for
/// rows that are not projects.
///
/// One step brighter than Diagnostics (`dim` against `muted`) because it is the row an
/// operator comes here on purpose for, and the other never is. **Never colour** — amber on
/// this screen means an agent needs you, and a way in asks for nothing.
class AddProjectRow extends StatelessWidget {
  const AddProjectRow({required this.onSelect, super.key});

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
            'Add project',
            style: t.ui.copyWith(fontSize: 14.5, color: t.dim),
          ),
        ),
      ),
    );
  }
}
