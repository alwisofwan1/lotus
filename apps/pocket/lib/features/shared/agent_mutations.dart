import 'dart:async';

import 'package:flutter/material.dart';

import '../../data/agent_repository.dart';
import '../../data/mutation_outcome.dart';
import '../../models/cell.dart';
import '../../models/permission.dart';
import '../../models/host_id.dart';
import 'cell_actions.dart';
import 'mutation_notice.dart';
import 'tactile.dart';

/// The three things a screen can do to an agent, and the sentence each leaves behind.
///
/// Pulled out of `HomeScreen` when the row drawer arrived and the screen crossed the
/// 300-line limit ADR-13 sets. The seam is the one the limit was pointing at rather than
/// a cut made for the count: the screen owns **which project is on screen and whether a
/// gesture is in flight**, and this owns **how a mutation is spelled** — the reason
/// string the OS shows inside the biometric prompt, the notice, the haptic.
///
/// Those three have to agree with each other and they have to be the same on every path.
/// The reason string in particular is read by the operator inside a system prompt where
/// nothing else identifies what they are approving, so `Stop Atlas` and `Close Atlas`
/// being written once, here, is what keeps a second call site from shipping `Dispatch`.
///
/// Holds `AgentRepository` and nothing else. It is not a widget and decides no layout;
/// what it does decide is copy, which is why it lives in `features/` rather than beside
/// the repository (ADR-13 no. 1: `data/` refuses to have an opinion about wording).
class AgentMutations {
  const AgentMutations(this.agents);

  final AgentRepository agents;

  /// These same mutations as a drawer's handler set, already gated.
  ///
  /// Offered here rather than assembled at each call site so that "what the drawer
  /// does" and "what a mutation costs" cannot drift apart: a screen that built its own
  /// set could quietly reach past [stop] and skip the notice, or word the reason string
  /// differently inside the OS prompt.
  ///
  /// [onDispatchHere] is the one action this object does not own, because aiming the
  /// composer changes nothing outside the screen. Null where the composer is already
  /// aimed at this agent.
  CellActionHandlers handlers(
    BuildContext context, {
    void Function(Cell cell)? onDispatchHere,
  }) =>
      CellActionHandlers(
        canClose: (cell) => agents.canCloseOn(cell.host),
        onStop: (cell) => unawaited(stop(context, cell)),
        onClose: (cell) => unawaited(close(context, cell)),
        onDispatchHere: onDispatchHere,
      );

  /// Starts an agent, and says what the machine answered.
  ///
  /// The reason string names the runner and the posture, because that pair is what the
  /// operator is approving inside the OS prompt and it is the one property of the cell
  /// they will not be able to change afterwards (ADR-8).
  ///
  /// Answers whether it took, so the composer can hand a brief back when it did not.
  Future<bool> start(
    BuildContext context, {
    required HostId host,
    required String provider,
    required String label,
    String? runnerId,
    String? workspaceId,
    String? initialPrompt,
    String? permissionMode,
    String? permissionLabel,
    String? model,
    String? effort,
    String? profileId,
    bool? tui,
  }) async {
    // The operator's own word for the stop, not its id — this sentence is read inside the OS
    // prompt, and `acceptEdits` is not a word anyone chose. Printed only when the choice was
    // moved off where the runner rests: a resting posture is not news, and a prompt that
    // recites every default trains the eye to skip the one line that ever varies.
    final posture = permissionLabel == null ? '' : ' set to $permissionLabel';
    final outcome = await agents.spawn(
      host: host,
      provider: provider,
      runnerId: runnerId,
      workspaceId: workspaceId,
      initialPrompt: initialPrompt,
      permissionMode: permissionMode,
      model: model,
      effort: effort,
      profileId: profileId,
      tui: tui,
      // The operator's own word for the runner, not its id: `acme`, not
      // `custom-acme`. This sentence is read inside the OS prompt, where nothing
      // else says what is about to be launched. The model rides along when one was
      // chosen, because it is the other fact about this cell that cannot change later.
      reason: 'Start a $label agent${model == null ? '' : ' on $model'}$posture${tui == false ? ' with no terminal' : ''}',
    );
    if (outcome.succeeded) Tactile.sent();
    if (!context.mounted) return outcome.succeeded;
    _say(
      context,
      outcome,
      // No cell to name yet, so the runner stands in — every failure sentence that
      // takes a name is about reaching a machine, not about an agent that exists.
      Cell(
        host: host,
        paneId: '',
        workspaceId: workspaceId ?? '',
        agentType: label,
        title: label,
        status: 'starting',
        isAlive: false,
      ),
      whenSent: 'Starting a $label agent. It appears here when the machine has it.',
    );
    return outcome.succeeded;
  }

  /// Sends the composer's words to [target].
  ///
  /// **Returns whether the words are now accounted for, which on Home means landed.**
  /// The agent page can answer yes even for a refusal, because a refused line stays in
  /// its transcript with a retry on it. Home has no transcript, so a failure leaves
  /// nothing on screen at all — and the composer gives the text back rather than
  /// deleting it.
  Future<bool> dispatch(BuildContext context, Cell target, String text) async {
    final outcome = await agents.dispatch(
      target.ref,
      text,
      // Read by the operator inside the OS biometric prompt, so it names the agent
      // rather than the app — on Home that name is the only confirmation of where this
      // is going.
      reason: 'Dispatch to ${target.title}',
    );
    // No haptic here: `Composer._send` already fired one on the tap, in the frame that
    // cleared the field. A second buzz when the host answers would read as a second
    // event, and there was only one.
    if (context.mounted) _say(context, outcome, target);
    return outcome.succeeded;
  }

  /// Interrupts the current turn. The agent stays alive; its context is untouched.
  ///
  /// **This is the mutation that existed and could not be reached.** `AgentRepository`
  /// has had it, gated and tested, since the repository was written, and the host has
  /// had the route — no screen ever called it, so the loosest mutation in ADR-8 was
  /// fully paid for and never delivered.
  ///
  /// Always says something, even on success, which is the opposite of [dispatch]. A
  /// dispatch confirms itself: the agent replies. An interrupt's whole result is that
  /// *nothing else happens*, and silence is exactly what the operator is trying to tell
  /// apart from a tap that missed.
  Future<bool> stop(BuildContext context, Cell target) async {
    final outcome = await agents.stop(target.ref, reason: 'Stop ${target.title}');
    if (outcome.succeeded) Tactile.sent();
    if (!context.mounted) return outcome.succeeded;
    _say(
      context,
      outcome,
      target,
      whenSent: '${target.title} was interrupted. It is still running.',
    );
    return outcome.succeeded;
  }

  /// Ends the cell. The pane leaves its workspace and the process stops.
  ///
  /// The heaviest haptic in the vocabulary, and the argument is `Tactile.answered`'s
  /// own: this is an irreversible act performed from a pocket, and a distinctly heavier
  /// response is what makes it *felt* when the screen is being read at arm's length.
  /// The confirmation happened in the row; this is the moment it becomes true.
  Future<bool> close(BuildContext context, Cell target) async {
    final outcome = await agents.close(target.ref, reason: 'Close ${target.title}');
    if (outcome.succeeded) Tactile.answered();
    if (!context.mounted) return outcome.succeeded;
    _say(
      context,
      outcome,
      target,
      // Names what survives, not just what ended. The transcript staying on the machine
      // is the difference between "I lost that work" and "I cannot reach it from here",
      // and the operator cannot check from a pocket.
      whenSent: '${target.title} was closed. Its transcript stays on the machine.',
    );
    return outcome.succeeded;
  }

  /// Answers a pending prompt with the digit the host printed.
  ///
  /// Goes to `/input` — a **key press** — never `/dispatch`, which is a sentence the host
  /// appends a submit key to. On a structured cell (`tui: false`) a dispatch becomes a new
  /// user message and leaves the approval untouched: measured against a VPS host on
  /// 2026-09-05, the answer left as a dispatch, the host said 200, Codex stayed blocked,
  /// and the phone kept saying "needs you" with no way for the operator to act on it.
  ///
  /// Silent on success on purpose. The card going away is the feedback, and a snackbar
  /// over the answer the operator just gave says nothing they cannot already see.
  Future<bool> answer(BuildContext context, Cell target, PromptOption option) async {
    final outcome = await agents.sendInput(
      target.ref,
      option.key,
      reason: 'Answer ${target.title}',
    );
    if (outcome.succeeded) Tactile.answered();
    if (!context.mounted) return outcome.succeeded;
    _say(context, outcome, target);
    return outcome.succeeded;
  }

  /// One notice path for all of them, so a success that deserves words and a failure that
  /// already has them cannot be reported in two different registers.
  void _say(
    BuildContext context,
    MutationOutcome outcome,
    Cell target, {
    String? whenSent,
  }) {
    final notice = outcome.succeeded ? whenSent : noticeFor(outcome, agent: target.title);
    if (notice == null) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(SnackBar(content: Text(notice)));
  }
}
