import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../../data/agent_outcome.dart';
import '../../../data/done_marks.dart';
import '../../../models/cell_result.dart';
import '../../../models/host_id.dart';
import '../../shared/tactile.dart';

/// What the agent is asked when the operator picks a tidy-up offer.
const String commitInstruction = 'Commit the uncommitted changes with a clear message. Do not push.';
const String prInstruction =
    'Commit the uncommitted changes on a new branch, push it, and open a pull request.';

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

String _clock(DateTime at) =>
    '${at.hour.toString().padLeft(2, '0')}:${at.minute.toString().padLeft(2, '0')}';

/// The end of a finished turn: one facts line, then View changes · Done — or the Done time.
class ResultBlock extends StatelessWidget {
  const ResultBlock({required this.facts, required this.done, this.onOpenChanges, this.onDone, super.key});

  final String? facts;
  final DoneMark? done;
  final VoidCallback? onOpenChanges;
  final VoidCallback? onDone;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final mark = done;
    return Padding(
      padding: const EdgeInsets.only(top: 4, bottom: 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (facts != null)
            Text(facts!,
                style: t.ui.copyWith(
                    fontSize: 13, color: t.dim, fontFeatures: const [FontFeature.tabularFigures()])),
          const SizedBox(height: 12),
          if (mark != null)
            _DoneDivider(label: 'Done · ${_clock(mark.at)}')
          else
            Row(
              children: [
                if (facts != null && onOpenChanges != null) ...[
                  Expanded(child: ChatAction(label: 'View changes', onTap: onOpenChanges!)),
                  const SizedBox(width: 8),
                ],
                if (onDone != null) Expanded(child: ChatAction(label: 'Done', ink: true, onTap: onDone!)),
              ],
            ),
        ],
      ),
    );
  }
}

class _DoneDivider extends StatelessWidget {
  const _DoneDivider({required this.label});

  final String label;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final rule = Expanded(child: Container(height: 1, color: t.line));
    return Row(
      children: [
        rule,
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Text(label, style: t.ui.copyWith(fontSize: 13, color: t.dim)),
        ),
        rule,
      ],
    );
  }
}

/// After Done with uncommitted files: an offer, sent as an ordinary instruction. Ignoring it is fine.
class TidyOffer extends StatelessWidget {
  const TidyOffer({required this.files, required this.onInstruct, super.key});

  final int files;
  final void Function(String text) onInstruct;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: t.raise,
        border: Border.all(color: t.line),
        borderRadius: context.shape.radius(ShapeRole.card),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('$files ${files == 1 ? 'file' : 'files'} not committed — tidy up?',
              style: t.ui.copyWith(fontSize: 15, fontWeight: FontWeight.w500, color: t.text)),
          const SizedBox(height: 12),
          Row(
            children: [
              Expanded(child: ChatAction(label: 'Commit only', onTap: () => onInstruct(commitInstruction))),
              const SizedBox(width: 8),
              Expanded(child: ChatAction(label: 'Create PR', ink: true, onTap: () => onInstruct(prInstruction))),
            ],
          ),
        ],
      ),
    );
  }
}

/// A 48dp action: ink is the one thing to do next, soft is the alternative.
class ChatAction extends StatelessWidget {
  const ChatAction({required this.label, required this.onTap, this.ink = false, super.key});

  final String label;
  final VoidCallback onTap;
  final bool ink;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final shape = context.shape.radius(ShapeRole.button);
    return Material(
      color: ink ? t.text : t.raise2,
      borderRadius: shape,
      child: InkWell(
        borderRadius: shape,
        onTap: () {
          Tactile.chose();
          onTap();
        },
        child: SizedBox(
          height: 48,
          child: Center(
            child: Text(label,
                style: t.ui.copyWith(fontSize: 15, fontWeight: FontWeight.w600, color: ink ? t.bg : t.text)),
          ),
        ),
      ),
    );
  }
}

/// Done takes effect at once and keeps the session; the snackbar is the way back.
void markDone(BuildContext context, DoneMarks marks, CellRef ref, String turnId) {
  Tactile.sent();
  marks.mark(ref, turnId);
  ScaffoldMessenger.maybeOf(context)
    ?..removeCurrentSnackBar()
    ..showSnackBar(SnackBar(
      content: const Text('Marked done'),
      duration: const Duration(seconds: 5),
      // An action would otherwise keep it up until dismissed; Undo is a 5 s window.
      persist: false,
      action: SnackBarAction(label: 'Undo', onPressed: () => marks.clear(ref)),
    ));
}
