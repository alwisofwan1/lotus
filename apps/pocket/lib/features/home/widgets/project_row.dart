import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';
import '../../shared/glyphs.dart';
import '../../shared/tilde_path.dart';
import '../project_presentation.dart';

/// One project on the index: a letter, its name, and what is happening inside it.
///
/// **The letter is not decoration.** It gives the list a left edge and a rhythm the switcher
/// sheet never needed, because that sheet was four rows read once; this is the screen the
/// operator opens on. On a project that has something waiting, the same square is where amber
/// goes, so the mark answers *which project* and *does it want you* in one slot.
///
/// Counts come from [ProjectPresentation], the same value the title and the switcher row are
/// built from, so three surfaces cannot end up describing one project three ways.
class ProjectRow extends StatelessWidget {
  const ProjectRow({required this.project, required this.onOpen, super.key});

  final ProjectPresentation project;
  final VoidCallback onOpen;

  bool get _waiting => project.waiting.isNotEmpty;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return InkWell(
      onTap: onOpen,
      splashColor: t.raise,
      highlightColor: t.raise,
      child: Container(
        decoration: BoxDecoration(
          border: Border(bottom: BorderSide(color: t.line)),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 13),
        child: Row(
          children: [
            _letter(t),
            const SizedBox(width: 14),
            Expanded(child: _name(t)),
            const SizedBox(width: 12),
            _counts(t),
            const SizedBox(width: 9),
            Chevron(
              color: t.faint,
              direction: ChevronDirection.right,
              size: 12,
            ),
          ],
        ),
      ),
    );
  }

  Widget _letter(AppTokens t) => Container(
    width: 40,
    height: 40,
    alignment: Alignment.center,
    decoration: BoxDecoration(
      color: _waiting ? t.waiting.withValues(alpha: 0.12) : t.raise,
      borderRadius: BorderRadius.circular(13),
    ),
    child: Text(
      // The project's own first letter, upper-cased. Empty names cannot reach here —
      // `presentProject` falls back to the workspace id — but a defensive `?` here would
      // be a claim that they can.
      project.label.characters.first.toUpperCase(),
      style: t.serif.copyWith(
        fontSize: 16,
        fontWeight: FontWeight.w600,
        color: _waiting
            ? t.waiting
            : project.isDormant
            ? t.faint
            : t.muted,
      ),
    ),
  );

  /// The name, and — only where the list decided it is needed — the path under it.
  ///
  /// A second line rather than a suffix: two `pocket`s on one laptop differ by a directory,
  /// and a directory read at the end of a name is read as part of the name. The list decides
  /// which rows get one, never the row itself ([ProjectPresentation.disambiguate]).
  Widget _name(AppTokens t) {
    final name = _nameLine(t);
    if (!project.needsPath) return name;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        name,
        const SizedBox(height: 3),
        Text(
          tildePath(project.path),
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: t.mono.copyWith(fontSize: 11, color: t.faint),
        ),
      ],
    );
  }

  Widget _nameLine(AppTokens t) => Row(
    crossAxisAlignment: CrossAxisAlignment.baseline,
    textBaseline: TextBaseline.alphabetic,
    mainAxisSize: MainAxisSize.min,
    children: [
      Flexible(
        child: Text(
          project.label,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: t.serif.copyWith(
            fontSize: 19,
            // A project running nothing recedes one step, exactly as it does in the
            // switcher. Being dormant is a difference in weight, never an added ornament.
            fontWeight: project.isDormant ? FontWeight.w500 : FontWeight.w600,
            letterSpacing: -0.3,
            color: project.isDormant ? t.muted : t.text,
          ),
        ),
      ),
      // The machine, only where it distinguishes something — the `hostQualifier` rule
      // every other surface follows (`issues/11`).
      if (project.host.isNotEmpty) ...[
        const SizedBox(width: 9),
        Text(
          project.host,
          style: t.mono.copyWith(fontSize: 11.5, color: t.muted),
        ),
      ],
    ],
  );

  /// `1 · 3`, `2`, or nothing at all.
  ///
  /// The amber half is the request; the muted half is scale. Only the first is coloured, and a
  /// stale project's suffix is not amber either: a machine that went quiet is not asking the
  /// operator for anything (`MVP.md`).
  Widget _counts(AppTokens t) => Text.rich(
    TextSpan(
      children: [
        if (_waiting)
          TextSpan(
            text: project.waiting.split(' ').first,
            style: TextStyle(color: t.waiting),
          ),
        if (_waiting && project.activity.isNotEmpty)
          const TextSpan(text: ' · '),
        if (project.activity.isNotEmpty) TextSpan(text: project.activity),
        if (project.isStale) const TextSpan(text: ' · unreachable'),
      ],
    ),
    style: t.mono.copyWith(fontSize: 11.5, color: t.muted),
  );
}
