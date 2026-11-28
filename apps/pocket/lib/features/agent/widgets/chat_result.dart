import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../../data/agent_outcome.dart';
import '../../../models/cell_result.dart';
import '../../shared/tactile.dart';

/// `3 files +184 −12`, from git when it answered, else from the turn's own edits.
/// Null when nothing changed — a facts line with no facts is not drawn.
String? resultFacts(AgentOutcome? outcome, CellResult? result) {
  final git = result?.changes;
  final files = git?.files.length ?? outcome?.files.length ?? 0;
  if (files == 0) return null;
  final added = git?.added ?? outcome!.added;
  final removed = git?.removed ?? outcome!.removed;
  return '$files ${files == 1 ? 'file' : 'files'} +$added −$removed';
}

/// The end of a finished turn: one facts line, which opens the changes.
class ResultBlock extends StatelessWidget {
  const ResultBlock({required this.facts, this.onOpenChanges, super.key});

  final String? facts;
  final VoidCallback? onOpenChanges;

  @override
  Widget build(BuildContext context) {
    final line = facts;
    if (line == null) return const SizedBox(height: 16);
    final t = context.tokens;
    final open = onOpenChanges;
    final text = Text(open == null ? line : '$line ›',
        style: t.ui.copyWith(
            fontSize: 13, color: t.dim, fontFeatures: const [FontFeature.tabularFigures()]));
    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 8),
      child: open == null
          ? text
          : InkWell(
              onTap: () {
                Tactile.chose();
                open();
              },
              borderRadius: context.shape.radius(ShapeRole.tag),
              child: ConstrainedBox(
                constraints: const BoxConstraints(minHeight: kMinHitTarget),
                child: Align(alignment: Alignment.centerLeft, widthFactor: 1, child: text),
              ),
            ),
    );
  }
}
