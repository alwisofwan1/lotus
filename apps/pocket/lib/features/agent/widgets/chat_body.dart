import 'package:flutter/material.dart';

import '../../../data/agent_repository.dart';
import '../../../data/live_conversation.dart';
import '../../../data/transcript_pager.dart';
import '../../../models/cell.dart';
import '../../../models/conversation.dart';
import '../../../models/permission.dart';
import '../agent_activity.dart';
import '../../shared/refreshable.dart';
import '../chat_transcript.dart';
import '../question_flow.dart';
import '../pending_dispatch.dart';
import '../../../data/agent_outcome.dart';
import 'agent_notices.dart';
import 'chat_view.dart';
import 'changes_sheet.dart';
import 'permission_card.dart';

/// Chat, in whichever of its three states this cell is in.
///
/// Split out of `AgentPage` when that file hit the 300-line limit, and the cut is where
/// it is because these three branches answer one question — *what belongs in the body
/// right now* — while everything left behind answers a different one: what this page is
/// doing (loading, sending, showing the terminal sheet). The page kept the verbs; this
/// took the rendering.
///
/// It is deliberately given values rather than the collaborators that produce them: it
/// listens to [live] because a hook event has to redraw a transcript, and it holds no
/// repository, so there is nothing here that could dispatch on its own (ADR-13 no. 1).
class ChatBody extends StatelessWidget {
  const ChatBody({
    required this.cell,
    required this.view,
    required this.live,
    required this.pending,
    required this.onReload,
    required this.onRetry,
    required this.onOpenTerminal,
    required this.onAnswer,
    this.onTypeNext,
    this.onQuote,
    required this.pager,
    this.onShowDiff,
    super.key,
  });

  /// Opens one file's diff. Null when the host cannot serve one, and the file rows are
  /// then plain text rather than a control the machine could not honour.
  final void Function(String path)? onShowDiff;

  /// Asks for the keyboard, after a choice that ends the question and expects the next thing
  /// to be typed — the terminal's own `Type something.` and `Chat about this`.
  final VoidCallback? onTypeNext;

  /// Quotes a reply, or a run selected inside one, into the composer — **unsent**.
  ///
  /// A collaborator's job by the letter of ADR-13 no. 1, and not one by its spirit: what
  /// arrives here writes into a text field the operator still has to press send on, so
  /// nothing on this path can dispatch. Same door the palette and the terminal's
  /// selection already use (`prefill`).
  final void Function(String text)? onQuote;

  final Cell cell;

  /// Null before the first load resolves — nothing is drawn rather than a spinner,
  /// because the header above already says what this cell is doing.
  final AgentView? view;

  final LiveConversation live;

  /// Sentences the operator sent that the host has not echoed back yet, still filtered
  /// against the live prompts by the caller's own settling rule.
  final List<PendingDispatch> pending;

  /// Retries the initial load — the failure state's only action.
  /// Re-reads this agent. Awaitable because it is now also what a pull-to-refresh
  /// runs, and an indicator that hides before the read lands teaches the operator that
  /// pulling does nothing. `AgentPage._load` already returned a future; only the type
  /// here was throwing it away.
  final Future<void> Function() onReload;

  /// Walks this cell's transcript backwards as the operator scrolls up (Fase 3).
  ///
  /// A collaborator, which this widget otherwise avoids — but the rule it is avoiding is
  /// about **mutation**: nothing here may dispatch on its own (ADR-13 no. 1). A pager only
  /// reads, and [live] is already a collaborator held for the same kind of reason.
  final TranscriptPager pager;

  final void Function(PendingDispatch dispatch) onRetry;
  final VoidCallback onOpenTerminal;

  /// Sends a permission answer as its printed digit (ADR-8).
  final void Function(PromptOption option) onAnswer;

  @override
  Widget build(BuildContext context) {
    final current = view;
    if (current == null) return const SizedBox.shrink();
    // `That machine is asleep.` — the one screen in the app where the operator is most
    // certain to try pulling, because the sentence itself invites asking again. The
    // `TRY AGAIN` button stays: a gesture with no visible control is a gesture only
    // people who already expect it will find.
    if (current.isFailed) {
      return Refreshable.fill(
        onRefresh: onReload,
        child: AgentFailure(failure: current.failure, onRetry: onReload),
      );
    }
    if (!current.chatAvailable) {
      return Refreshable(
        onRefresh: onReload,
        child: TerminalOnlyNotice(
          cell: cell,
          reason: current.blocked!,
          onOpenTerminal: onOpenTerminal,
        ),
      );
    }

    // Rebuilt from the live store on every step, rather than from the snapshot the page
    // happened to open with. `ChatTranscript.ofTurns` stays the single place that decides
    // what a line is — the source moved twice now, the rules did not.
    return ListenableBuilder(
      listenable: live,
      builder: (context, _) {
        // Asked for **this** cell by name. The store holds the pager's whole reachable
        // window, so a page that reads "whatever is current" would render its
        // neighbour's steps under its own agent's name (`issues/12`).
        final turns = live.turnsFor(cell.ref);
        final prompts = live.promptsFor(cell.ref);
        return ChatView(
          transcript: ChatTranscript.ofTurns(turns),
          agent: cell.title,
          onOpenTerminal: onOpenTerminal,
          onRefresh: onReload,
          onQuote: onQuote,
          onLoadOlder: () => pager.loadOlder(cell.ref, live, from: view?.transcript?.oldestCursor),
          // The silence the host cannot report: the pipeline works, this pane has nothing in
          // it yet. Common after a desktop restart, and otherwise the same blank page as a
          // broken install.
          emptyNote: 'Nothing recorded for this agent yet. '
              'Steps and replies land here as they happen.',
          // Only at the cap. Below it nothing was dropped, so there is no edge to state.
          historyEdgeAt: live.atHistoryEdge(cell.ref) ? live.partsHeld(cell.ref) : null,
          pending: pending.where((p) => !p.settledBy(prompts)).toList(),
          // The fleet is the authority (ADR-8): asking is waiting, idle is finished even
          // before the closing hook lands.
          turns: turns,
          working: !cell.needsInput && !cell.isIdle && (turns.lastOrNull?.isOpen ?? false),
          ending: _ending(turns),
          live: liveLabel(cell),
          onRetry: onRetry,
          footer: _footer(current, turns),
          // Settled here first, then sent: the runner writes its own record of the answer only
          // after the keystroke lands, and a card that waited for it had the operator tapping
          // twice. `LiveConversation.settleQuestion` is this app's `resolving`.
          onAnswerQuestion: answerer(
            turns,
            (option) {
              live.settleQuestion(cell.ref, option.label);
              onAnswer(option);
            },
            choices: choicesFor(turns, current.permission),
            onHandover: onTypeNext,
          ),
          questionChoices: choicesFor(turns, current.permission),
          // The ring's account is about a *turn*, so it needs the fleet to say the turn
          // is over. Git's account is about the *disk*, which is true whatever the turn
          // is doing.
          outcome: cell.isIdle ? AgentOutcome.ofTurns(turns) : null,
          result: current.result,
          onOpenChanges: () => showChangesSheet(
            context,
            outcome: cell.isIdle ? AgentOutcome.ofTurns(turns) : null,
            result: current.result,
            onShowDiff: (current.result?.knowsChanges ?? false) ? onShowDiff : null,
          ),
        );
      },
    );
  }

  /// Whether the foot of Chat may describe what was left behind.
  ///
  /// Idle, or **unknown** — and unknown is not a hedge, it is the common case: Codex
  /// never reports a turn, and a Claude cell whose hooks do not reach it (`CLAUDE_CONFIG_DIR`
  /// under a ccs profile) reports none either. Measured 2026-08-27 on a paired phone:
  /// four cells, all `UNKNOWN`, and a gate on `isIdle` alone drew the card for none of
  /// them. What it must not do is describe a cell the fleet says is *running* or
  /// *waiting* — that turn is being written.
  /// Once the fleet calls the agent idle, the last turn has a result to show.
  bool _ending(List<Turn> turns) => turns.isNotEmpty && cell.isIdle && !cell.needsInput;

  static bool settled(Cell cell) => cell.isIdle || !cell.turnKnown;

  /// The one slot in Chat that answers *what now*. A question the agent is asking wins;
  /// otherwise, once it has stopped and the ring ends on its `stop`, what it left behind
  /// (`AgentOutcome`). Idle is read from the fleet, not inferred from the ring: a `stop`
  /// that is last but whose cell is already running again is a turn being overwritten.
  /// The one slot in Chat that answers *what now* — and since 2026-09-08 it holds
  /// **only** a question the agent is asking.
  ///
  /// What used to share it, the account of what the turn left behind, moved out of the
  /// flow entirely: one line at the end of the transcript (`TurnTail`) opening a sheet
  /// (`showChangesSheet`). It was a `ListView` child, so it pushed the agent's last
  /// sentence up the screen after every turn, and it drew even with nothing to report.
  Widget? _footer(AgentView current, List<Turn> turns) => footer(
        current.permission,
        questionOpen: asking(turns) || namedOnScreen(turns, current.permission),
        onAnswer: onAnswer,
        onOpenTerminal: onOpenTerminal,
      );

  /// **One interaction on screen, never two.**
  ///
  /// A question is drawn in the flow, where it happened and where its options and their words
  /// already are. So this slot holds a permission — and holds nothing at all while a question
  /// is still open, or a phone shows a named three-option question above a second card
  /// apologising that the options could not be named (reported 2026-09-09).
  ///
  /// `bb` cannot reach that state: an approval and a question are one interaction there, with
  /// one status and one resolution (`domain/pending-interactions.ts`). This is the same rule,
  /// enforced at the one place that draws.
  ///
  /// Static so the choice can be read on its own: it is the one branch here that decides what
  /// the operator is being asked to do.
  static Widget? footer(
    PermissionSnapshot? permission, {
    required bool questionOpen,
    required void Function(PromptOption option) onAnswer,
    required VoidCallback onOpenTerminal,
  }) {
    if (questionOpen || permission == null || !permission.awaiting) return null;
    return PermissionCard(
      snapshot: permission,
      onAnswer: onAnswer,
      onOpenTerminal: onOpenTerminal,
    );
  }
}
