import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../shared/state_shapes.dart';
import '../../shared/age_label.dart';
import '../../shared/back_glyph.dart';
import '../../shared/tilde_path.dart';
import '../home_summary.dart';
import '../project_presentation.dart';

/// `‹  CNVS  vps` plus the one-sentence answer beneath it.
///
/// The title is where the host became permanently visible for free (ADR-3, second
/// revision): because the list below is one project, naming the host once up here
/// replaces a badge on every row — which is the objection that revision was resolving.
///
/// **The caret turned around on 2026-08-11.** It used to open the switcher sheet, because a
/// screen that chose its own project needed a way to choose again. The root is the project
/// index now, so the index *is* the switcher — and the affordance in this corner is the way
/// back to it. One less surface, and one less mechanism.
class ProjectHeader extends StatelessWidget {
  const ProjectHeader({
    required this.project,
    required this.summary,
    required this.onBack,
    this.onAskAgain,
    super.key,
  });

  /// The same value a switcher row is built from, so the title and the sheet that
  /// changes it can never disagree about what this project is called.
  final ProjectPresentation project;

  final HomeSummary summary;

  /// Back to the project index.
  final VoidCallback onBack;

  /// Menanyakan ulang ke setiap host. Hanya dipakai ketika [ProjectPresentation.isStale],
  /// jadi ia null di pemanggil yang tidak punya jalan untuk itu.
  final VoidCallback? onAskAgain;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Padding(
      padding: const EdgeInsets.only(left: 20, right: 20, top: 22),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _title(context, t),
          if (project.path.isNotEmpty || project.host.isNotEmpty) ...[
            const SizedBox(height: 6),
            _meta(t),
          ],
          if (!summary.isEmpty) ...[const SizedBox(height: 10), _summary(t)],
          if (project.isStale) ...[
            SizedBox(height: summary.isEmpty ? 9 : 6),
            _unreachable(context, t),
          ],
        ],
      ),
    );
  }

  /// The host stopped answering, so everything below this is a memory.
  ///
  /// **Home could not say this at all until 2026-08-09, and that was the most
  /// expensive silence on the screen.** `isStale` was computed in `FleetStore`, passed
  /// through `ProjectPresentation`, and rendered only by the switcher sheet — a surface
  /// the operator opens deliberately and rarely. So a sleeping laptop left Home
  /// pixel-identical to a healthy fleet: the rows kept their last states, the summary
  /// kept its last sentence, and nothing anywhere said the numbers had stopped moving.
  ///
  /// R-9 already guards the opposite failure — a fleet that empties itself reads as
  /// *all my work is gone*, which is why `markUnreachable` keeps the cells. This is the
  /// other half of that decision, and it was missing: **a fleet that freezes reads as
  /// up to date.** Keeping the rows is only honest if the screen also says they are old.
  ///
  /// **The age is measured, never estimated.** This shipped without one, because
  /// `isStale` was a bool and nothing recorded *when* — and a `4m` on the single line
  /// whose job is to say *do not trust what is below me* would have been the exact lie
  /// it exists to prevent. `FleetStore.lastHeardFrom` now stamps every `adopt`, so the
  /// number comes from the last time a host actually spoke.
  ///
  /// The wordless form remains as the fallback for a presentation built without a
  /// measured silence. **On Home that is currently unreachable**, and it is worth
  /// saying so rather than implying coverage: `FleetRepository._hydrateOne` calls
  /// `adoptProjects` and `adopt` on the same response, so any project this screen can
  /// display has been through `adopt` and therefore carries a stamp. The branch is
  /// kept because `silence` is a nullable field that other callers construct directly,
  /// and because the alternative to a sentence would be printing `0s` — which reads as
  /// *it just spoke*, the opposite of what the line means.
  ///
  /// Not amber: the switcher settled this before it was retired — a machine that went
  /// quiet is not asking the operator for anything, and amber has exactly one meaning
  /// (`MVP.md`).
  Widget _unreachable(BuildContext context, AppTokens t) {
    final age = ageLabel(project.silence?.inMilliseconds);
    final ask = onAskAgain;
    // The rows below stay, dimmed: an empty screen would hide what was there (DESIGN.md §8).
    return Padding(
      padding: const EdgeInsets.only(top: 6),
      child: StateCapsule(
        icon: Icons.cloud_off_outlined,
        words: age == null ? 'Not answering · showing what it last said' : 'Not answering · last heard $age ago',
        action: ask == null ? null : (label: 'Try again', onTap: ask),
      ),
    );
  }

  Widget _title(BuildContext context, AppTokens t) {
    final row = Row(
      crossAxisAlignment: CrossAxisAlignment.baseline,
      textBaseline: TextBaseline.alphabetic,
      mainAxisSize: MainAxisSize.min,
      children: [
        Flexible(
          child: Text(
            project.label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            // Serif, like every persona and runner name below it: the project is the
            // thing those agents belong to, and it used to be the one heading on Home
            // set in the UI face — read as a different app's title bar (2026-08-27).
            style: t.serif.copyWith(
              fontSize: 27,
              fontWeight: FontWeight.w600,
              letterSpacing: -0.5,
              color: t.text,
            ),
          ),
        ),
      ],
    );

    return Row(
      children: [
        // Chip, bukan glyph telanjang: ini satu-satunya jalan keluar dari layar ini, dan
        // `agent_header.dart` sudah belajar mahal bahwa jalan keluar yang tidak berukuran
        // kontrol adalah jalan keluar yang terlewat.
        BackGlyph(onTap: onBack, label: 'Back to projects'),
        const SizedBox(width: 10),
        Expanded(child: row),
      ],
    );
  }

  /// Two spans, one line. The amber half is the request; the muted half is context.
  /// Where, and on which machine — the two facts that keep two same-named projects
  /// apart (R-10, `issues/11`), in the mono the rest of the app uses for paths. The
  /// host is its own word so it still reads when the path is long, and is printed only
  /// when a second machine makes it mean something (`hostQualifier`).
  Widget _meta(AppTokens t) {
    final style = t.mono.copyWith(fontSize: 11.5, color: t.muted);
    return Row(
      children: [
        if (project.path.isNotEmpty)
          Flexible(
            child: Text(tildePath(project.path), maxLines: 1, overflow: TextOverflow.ellipsis, style: style),
          ),
        if (project.path.isNotEmpty && project.host.isNotEmpty)
          Text(' · ', style: style.copyWith(color: t.faint)),
        if (project.host.isNotEmpty) Text(project.host, style: style),
      ],
    );
  }

  Widget _summary(AppTokens t) => Text.rich(
    TextSpan(
      children: [
        if (summary.waiting.isNotEmpty)
          TextSpan(
            text: summary.waiting,
            style: TextStyle(color: t.waiting, fontWeight: FontWeight.w500),
          ),
        if (summary.waiting.isNotEmpty && summary.rest.isNotEmpty)
          const TextSpan(text: ' '),
        if (summary.rest.isNotEmpty) TextSpan(text: summary.rest),
      ],
    ),
    style: t.ui.copyWith(fontSize: 13, color: t.muted),
  );
}
