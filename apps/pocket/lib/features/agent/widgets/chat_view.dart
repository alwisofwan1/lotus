import 'dart:async';
import 'package:flutter/material.dart';

import '../../shared/refreshable.dart';
import 'chat_empty.dart';
import '../chat_layout.dart';
import '../chat_scroll.dart';
import '../turn_progress.dart';
import '../../../models/conversation.dart';
import '../chat_transcript.dart';
import '../question_digits.dart';
import '../pending_dispatch.dart';
import '../../../data/agent_outcome.dart';
import '../../../models/cell_result.dart';
import 'chat_row_view.dart';
import 'chat_marks.dart';

/// Chat: what you asked, what it did, what it said.
///
/// **Count the colour on this screen: none.** That is the mockup's own note, and it is
/// what makes the permission card work — a decision arrives into a page that was
/// entirely quiet, so the amber is unmissable without being loud. The two exceptions
/// this widget allows are both failures, which is the one other thing colour means: a
/// dispatch that never left the device, and a cell in the error state.
///
/// The three kinds of line are told apart by **typeface**, never by decoration: the
/// fill is yours, mono is what it did, serif is what it said. So there is no left
/// stripe on the prose — the letterforms already carry that job.
///
/// Grouping, day breaks and the tail live in [ChatLayout]; this renders rows and owns
/// only what needs a frame to answer: where the scroll is, which runs are open, and how
/// much has arrived since the operator looked away.
class ChatView extends StatefulWidget {
  const ChatView({
    required this.transcript,
    required this.agent,
    required this.onOpenTerminal,
    required this.onRefresh,
    this.footer,
    this.historyEdgeAt,
    this.pending = const [],
    this.live,
    this.turns = const [],
    this.working = false,
    this.ending = false,
    this.outcome,
    this.result,
    this.onOpenChanges,
    this.onAnswerQuestion,
    this.questionChoices = ScreenChoices.none,
    this.emptyNote,
    this.onRetry,
    this.onLoadOlder,
    this.onQuote,
    super.key,
  });

  final ChatTranscript transcript;

  /// Named above each reply, so a column of them reads as a conversation.
  final String agent;

  /// The way into raw output. Placed where the raw output would be, not in a tab at the
  /// top: raw is a property of a **step**, not of the screen, and at the end of the
  /// transcript this same line is the live tail.
  final VoidCallback onOpenTerminal;

  /// Re-reads the agent from the host.
  ///
  /// Reached by pulling **at the top of the transcript**, which is where a chat can
  /// afford the gesture: this view opens pinned to the newest line, so the operator has
  /// to have scrolled back through history to be anywhere near it. That is also when it
  /// is most wanted — a socket that died leaves the tail frozen, and the tail is the
  /// part that looks fine.
  final Future<void> Function() onRefresh;

  /// The permission card, when one is being asked. Sits after the transcript because it
  /// interrupts it.
  final Widget? footer;

  /// Entry count when the host's ring is full, so the top can say where history stops.
  /// Null below the cap — nothing was dropped, so there is nothing to announce.
  final int? historyEdgeAt;

  /// What the operator said that the host has not echoed back yet.
  final List<PendingDispatch> pending;

  /// What the agent is doing right now, for a host with no conversation lane.
  final String? live;

  /// The turns behind [transcript], read for each turn's progress.
  final List<Turn> turns;

  /// Whether the agent is working now; an open turn draws its progress only then.
  final bool working;

  /// Whether the list ends with the finished turn's facts line.
  final bool ending;

  /// The ring's account of the last turn, for the tail line. Null while it is running.
  final AgentOutcome? outcome;

  /// Git's account of the disk, for the same line.
  final CellResult? result;

  /// Opens the full account in a sheet. Null when the line has nothing behind it.
  final VoidCallback? onOpenChanges;

  /// Answers a question drawn in the flow, by its printed digit. Null where this app cannot.
  final void Function(String key)? onAnswerQuestion;

  /// What the screen offers for the open question — digits, and the terminal's own choices.
  final ScreenChoices questionChoices;

  /// Shown when there is not a single row to draw — an empty screen otherwise says
  /// nothing about whether that is normal, and this one is: the host's ring lives in
  /// memory, so every desktop restart empties it until the agent's next turn.
  ///
  /// Deliberately not a fallback for *every* quiet state. A transcript with one step in
  /// it is already telling the operator something, and a note under it would be the app
  /// talking over the agent.
  final String? emptyNote;

  /// Fetches older history on scroll-to-top (Fase 3). Null in Chat's two other states,
  /// which have nothing to page: a failed read, and a cell the host cannot record for.
  final Future<void> Function()? onLoadOlder;

  final void Function(PendingDispatch)? onRetry;

  /// Quotes a reply into the composer, unsent. Null on a surface without one.
  final void Function(String text)? onQuote;

  @override
  State<ChatView> createState() => _ChatViewState();
}

class _ChatViewState extends State<ChatView> {
  late final ChatScroll _scroll;

  /// Which finished turns' summaries the operator has opened, by turn id.
  final Set<String> _expanded = {};

  /// The highest phase each turn has shown, so a phase never goes backwards on screen.
  final Map<String, Phase> _floors = {};

  Map<String, TurnProgress> _progress() => {
        for (final turn in widget.turns)
          turn.turnId: () {
            final p = TurnProgress.of(turn, floor: _floors[turn.turnId] ?? Phase.reading);
            if (turn.isOpen) _floors[turn.turnId] = p.phase;
            return p;
          }(),
      };

  /// How long the transcript was when the operator scrolled away from the end.
  int _readTo = 0;

  /// The keyboard's height as of the last frame — see [didChangeDependencies].
  double _inset = 0;

  int get _unread => (widget.transcript.items.length - _readTo).clamp(0, 999);

  @override
  void initState() {
    super.initState();
    _scroll = ChatScroll(
      onStickChanged: (stuck) => setState(() {
        // Everything present at the moment of leaving counts as read; what arrives after is
        // what the counter is for.
        if (!stuck) _readTo = widget.transcript.items.length;
      }),
      onReachedTop: () => unawaited(widget.onLoadOlder?.call() ?? Future.value()),
    );
    // Open at the newest, which is what the operator came for — and what puts a waiting
    // permission card on screen instead of below a long transcript.
    _scroll.stickToBottom();
  }

  /// Follows the keyboard, not only the content.
  ///
  /// The defect this fixes: sticky scroll fired on *new lines* alone, so raising the
  /// keyboard shrank the viewport under a transcript that stayed where it was and hid
  /// the newest line behind the keys — at the exact moment the operator was about to
  /// reply to it.
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final inset = MediaQuery.viewInsetsOf(context).bottom;
    if (inset == _inset) return;
    _inset = inset;
    _scroll.stickToBottom();
  }

  @override
  void didUpdateWidget(ChatView old) {
    super.didUpdateWidget(old);
    // Reported before the growth check below: a page of older history changes the length
    // without anything new having happened, and the counter must not read it as forty
    // unread lines on a screen where nothing moved.
    _readTo += _scroll.noteTranscript(old.transcript, widget.transcript);
    final grew = old.transcript.items.length != widget.transcript.items.length ||
        old.pending.length != widget.pending.length ||
        old.live != widget.live ||
        old.working != widget.working ||
        old.ending != widget.ending;
    if (grew) _scroll.stickToBottom();
  }

  @override
  void dispose() {
    _scroll.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final layout = ChatLayout.of(
      widget.transcript,
      historyEdgeAt: widget.historyEdgeAt,
      pending: widget.pending,
      live: widget.live,
      progress: _progress(),
      working: widget.working,
      ending: widget.ending,
    );

    // Nothing to draw yet — a state of its own, and its own widget. See [ChatEmpty].
    // Guarded on the footer too: a permission card with no transcript behind it is not
    // an empty screen, it is the most important screen in the app.
    if (layout.rows.isEmpty && widget.footer == null && widget.emptyNote != null) {
      return ChatEmpty(
        note: widget.emptyNote!,
        onRefresh: widget.onRefresh,
        onOpenTerminal: widget.onOpenTerminal,
      );
    }

    return Stack(
      children: [
        Refreshable(
          onRefresh: widget.onRefresh,
          // `.builder`, not a children list. The list form constructs a widget for **every**
          // row on every build — and this rebuilds on every store notification, which since
          // streaming landed is once per chunk of the reply. Measured 2026-09-08 on an
          // 800-line transcript: 7.3ms per chunk with the list, against a 16ms frame. The
          // derivation above is not the cost (0.13ms for the same 800); constructing eight
          // hundred rows to lay out eight of them is.
          child: ListView.builder(
          controller: _scroll.controller,
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.only(left: 18, right: 18, top: 16, bottom: 8),
          itemCount: layout.rows.length + (widget.footer == null ? 0 : 1),
          itemBuilder: (context, i) {
            if (i >= layout.rows.length) return widget.footer;
            return ChatRowView(
              row: layout.rows[i],
              agent: widget.agent,
              expanded: _expanded,
              onToggleRun: (id) => setState(() {
                if (!_expanded.remove(id)) _expanded.add(id);
              }),
              onRetry: widget.onRetry,
              outcome: widget.outcome,
              result: widget.result,
              onOpenChanges: widget.onOpenChanges,
              onAnswerQuestion: widget.onAnswerQuestion,
              questionChoices: widget.questionChoices,
              onQuote: widget.onQuote,
            );
          },
          ),
        ),
        const TranscriptTopFade(),
        // Only while the operator has scrolled away from the end. It is the one control
        // that says "there is more below", which a scrollbar on a phone does not.
        if (!_scroll.stuck)
          Positioned(
            right: 14,
            bottom: 10,
            child: JumpToLatest(
              unread: _unread,
              onTap: () {
                setState(() => _readTo = widget.transcript.items.length);
                _scroll.stick();
              },
            ),
          ),
      ],
    );
  }
}
