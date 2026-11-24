part of 'agent_page.dart';

/// Which of the page's two views is up, and the tail that follows it — lifted out of the
/// page for the reason `host_api_reads.dart` was: one file, one concern.
///
/// It owns [_mode] because every transition here is a rule about that value and nothing
/// else — the page reads it to lay itself out, and changes it only through these.
mixin _AgentViews on State<AgentPage> {
  PageMode _mode = const PageMode();

  /// Chat's field — the only one on the page since v4 tiket 04.
  TextEditingController get _composer;

  /// Sends a printed digit (`_Speech`).
  Future<void> _answer(PromptOption option);

  /// Puts text in Chat's quote strip and asks for the keyboard (`_Speech`).
  void _hold(String text);

  /// Whether Terminal's find bar is open — it takes the header's row while it is.
  bool _finding = false;

  /// Whether this page is the one the pager is on. A page with nobody paging it (a lone
  /// page in a test, say) is in front by definition.
  bool get _inFront => widget.active == null || widget.active!.value == widget.index;

  /// Whether this page holds the host's tail, so only the page that took it gives it back.
  bool _tailing = false;

  /// Makes the tail agree with the rule: **the page in front, once Terminal was opened.**
  ///
  /// Not terminal visibility. The emulator outlives a visit, so going back to Chat must
  /// not cost the next visit a replay of the ring. And it is the answer to one tail per
  /// host (ADR-10): neighbours in the pager share a host and each keeps its emulator, but
  /// only the page in front streams — leaving the front releases, arriving starts, and no
  /// protocol is needed to arbitrate between them.
  ///
  /// Subscribing is still deliberate rather than on page open: a subscription is what makes
  /// the host stream `cell.output` at all, and tailing every pane the operator merely swipes
  /// past would spend cellular bytes on screens nobody opened.
  void _syncTail() {
    // The page in front owns the glass as well as the tail (v4 tiket 10).
    _syncChrome();
    _syncSize();
    final want = _inFront && _mode.everOpened;
    if (want == _tailing) return;
    _tailing = want;
    if (want) {
      widget.repository.tail(widget.cell.ref);
    } else {
      widget.repository.stopTailing(widget.cell.ref);
    }
  }

  /// The phone's hold on the pane's PTY size (v4 tiket 11). Always built: whether the host
  /// takes it is asked per request, so a host that reconnects with the flag starts working.
  late final _size = PtySizeLease(
    hold: (cols, rows, token) =>
        widget.repository.holdSize(widget.cell.ref, cols: cols, rows: rows, token: token),
    release: (token) => widget.repository.releaseSize(widget.cell.ref, token),
  );

  /// **The page in front, on Terminal** — narrower than the tail on purpose. The tail
  /// outlives a visit so the next one replays nothing; the size must not, or Chat would
  /// keep the desktop drawing at phone width with nobody looking at the terminal.
  void _syncSize() => _size.want(_inFront && _mode.onTerminal);

  void _show(AgentSurface surface) {
    // A Chat cell has no terminal; every way in (switch, notice, card button) ends here.
    if (surface == AgentSurface.terminal && !widget.cell.terminal) return;
    setState(() => _mode = _mode.show(surface).immersed(_landscape));
    _syncTail();
  }

  /// Which way the phone was held at the last dependency change.
  bool _landscape = false;

  /// Whether this page hid the status bar, so only the page that hid it gives it back.
  bool _chromeHidden = false;

  /// **Turning the phone is the switch** (v4 tiket 10, mockup C1): landscape on Terminal
  /// is immersed, portrait is not. Read from [MediaQuery], so it follows what the
  /// window actually is rather than a sensor — a phone locked upright never immerses.
  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final landscape = MediaQuery.orientationOf(context) == Orientation.landscape;
    if (landscape == _landscape) return;
    _landscape = landscape;
    _mode = _mode.immersed(landscape);
    _syncChrome();
  }

  /// Hides the status and navigation bars while the page in front is immersed. Sticky, so
  /// an edge swipe shows them over the terminal for a moment and they leave on their own.
  void _syncChrome() {
    final want = _inFront && _mode.immersive;
    if (want == _chromeHidden) return;
    _chromeHidden = want;
    unawaited(SystemChrome.setEnabledSystemUIMode(
        want ? SystemUiMode.immersiveSticky : SystemUiMode.edgeToEdge));
  }

  /// `⤡`: the header comes back and the phone stays turned. Turning it upright and back
  /// immerses again.
  void _leaveImmersive() {
    setState(() => _mode = _mode.immersed(false));
    _syncChrome();
  }

  @override
  void dispose() {
    _size.dispose();
    if (_chromeHidden) {
      unawaited(SystemChrome.setEnabledSystemUIMode(SystemUiMode.edgeToEdge));
    }
    super.dispose();
  }

  void _enterTerminal() => _show(AgentSurface.terminal);

  /// A line selected in Terminal goes to Chat's field,
  /// **unsent**, and the page goes with it. Terminal has no field of its own any more, so
  /// leaving the line where the operator cannot see it would be the same as dropping it.
  void _pick(String line) {
    prefill(_composer, line);
    _show(AgentSurface.chat);
  }

  /// `Ask <agent>` on a selection: quoted in Chat, and Chat shown — **unsent**, so the
  /// question is still the operator's to write (v4 tiket 07).
  void _ask(String text) {
    _hold(text);
    _show(AgentSurface.chat);
  }

  void _toggleLive() => setState(() => _mode = _mode.toggleLive);

  /// Terminal, with the quick answers it may offer (v4 tiket 06).
  ///
  /// Two sources, one proof each. A **permission** the host parsed comes first; a
  /// **question** comes from the flow, read against the screen exactly as Chat answers it
  /// ([questionPrompt]), because the host's parser names no prompt on a question screen —
  /// which is how the first build drew no chips at all on the device. Rebuilt with the
  /// conversation, since that is where the question arrives and where it is settled.
  Widget _terminal(AgentView? view) => ListenableBuilder(
        listenable: widget.live,
        builder: (context, _) {
          final turns = widget.live.turnsFor(widget.cell.ref);
          final permission = (view?.answerable ?? false) ? view?.permission?.prompt : null;
          final question = permission != null || view == null
              ? null
              : questionPrompt(turns, choicesFor(turns, view.permission));
          return TerminalSlot(
            cell: widget.cell,
            mode: _mode,
            repository: widget.repository,
            onPick: _pick,
            onAsk: _ask,
            onFinding: (open) => setState(() => _finding = open),
            onToggleLive: _toggleLive,
            onSessions: widget.onSessions,
            onGrid: _size.grid,
            immersive: _mode.immersive
                ? ImmersiveExits(onChat: () => _show(AgentSurface.chat), onExit: _leaveImmersive)
                : null,
            prompt: permission ?? question,
            onAnswer: question == null
                ? _answer
                // Settled first, as Chat does: the runner writes its own record only after
                // the keystroke lands, and the chips would otherwise stay up for a second tap.
                : (option) {
                    widget.live.settleQuestion(widget.cell.ref, option.label);
                    _answer(option);
                  },
          );
        },
      );

  /// Narrowest undo first: keys, immersion, Terminal. None of them stops the tail.
  void _back() {
    final to = _mode.back;
    if (to != null) setState(() => _mode = to);
    _syncChrome();
    _syncSize();
  }
}
