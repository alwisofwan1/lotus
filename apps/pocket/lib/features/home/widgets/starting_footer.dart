import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../shared/glyphs.dart';
import '../../shared/runner_mark.dart';
import '../../shared/tactile.dart';
import '../../shared/tilde_path.dart';
import '../spawn_choice.dart';

/// Under the composer while an agent is being started: what will be born, a way out,
/// and where it will run.
///
/// This replaced the chip row (`+ New agent` beside a runner chip) on 2026-08-27. That
/// row said the same thing as the list row that opened the mode and as the field's
/// placeholder — three times — and took a full row above the field to do it. One line
/// below the field says it once, in the runner's own colour, and is the way back into
/// the sheet; the path stays stated beneath it, never offered (R-10).
class StartingFooter extends StatelessWidget {
  const StartingFooter({
    required this.choice,
    required this.projectPath,
    required this.canCancel,
    required this.onChoose,
    required this.onCancel,
    super.key,
  });

  final SpawnChoice choice;
  final String projectPath;

  /// False on a project with no agents, where starting one is the only thing the field
  /// can mean and a `Cancel` would lead nowhere.
  final bool canCancel;
  final VoidCallback onChoose;
  final VoidCallback onCancel;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final runner = choice.runner;

    return Padding(
      padding: const EdgeInsets.only(left: 20, right: 12, bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Semantics(
                button: true,
                label: 'Choose a runner',
                child: InkWell(
                  onTap: () {
                    Tactile.chose();
                    onChoose();
                  },
                  borderRadius: context.shape.radius(ShapeRole.key),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: kMinHitTarget),
                    child: ExcludeSemantics(
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          RunnerMarkGlyph(
                            agentType: runner.isCustom ? runner.label : runner.id,
                            color: brandColorFor(runner.id, Theme.of(context).brightness) ?? t.dim,
                            size: 14,
                          ),
                          const SizedBox(width: 8),
                          Text(choice.summary, style: t.mono.copyWith(fontSize: 12, color: t.dim)),
                          const SizedBox(width: 6),
                          Chevron(color: t.faint, size: 10),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
              const Spacer(),
              if (canCancel)
                InkWell(
                  onTap: onCancel,
                  borderRadius: context.shape.radius(ShapeRole.pill),
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(minHeight: kMinHitTarget),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 10),
                      child: Center(
                        widthFactor: 1,
                        child: Text('Cancel', style: t.ui.copyWith(fontSize: 13, color: t.dim)),
                      ),
                    ),
                  ),
                ),
            ],
          ),
          if (projectPath.isNotEmpty)
            Text(
              // Stated, never offered. Choosing a path on a phone is the fastest way to
              // send an agent into the wrong repository (R-10).
              'Runs in ${tildePath(projectPath)}',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: t.mono.copyWith(fontSize: 11, color: t.faint),
            ),
        ],
      ),
    );
  }
}
