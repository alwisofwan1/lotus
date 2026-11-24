import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';
import '../../../data/agent_outcome.dart';
import '../../../models/cell_result.dart';
import '../../shared/age_label.dart';
import '../../shared/glyphs.dart';
import '../../shared/tactile.dart';

/// What the agent left behind, at the foot of Chat once it has stopped.
///
/// Sits in the same slot as `PermissionCard` — the one place in Chat that answers *what
/// now* — and borrows its frame without its amber: a finished turn is not asking for
/// anything. No banner, no verb; the composer directly below is the reply, and `Close`
/// is already in the header.
///
/// **Two sources, one card, and the card says which.** With `/result` the file list is
/// git's — what actually differs from `HEAD`, untracked files included, tappable into a
/// diff — under the heading `CHANGED ON DISK`. Without it, the list is what the hook ring
/// recorded the agent editing, under `FINISHED`; that is the agent's account of itself,
/// and it is labelled as such rather than dressed as the disk. Codex has no ring, so the
/// first source is the only one that ever draws it here.
class FinishedCard extends StatelessWidget {
  const FinishedCard({
    this.outcome,
    this.result,
    this.onShowDiff,
    this.now,
    this.bare = false,
    super.key,
  }) : assert(outcome != null || result != null);

  /// Drops the frame, for a container that already is one.
  ///
  /// True inside [showChangesSheet], which is where this now lives: a border inside a
  /// sheet draws a second edge a centimetre from the sheet's own.
  final bool bare;

  /// The ring's account: closing words, edits reported, how long it ran.
  final AgentOutcome? outcome;

  /// Git's account, when the host advertises `result`.
  final CellResult? result;

  /// Opens one file's diff. Only offered when the list is git's — a diff of a path the
  /// agent merely *mentioned* may not exist.
  final void Function(String path)? onShowDiff;

  /// Injected so a test can pin *"finished 2m ago"*.
  final DateTime? now;

  CellChanges? get _git => result?.changes;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final git = _git;

    return Container(
      margin: EdgeInsets.only(top: bare ? 0 : 4),
      decoration: bare
          ? null
          : BoxDecoration(
              borderRadius: BorderRadius.circular(15),
              border: Border.all(color: t.lineStrong),
            ),
      padding: bare
          ? const EdgeInsets.only(bottom: 4)
          : const EdgeInsets.fromLTRB(14, 12, 14, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _head(t, git),
          const SizedBox(height: 8),
          if (git != null)
            ..._gitRows(t, git)
          else if (outcome!.changedFiles)
            for (final file in outcome!.files) _row(t, file.path, file.added, file.removed)
          else
            Text(
              // "Recorded", because absence here is a fact about the hook ring, not a
              // promise about the disk — this branch is the ring's account.
              'no file changes recorded',
              style: t.mono.copyWith(fontSize: 12, color: t.muted),
            ),
          if (git == null && result?.reason != null) ...[
            const SizedBox(height: 8),
            Text(_reasonLine(result!.reason!), style: t.mono.copyWith(fontSize: 11.5, height: 1.5, color: t.muted)),
          ],
          if (outcome?.closingTruncated ?? false) ...[
            const SizedBox(height: 10),
            Text(
              'closing message cut short by the host — raw terminal has the rest',
              style: t.mono.copyWith(fontSize: 11.5, height: 1.5, color: t.muted),
            ),
          ],
        ],
      ),
    );
  }

  List<Widget> _gitRows(AppTokens t, CellChanges git) => [
        if (git.files.isEmpty)
          Text('working tree clean against HEAD', style: t.mono.copyWith(fontSize: 12, color: t.muted))
        else
          for (final f in git.files) _row(t, f.path, f.added, f.removed, status: f.status, onTap: onShowDiff),
      ];

  Widget _head(AppTokens t, CellChanges? git) {
    final o = outcome;
    final age = o == null ? null : ageLabel((now ?? DateTime.now()).difference(o.finishedAt).inMilliseconds);
    final ran = o?.ranFor;
    final when = [
      if (age != null) 'finished $age ago',
      if (ran != null && ran.inSeconds >= 1) '${_short(ran)} run',
      if (git != null) 'vs HEAD',
    ].join(' · ');
    final added = git?.added ?? o?.added ?? 0;
    final removed = git?.removed ?? o?.removed ?? 0;
    final count = git?.files.length ?? o?.files.length ?? 0;

    return Row(
      crossAxisAlignment: CrossAxisAlignment.baseline,
      textBaseline: TextBaseline.alphabetic,
      children: [
        Text(
          git != null ? 'CHANGED ON DISK' : 'FINISHED',
          style: t.mono.copyWith(fontSize: 11, letterSpacing: 0.16 * 11, fontWeight: FontWeight.w600, color: t.dim),
        ),
        if (when.isNotEmpty) ...[
          const SizedBox(width: 10),
          Expanded(
            child: Text(when, maxLines: 1, overflow: TextOverflow.ellipsis,
                style: t.mono.copyWith(fontSize: 11, color: t.muted)),
          ),
        ] else
          const Spacer(),
        if (count > 0) ...[
          const SizedBox(width: 8),
          _stat(t, added, removed, suffix: ' · $count ${count == 1 ? 'file' : 'files'}'),
        ],
      ],
    );
  }

  /// One path with its stat — the same line `StepLine` draws for an `edit` step, so a
  /// file reads the same in the steps above and in the sum below. Tappable only when
  /// there is a diff to open; a chevron says so.
  Widget _row(AppTokens t, String path, int? added, int? removed,
      {String? status, void Function(String)? onTap}) {
    final line = Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.baseline,
        textBaseline: TextBaseline.alphabetic,
        children: [
          Expanded(
            child: Text(path, maxLines: 1, overflow: TextOverflow.ellipsis,
                style: t.mono.copyWith(fontSize: 12, color: status == 'deleted' ? t.muted : t.dim)),
          ),
          const SizedBox(width: 12),
          if (added == null && removed == null)
            Text(status == 'untracked' ? 'new' : 'binary', style: t.mono.copyWith(fontSize: 12, color: t.muted))
          else
            _stat(t, added ?? 0, removed ?? 0),
          if (onTap != null) ...[
            const SizedBox(width: 8),
            Chevron(color: t.faint, direction: ChevronDirection.right, size: 10),
          ],
        ],
      ),
    );
    if (onTap == null) return line;
    return Semantics(
      button: true,
      label: 'Show diff of $path',
      child: InkWell(
        onTap: () {
          Tactile.chose();
          onTap(path);
        },
        // The label above already names the path; letting the row's own text merge into it
        // would make a screen reader announce the path twice and the stat as a command.
        child: ExcludeSemantics(
          child: ConstrainedBox(constraints: const BoxConstraints(minHeight: kMinHitTarget), child: Center(child: line)),
        ),
      ),
    );
  }

  /// `+148 −12`, additions a shade brighter than removals — `StepLine._diff`'s rule.
  Widget _stat(AppTokens t, int added, int removed, {String suffix = ''}) => Text.rich(
        TextSpan(children: [
          TextSpan(text: '+$added', style: TextStyle(color: t.dim)),
          TextSpan(text: ' −$removed$suffix'),
        ]),
        style: t.mono.copyWith(fontSize: 12, color: t.muted),
      );

  static String _reasonLine(String reason) => switch (reason) {
        'not_a_repo' => 'the directory is not a git repository, so the disk cannot be compared',
        'no_cwd' => 'the machine does not know this agent\'s directory',
        _ => 'git could not be asked on the machine',
      };

  static String _short(Duration d) {
    if (d.inHours >= 1) return '${d.inHours}h ${d.inMinutes.remainder(60)}m';
    if (d.inMinutes >= 1) return '${d.inMinutes} min';
    return '${d.inSeconds}s';
  }
}
