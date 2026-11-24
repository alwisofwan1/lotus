part of 'agent_page.dart';

/// What the operator says, and what happens to the words afterwards.
///
/// Split out of `agent_page.dart` when that file crossed the 300-line rule, and the cut is
/// where it is because these three answer *what becomes of what was said* — a digit, a
/// sentence, or a sentence being said again — while everything left behind answers what the
/// page is doing: loading, polling, holding a sheet open.
///
/// A `part` rather than a helper class, following `agent_page_terminal_sheet.dart`: all three
/// need `setState`, `_pending` and `_mutations`, and threading those through a constructor
/// would buy separation the page does not want and pay for it in indirection.

mixin _Speech on State<AgentPage> {
  /// True while a send is in flight, so one tap cannot become two dispatches.
  bool _sending = false;

  /// What the operator said that the host has not echoed back yet.
  final List<PendingDispatch> _pending = [];

  final TypingHandover _typing = TypingHandover();

  /// What `Add to chat` picked out of the transcript, held beside the draft rather than
  /// pasted into it. Cleared when it is sent, or when the operator drops it.
  String? _quote;

  /// Takes a quote and asks for the keyboard: quoting is the first half of a sentence,
  /// so the caret should already be waiting for the second.
  void _hold(String text) {
    setState(() => _quote = text);
    _typing.expect();
  }

  late final AgentMutations _mutations = AgentMutations(widget.repository);

  /// Re-reads the cell. Left to the page: a send changes what a read would return, and the
  /// page is what owns the view a read fills in.
  Future<void> _load();

  /// Sends text, or a permission answer — the same call, because an answer *is* a
  /// dispatch of the printed digit (ADR-8). [echo] tells them apart on screen: a typed
  /// sentence appears as the operator's own bubble, a digit does not.
  ///
  /// **Returns whether the text is now accounted for on screen** — what the composer needs
  /// to choose between clearing the field and handing the words back. Yes whenever an echo
  /// line was made, even a refused one (it keeps its own retry); no for a permission digit,
  /// or a send already in flight. A key press, not a sentence — `AgentMutations.answer`.
  Future<void> _answer(PromptOption option) async {
    if (_sending) return;
    setState(() => _sending = true);
    final landed = await _mutations.answer(context, widget.cell, option);
    if (!mounted) return;
    setState(() => _sending = false);
    if (landed) {
      _typing.landed();
      await _load();
    }
  }

  /// A sentence for the agent — an answer to a prompt is [_answer], not this.
  ///
  /// The held quote is folded in **here**, at the last moment, so one string is what the
  /// host receives, what the operator's own bubble shows, and what a retry re-sends.
  /// Anything else and the three could disagree about what was said.
  Future<bool> _send(String reply) async {
    if (_sending) return false;

    final text = withQuote(_quote, reply);
    final pending = PendingDispatch(text: text);
    setState(() {
      _sending = true;
      _quote = null;
      _pending.add(pending);
    });

    // Reason string, notice and haptic live in `AgentMutations`.
    final landed = await _mutations.dispatch(context, widget.cell, text);

    if (!mounted) return true;
    setState(() {
      _sending = false;
      // A refusal stays on the line it belongs to, carrying its own retry — the notice
      // names the cause, but it is gone in four seconds and this is not. A landed one
      // stops claiming anything and waits for the host's own entry to replace it.
      final at = _pending.indexOf(pending);
      if (at >= 0) _pending[at] = landed ? pending.landed : pending.refused;
    });

    // Only a landed dispatch changes the transcript — or is worth offering back later.
    if (landed) {
      unawaited(widget.snippets.remember(widget.cell.host, text));
      await _load();
    }
    return true;
  }

  void _retry(PendingDispatch dispatch) {
    if (_sending) return;
    setState(() => _pending.remove(dispatch));
    unawaited(_send(dispatch.text));
  }
}
