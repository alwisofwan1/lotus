import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';
import '../../../data/agent_outcome.dart';
import '../../../models/cell_result.dart';
import '../../shared/age_label.dart';
import '../../shared/tactile.dart';

/// What the turn left behind, as one quiet line at the end of it.
///
/// **This replaces a bordered card that sat in the transcript's flow.** The card was a
/// `ListView` child, so it pushed the agent's last sentence up the screen every time a
/// turn ended, and it drew even when it had nothing to report — three lines of
/// *"no file changes recorded / the machine does not know this agent's directory"*,
/// between the answer and the place the operator replies. Reported from a real device
/// on 2026-09-08.
///
/// Two rules come out of that:
///
/// 1. **It draws nothing when it knows nothing.** [has] is the gate, and the row is not
///    added to the layout at all in that case — an empty line is still a line.
/// 2. **The account itself moved.** The file list, the diffs, the closing words live in
///    a sheet a tap away ([showChangesSheet]); this line is the handle, not the
///    contents. Mono and [AppTokens.faint], because it is a footnote to the turn above
///    it rather than a thing to read.
class TurnTail extends StatelessWidget {
  const TurnTail({required this.outcome, required this.result, this.onOpen, super.key});

  /// The ring's account of the turn: how long it ran, what it said it edited.
  final AgentOutcome? outcome;

  /// Git's account of the disk, when the host serves `/result`.
  final CellResult? result;

  /// Opens the full account. Null when there is nothing more than this line.
  final VoidCallback? onOpen;

  /// Whether there is anything worth a line at all.
  ///
  /// Git having files is the strong case. The ring alone counts only when it has
  /// something concrete — a run time or an edit — because *"finished, changed nothing"*
  /// under every idle cell is the noise this whole row exists to remove.
  static bool has(AgentOutcome? outcome, CellResult? result) {
    if (result?.changes?.files.isNotEmpty ?? false) return true;
    if (outcome == null) return false;
    return outcome.ranFor != null || outcome.files.isNotEmpty;
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    if (!has(outcome, result)) return const SizedBox.shrink();

    final line = Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 2),
      child: Row(
        children: [
          Expanded(
            child: Text.rich(
              TextSpan(children: _pieces(t)),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: t.mono.copyWith(fontSize: 10.5, color: t.faint),
            ),
          ),
          if (onOpen != null)
            Padding(
              padding: const EdgeInsets.only(left: 8),
              child: Text('›', style: t.mono.copyWith(fontSize: 12, color: t.muted)),
            ),
        ],
      ),
    );

    if (onOpen == null) return line;
    return Semantics(
      button: true,
      label: 'What this turn changed. Tap for the file list',
      child: ExcludeSemantics(
        child: InkWell(
          onTap: () {
            Tactile.chose();
            onOpen!();
          },
          borderRadius: BorderRadius.circular(6),
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 32),
            child: line,
          ),
        ),
      ),
    );
  }

  /// The line, in the order the operator reads it: it finished, it took this long, it
  /// changed this much. Each piece appears only when it is known.
  List<InlineSpan> _pieces(AppTokens t) {
    final ran = outcome?.ranFor;
    final git = result?.changes;
    final files = git?.files.length ?? outcome?.files.length ?? 0;
    final added = git?.added ?? outcome?.added;
    final removed = git?.removed ?? outcome?.removed;
    final strong = TextStyle(color: t.dim);

    final spans = <InlineSpan>[const TextSpan(text: 'finished')];
    if (ran != null) {
      spans.add(TextSpan(text: ' ${ageLabel(ran.inMilliseconds)}', style: strong));
    }
    if (files > 0) {
      if (added != null && removed != null) {
        spans.add(const TextSpan(text: ' · '));
        spans.add(TextSpan(text: '+$added −$removed', style: strong));
      }
      spans.add(TextSpan(text: ' in $files file${files == 1 ? '' : 's'}'));
    }
    return spans;
  }
}
