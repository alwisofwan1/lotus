import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';
import '../add_project.dart';

/// The ways a new project can arrive, asked once.
///
/// **One row per machine × way, on one page** — never a machine step followed by a way
/// step. With one paired host it is exactly the two rows the mockup draws
/// (`plans/pocket-vps-project-checkout/design/add-project.html`, screen 04); with two it
/// prints the machine on each row instead of asking twice. The qualifier is
/// [AddProjectChoice.host], already resolved by the same `hostLabel` four other surfaces
/// take, so nothing here decides a second time whether a machine is worth naming.
///
/// It is never opened for a single row — [ProjectsScreen] goes straight there. A sheet
/// that asks a question with one answer is not a question.
void showAddProjectSheet(
  BuildContext context, {
  required List<AddProjectChoice> choices,
  required void Function(AddProjectChoice choice) onChoose,
}) {
  showModalBottomSheet<void>(
    context: context,
    backgroundColor: Colors.transparent,
    builder: (sheetContext) => _AddProjectSheet(
      choices: choices,
      onChoose: (choice) {
        Navigator.of(sheetContext).pop();
        onChoose(choice);
      },
    ),
  );
}

class _AddProjectSheet extends StatelessWidget {
  const _AddProjectSheet({required this.choices, required this.onChoose});

  final List<AddProjectChoice> choices;
  final void Function(AddProjectChoice choice) onChoose;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Container(
      decoration: BoxDecoration(
        color: t.bg,
        border: Border(top: BorderSide(color: t.lineStrong)),
        borderRadius: const BorderRadius.vertical(top: Radius.circular(22)),
      ),
      child: SafeArea(
        top: false,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _grip(t),
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 4, 20, 13),
              child: Text(
                'ADD PROJECT',
                style: t.mono.copyWith(
                  fontSize: 10.5,
                  letterSpacing: 0.14 * 10.5,
                  color: t.muted,
                ),
              ),
            ),
            for (final choice in choices) _row(t, choice),
          ],
        ),
      ),
    );
  }

  Widget _grip(AppTokens t) => Center(
        child: Container(
          width: 34,
          height: 4,
          margin: const EdgeInsets.only(top: 10, bottom: 12),
          decoration: BoxDecoration(
            color: t.lineStrong,
            borderRadius: BorderRadius.circular(2),
          ),
        ),
      );

  Widget _row(AppTokens t, AddProjectChoice choice) => InkWell(
        onTap: () => onChoose(choice),
        splashColor: t.raise,
        highlightColor: t.raise,
        child: Container(
          decoration: BoxDecoration(
            border: Border(top: BorderSide(color: t.line)),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 15),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.baseline,
                textBaseline: TextBaseline.alphabetic,
                children: [
                  Flexible(
                    child: Text(
                      choice.label,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: t.serif.copyWith(
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                        letterSpacing: -0.2,
                        color: t.text,
                      ),
                    ),
                  ),
                  // The machine, only where it distinguishes one row from another.
                  if (choice.host.isNotEmpty) ...[
                    const SizedBox(width: 9),
                    Text(
                      choice.host,
                      style: t.mono.copyWith(fontSize: 11.5, color: t.muted),
                    ),
                  ],
                ],
              ),
              const SizedBox(height: 3),
              Text(
                choice.blurb,
                style: t.mono.copyWith(fontSize: 10.5, color: t.faint),
              ),
            ],
          ),
        ),
      );
}
