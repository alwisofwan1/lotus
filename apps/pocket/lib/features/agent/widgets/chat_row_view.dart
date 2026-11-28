import 'package:flutter/material.dart';

import '../../../data/agent_outcome.dart';
import '../../../models/cell_result.dart';
import '../chat_layout.dart';
import '../chat_transcript.dart';
import '../question_digits.dart';
import '../pending_dispatch.dart';
import 'chat_lines.dart';
import 'chat_steps.dart';
import 'chat_marks.dart';
import 'chat_progress.dart';
import 'chat_result.dart';
import 'question_card.dart';

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
    this.onDone,
    this.onInstruct,
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

  final VoidCallback? onDone;
  final void Function(String text)? onInstruct;

  @override
  Widget build(BuildContext context) => switch (row) {
        HistoryEdgeRow(:final entries) => HistoryEdge(entries: entries),
        DayBreakRow(:final at) => DayMark(at: at),
        TurnBreakRow() => const TurnGap(),
        LineRow(:final item) => _line(item),
        PendingRow(:final pending) => MineBubble(
            text: pending.text,
            state: pending.state,
            onRetry: onRetry == null ? null : () => onRetry!(pending),
          ),
        LiveRow(:final text) => LiveLine(text: text),
        ProgressRow(:final progress) => ProgressCard(progress: progress, onStop: onStop),
        SummaryRow(:final turnId, :final progress) => SummaryLine(
            progress: progress,
            open: expanded.contains(turnId),
            onToggle: () => onToggleRun(turnId),
          ),
        ResultRow(:final done) => ResultBlock(
            facts: resultFacts(outcome, result),
            done: done,
            onOpenChanges: onOpenChanges,
            onDone: onDone,
          ),
        TidyRow(:final files) => onInstruct == null
            ? const SizedBox.shrink()
            : TidyOffer(files: files, onInstruct: onInstruct!),
      };

  Widget _line(ChatItem item) => switch (item.kind) {
        ChatLine.prompt => MineBubble(text: item.text, at: item.timestamp),
        ChatLine.question => QuestionCard(
            questions: item.questions ?? const [],
            onAnswer: onAnswerQuestion,
            digits: questionChoices.digits,
            extras: questionChoices.extras,
          ),
        // Work stays in Terminal; `ChatLayout` never hands these over.
        ChatLine.step || ChatLine.thinking => const SizedBox.shrink(),
        ChatLine.problem => ProblemLine(item: item),
        ChatLine.notice => NoticeLine(item: item),
        ChatLine.prose => ProseLine(item: item, agent: agent, onQuote: onQuote),
      };
}
