import 'package:flutter/material.dart';

import '../../../data/agent_outcome.dart';
import '../../../models/cell_result.dart';
import '../chat_layout.dart';
import '../chat_transcript.dart';
import '../question_digits.dart';
import '../pending_dispatch.dart';
import 'chat_lines.dart';
import 'chat_marks.dart';
import 'chat_steps.dart';
import 'question_card.dart';
import 'thinking_block.dart';
import 'turn_tail.dart';
import 'working_row.dart';

/// One row of Chat, as the widget it is.
///
/// Split out of [ChatView] when that file passed 300 lines. The seam is a good one on
/// its own terms: **what a row looks like** is a table, and **where the scroll is** is
/// state — the file that owns the second no longer has to hold the first. Everything a
/// row needs arrives as an argument, so this is a pure mapping with no access to the
/// list's state.
class ChatRowView extends StatelessWidget {
  const ChatRowView({
    required this.row,
    required this.agent,
    required this.expanded,
    required this.onToggleRun,
    this.onRetry,
    this.onStop,
    this.outcome,
    this.result,
    this.onOpenChanges,
    this.onAnswerQuestion,
    this.questionChoices = ScreenChoices.none,
    this.onQuote,
    super.key,
  });

  final ChatRow row;

  /// The cell's name, for the label above prose.
  final String agent;

  /// Which collapsed runs and settled thinking blocks the operator has opened, by id.
  final Set<String> expanded;

  /// Toggles one of them. The set lives with the scroll state, in [ChatView].
  final void Function(String id) onToggleRun;

  final void Function(PendingDispatch)? onRetry;
  final VoidCallback? onStop;
  final AgentOutcome? outcome;
  final CellResult? result;
  final VoidCallback? onOpenChanges;

  /// Answers a question in the flow, by the digit the host printed beside the option.
  ///
  /// Null on a cell this app cannot answer from here — a terminal cell, where the digits
  /// belong to the screen (ADR-8) — and the card is then a record rather than a control.
  final void Function(String key)? onAnswerQuestion;

  /// What the screen offers for this question — a digit per option, and the terminal's own
  /// choices. Empty for a cell whose options carry their own digits, and for one whose screen
  /// could not be read.
  final ScreenChoices questionChoices;

  /// Quotes a reply into the composer, unsent. Null where there is no composer.
  final void Function(String text)? onQuote;

  @override
  Widget build(BuildContext context) => switch (row) {
        HistoryEdgeRow(:final entries) => HistoryEdge(entries: entries),
        DayBreakRow(:final at) => DayMark(at: at),
        TurnBreakRow() => const TurnGap(),
        LineRow(:final item) => _line(item),
        StepRunRow(:final id) => StepCapsule(
            row: row as StepRunRow,
            expanded: expanded.contains(id),
            onToggle: () => onToggleRun(id),
          ),
        PendingRow(:final pending) => MineBubble(
            text: pending.text,
            state: pending.state,
            onRetry: onRetry == null ? null : () => onRetry!(pending),
          ),
        LiveRow(:final text) => LiveLine(text: text),
        WorkRow(:final state) => WorkingRow(state: state, onStop: onStop),
        // Open while it is the newest thing, and openable once it is not: the
        // expansion set is the same one the collapsed step runs use.
        TailRow() => TurnTail(outcome: outcome, result: result, onOpen: onOpenChanges),
      };

  Widget _line(ChatItem item) => switch (item.kind) {
        ChatLine.prompt => MineBubble(text: item.text, at: item.timestamp),
        ChatLine.question => QuestionCard(
            questions: item.questions ?? const [],
            onAnswer: onAnswerQuestion,
            digits: questionChoices.digits,
            extras: questionChoices.extras,
          ),
        ChatLine.step => StepLine(item: item),
        ChatLine.problem => ProblemLine(item: item),
        ChatLine.notice => NoticeLine(item: item),
        ChatLine.prose => ProseLine(item: item, agent: agent, onQuote: onQuote),
        // Reached only for a lone reasoning line outside a run, which `ChatLayout` does
        // not produce today — kept exhaustive rather than wildcarded so a new kind
        // cannot be added without a decision here.
        ChatLine.thinking => ThinkingBlock(items: [item], open: true),
      };
}
