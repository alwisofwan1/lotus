import 'package:flutter/material.dart';

import '../../../data/agent_repository.dart';
import '../../../models/cell.dart';
import '../../../models/permission.dart';
import '../page_mode.dart' show PageMode;
import 'agent_input.dart';
import 'answer_chips.dart';
import 'immersive_controls.dart';
import 'raw_terminal.dart';

/// The terminal, or nothing at all — and everything it needs handed to it in one place.
///
/// Its own widget because `AgentPage` reached the 300-line ceiling for the fourth time
/// while wiring keys, and this was the part that kept growing: eight arguments that all
/// answer *what does the terminal need to exist*, none of which the page reads itself.
class TerminalSlot extends StatelessWidget {
  const TerminalSlot({
    required this.cell,
    required this.mode,
    required this.repository,
    required this.onPick,
    required this.onAsk,
    required this.onFinding,
    required this.onToggleLive,
    required this.prompt,
    required this.onAnswer,
    this.onSessions,
    this.immersive,
    this.onGrid,
    super.key,
  });

  final Cell cell;
  final PageMode mode;
  final AgentRepository repository;

  /// Where a snippet or a selection lands: Chat's field, unsent.
  final ValueChanged<String> onPick;

  /// A selection to ask the agent about: Chat's quote strip, unsent.
  final ValueChanged<String> onAsk;

  /// The find bar opened or closed — the page lends it the header's row.
  final ValueChanged<bool> onFinding;

  final VoidCallback onToggleLive;

  /// What the cell is asking, **only when it may be answered from here**
  /// (`PermissionSnapshot.answerable`). Null is no chips — the ADR-8 gate is the caller's.
  final PermissionPrompt? prompt;

  final void Function(PromptOption option) onAnswer;

  /// The dock's Sessions button; the pager owns the sheet (v4 tiket 08).
  final VoidCallback? onSessions;

  /// Non-null while the page is immersed (v4 tiket 10).
  final ImmersiveExits? immersive;

  /// The terminal's area in cells — the page's `PtySizeLease` (v4 tiket 11).
  final void Function(int cols, int rows)? onGrid;

  @override
  Widget build(BuildContext context) {
    // Before the first visit there is nothing to lay out, and laying one out anyway is a
    // cost paid by every page the operator merely swipes past.
    if (!mode.everOpened) return const SizedBox.shrink();

    return RawTerminal(
      // Not the visit: one emulator for as long as the page lives, so going to Chat and
      // back keeps the scroll and the zoom. A re-subscribe empties it (`TerminalFeed.reset`).
      key: ValueKey(cell.ref),
      buffer: repository.output,
      cell: cell.ref,
      live: mode.live,
      onToggleLive: onToggleLive,
      onPick: onPick,
      onAsk: onAsk,
      agent: cell.title,
      onFinding: onFinding,
      provider: cell.agentType,
      onSessions: onSessions,
      immersive: immersive,
      onGrid: onGrid,
      answers: switch (prompt) {
        final asked? => AnswerChips(agent: cell.title, prompt: asked, onAnswer: onAnswer),
        null => null,
      },
      // Absent on a host that predates the route, rather than a `⌨` that 404s into a
      // sentence about the wrong thing.
      onInput: repository.canTypeOn(cell.host)
          ? (data) => sendKeys(context, repository: repository, cell: cell, data: data)
          : null,
    );
  }
}
