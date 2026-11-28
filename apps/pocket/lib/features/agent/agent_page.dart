import 'dart:async';

import 'package:flutter/foundation.dart' show ValueListenable;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show SystemChrome, SystemUiMode, SystemUiOverlayStyle;

import '../../app/theme/theme.dart';
import '../../data/agent_repository.dart';
import '../../data/dictation.dart';
import '../../data/draft_keeper.dart';
import '../../data/live_conversation.dart';
import '../../data/transcript_pager.dart';
import '../../data/snippets.dart';
import '../../models/cell.dart';
import '../../models/permission.dart';
import '../shared/agent_mutations.dart';
import '../../data/agent_outcome.dart';
import 'chat_seed.dart';
import 'widgets/changes_sheet.dart';
import 'pending_dispatch.dart';
import 'pty_size_lease.dart';
import 'question_flow.dart';
import 'question_poll.dart';
import 'page_mode.dart';
import 'diff_screen.dart';
import 'widgets/agent_input.dart';
import 'widgets/agent_top_bar.dart';
import 'widgets/agent_views.dart';
import 'widgets/immersive_controls.dart' show ImmersiveExits;
import 'widgets/mini_bar.dart';
import 'widgets/quote_strip.dart';
import 'widgets/chat_body.dart';
import 'widgets/terminal_slot.dart';

part 'agent_page_views.dart';
part 'agent_page_speech.dart';

/// One agent, as a full page: a one-row header, then Chat or Terminal, then the composer.
///
/// **Chat and Terminal are two equal views** (v4 tiket 03, ADR-6 addendum 2026-10-04),
/// switched by [AgentTopBar]'s `Chat | Terminal`. They used to be a sheet rising over Chat
/// (2026-08-08), built so `‹` could never mean *leave the mode*; that rule survives — `‹`
/// still only leaves the page — while the sheet's costs (a drag to close, 34px of dimmed
/// Chat, a new emulator per visit) did not. Terminal may also take the header's space
/// ([PageMode.immersive]), the one case where this page hides its own furniture.
///
/// Holds no policy: loading goes through `AgentRepository.load`, which never throws, and every
/// mutation through the repository, which runs the biometric gate itself (ADR-8).
class AgentPage extends StatefulWidget {
  const AgentPage({
    required this.cell,
    required this.repository,
    this.dictation,
    required this.live,
    required this.pager,
    required this.index,
    required this.total,
    this.active,
    required this.waitingAt,
    required this.snippets,
    required this.drafts,
    required this.hostLabel,
    required this.onBack,
    this.onSessions,
    super.key,
  });

  final Cell cell;
  final AgentRepository repository;

  /// Null in a build with no microphone. The composer also needs the host to advertise
  /// `stt`, asked of the repository at build time rather than stored.
  final Dictation? dictation;

  /// The transcript, following the socket. Taken whole rather than as a snapshot,
  /// because the point is that it **changes** while this page is open.
  final LiveConversation live;

  /// Walks this cell's transcript backwards as the operator scrolls up (Fase 3).
  final TranscriptPager pager;

  /// Lines kept for this cell's machine. Written on every send; nothing reads them since
  /// the terminal's palette was dropped (2026-10-04), and the store is kept for its return.
  final Snippets snippets;

  /// What was left unsent for this agent last time. Read once on the way in and written
  /// as the field changes — see [DraftKeeper] for why a draft is worth storing at all.
  final DraftKeeper drafts;
  final int index;
  final int total;

  /// The pager's current index, or null when nothing pages this page. Which page is in
  /// front decides who holds the host's tail — see [_AgentViews._syncTail].
  final ValueListenable<int>? active;
  final Set<int> waitingAt;
  /// This cell's machine, already qualified — see [AgentTopBar.hostLabel].
  final String hostLabel;

  final VoidCallback onBack;

  /// The pager's Sessions sheet, reached from the terminal dock (v4 tiket 08).
  final VoidCallback? onSessions;

  @override
  State<AgentPage> createState() => _AgentPageState();
}

class _AgentPageState extends State<AgentPage> with _AgentViews, _Speech {
  AgentView? _view;

  /// The composer's field, owned here so the palette and a selection have somewhere to
  /// put text. Handed to [AgentInput], which hands it to the composer.
  @override
  late final TextEditingController _composer =
      TextEditingController(text: widget.drafts.draftFor(widget.cell.ref) ?? '');

  /// Reads again while this cell holds a question — nothing pushes that (`question_poll.dart`).
  late final QuestionPoll _poll;

  /// Keeps the field's contents for next time, on every change.
  ///
  /// Every change, because [DraftKeeper] is the thing that decides what that costs: it
  /// takes the keystroke into memory immediately and lets storage settle. Leaving the
  /// page flushes whatever was still waiting — see [dispose].
  void _keepDraft() =>
      unawaited(widget.drafts.keep(widget.cell.ref, _composer.text));

  @override
  void initState() {
    super.initState();
    _composer.addListener(_keepDraft);
    widget.active?.addListener(_syncTail);
    _poll = QuestionPoll(
      live: widget.live,
      ref: widget.cell.ref,
      reload: _load,
      // The page holds the host's own answer, so it is the only place that can offer the
      // second opinion the poll needs before giving up (`QuestionPoll.hostAwaiting`).
      hostAwaiting: () => _view?.permission?.awaiting ?? false,
    );
    _load();
  }

  @override
  void didUpdateWidget(AgentPage old) {
    super.didUpdateWidget(old);
    // This used to clear everything when the cell changed, believing a swipe reuses one State
    // for a different cell. It does not: `PageView.builder` gives each index its own element
    // and `AgentScreen` freezes its refs on open (`issues/12`).
    assert(old.cell.ref == widget.cell.ref);
    // The fleet's word changed, so the card's answer has to be read again: `/permission` is
    // read on open and after a send, by nothing else. Both directions (`agent_page_test.dart`).
    if (old.cell.needsInput != widget.cell.needsInput) unawaited(_load());
  }

  @override
  void dispose() {
    _poll.dispose();
    widget.active?.removeListener(_syncTail);
    _composer.removeListener(_keepDraft);
    // Before the field goes: the last thing typed may still be inside the settle window,
    // and this page is the last object that could have written it.
    unawaited(widget.drafts.flush());
    _composer.dispose();
    _typing.dispose();
    // Leaving the page stops the stream: bytes nobody is looking at are the cost `MVP.md`
    // counts at ~13 KB for one trivial prompt.
    if (_tailing) widget.repository.stopTailing(widget.cell.ref);
    // The transcript is **not** touched here: it belongs to `AgentScreen`, the only object
    // that knows how many pages are alive.
    super.dispose();
  }

  /// Reads this cell, then seeds the transcript with whatever the host had. The store is
  /// **already collecting** before this runs, which is why `seed` merges rather than
  /// replaces: a turn can produce a dozen hook events in one round trip.
  @override
  Future<void> _load() async {
    final view = await widget.repository.load(widget.cell.ref);
    if (!mounted) return;
    seedChat(widget.live, widget.cell.ref, view);
    final prompts = widget.live.promptsFor(widget.cell.ref);
    setState(() {
      _view = view;
      _pending.removeWhere((p) => p.settledBy(prompts));
    });
  }

  @override
  Widget build(BuildContext context) {
    final view = _view;
    // On Terminal every piece of chrome sits on termGround, so it reads that ground's theme
    // (a light theme keeps a dark terminal). Always wrapped, so the tree never reshapes.
    final chrome = _mode.onTerminal ? context.terminalChrome : Theme.of(context);
    Widget onGround(Widget child) => Theme(data: chrome, child: child);
    final ground = _mode.onTerminal ? context.tokens.termBg : context.tokens.bg;
    // `AgentScreen` leaves the status bar to the page, so Terminal's ground can reach the
    // top of the glass instead of stopping under a strip of the app's floor.
    final statusBar = MediaQuery.paddingOf(context).top;
    final c = widget.cell;
    final working = c.turnKnown && !c.isIdle && !c.needsInput;

    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: overlayFor(ground),
      child: PopScope(
      // System back gives back the keys first, then the immersion, then Chat, then the
      // page — the order every stacked surface on this platform uses (`PageMode.back`).
      canPop: _mode.back == null,
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) _back();
      },
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          AnimatedContainer(
            duration: AgentViews.fade,
            height: statusBar,
            color: ground,
          ),
          // Keys live: the header shrinks to what typing needs (v4 tiket 04). Full
          // screen too — it holds the only on-screen way to lower the keyboard.
          // Immersed, the floating ⌨ holds it instead (v4 tiket 10).
          if (_mode.live && !_mode.immersive)
            onGround(MiniBar(
              cell: widget.cell,
              hostLabel: widget.hostLabel,
              onBack: widget.onBack,
              onShow: _show,
              onKeysOff: _toggleLive,
            ))
          // Find open in Terminal: its bar is the header for as long as it lasts (B4).
          else if (!_mode.immersive && !(_finding && _mode.onTerminal))
            onGround(AgentTopBar(
              cell: widget.cell,
              index: widget.index,
              total: widget.total,
              waitingAt: widget.waitingAt,
              hostLabel: widget.hostLabel,
              shown: _mode.surface,
              // No switch while the read has failed or not landed: it would open a pane
              // for a host that just said it cannot be reached. None for a Chat cell: no terminal.
              onShow: widget.cell.terminal && view != null && !view.isFailed ? _show : null,
              onBack: widget.onBack,
              // No *Send here*: the composer below is already this agent's.
              actions: _mutations.handlers(context),
              // Drawn only when git has files, so it never opens an empty sheet.
              changedFiles: view?.result?.changes?.files.length,
              onOpenChanges: () => showChangesSheet(
                context,
                outcome: widget.cell.isIdle
                    ? AgentOutcome.ofTurns(widget.live.turnsFor(widget.cell.ref))
                    : null,
                result: view?.result,
                onShowDiff: (view?.result?.knowsChanges ?? false)
                    ? (path) => openDiff(context,
                        cell: widget.cell, repository: widget.repository, path: path)
                    : null,
              ),
            )),
          Expanded(
            child: AgentViews(
              shown: _mode.surface,
              chat: ChatBody(
                cell: widget.cell,
                view: view,
                live: widget.live,
                pending: _pending,
                onReload: _load,
                onRetry: _retry,
                onOpenTerminal: _enterTerminal,
                pager: widget.pager,
                onAnswer: _answer,
                onTypeNext: _typing.expect,
                // Lands in the field the composer already owns, and asks for the
                // keyboard the way a handover does: quoting is the first half of a
                // sentence, so the caret should be waiting for the second.
                onQuote: _hold,
                onShowDiff: (path) => openDiff(context, cell: widget.cell, repository: widget.repository, path: path),
              ),
              terminal: onGround(ColoredBox(color: ground, child: _terminal(view))),
            ),
          ),
          onGround(AgentInput(
            cell: widget.cell,
            repository: widget.repository,
            controller: _composer,
            quote: _quote,
            onDropQuote: () => setState(() => _quote = null),
            focusNode: _typing.node,
            dictation: widget.dictation,
            sending: _sending,
            terminalShown: _mode.onTerminal,
            terminalLive: _mode.live,
            answerable: view?.answerable ?? false,
            placeholder: working ? 'Add an instruction…' : 'Reply to ${c.title}…',
            onShow: widget.cell.terminal && view != null && !view.isFailed ? _show : null,
            onSend: _send,
          )),
        ],
      ),
      ),
    );
  }
}
