import '../../models/transcript.dart';

/// Every prompt the host is currently carrying — what [PendingDispatch.settledBy] is
/// asked about.
///
/// Built once per rebuild rather than per pending line: the ring holds sixty entries and
/// there are rarely more than one or two lines in flight, but rebuilding the set inside a
/// `where` is the kind of shape that stops being free the moment either number moves.
Set<String> promptsIn(List<TranscriptEntry> entries) =>
    {for (final entry in entries) entry.userPrompt};

/// Something the operator said that the transcript has not caught up with yet.
///
/// **Chat used to have no way to represent this at all**, and that was the gap: a
/// dispatch goes through the biometric gate and an HTTP round trip before `_load()`
/// asks the host for a transcript that only contains the prompt once a hook has fired
/// for it. Over a tailnet that is seconds of a screen where what you just typed is
/// nowhere — indistinguishable from having lost it.
///
/// Deliberately **not** an entry in [ChatTranscript]: that class maps what the host
/// said, and this is the one line on screen the host has not said yet. Keeping them
/// separate is what makes the hand-over checkable — [settledBy] is the whole rule.
class PendingDispatch {
  const PendingDispatch({required this.text, this.state = DispatchState.sending});

  /// Exactly what was sent, already trimmed. Compared verbatim against `userPrompt`
  /// when deciding whether the host has caught up.
  final String text;

  final DispatchState state;

  PendingDispatch get refused => PendingDispatch(text: text, state: DispatchState.failed);

  PendingDispatch get landed => PendingDispatch(text: text, state: DispatchState.accepted);

  /// Whether one of the host's own entries is now carrying this, so the real bubble
  /// can take over and this can be dropped.
  ///
  /// Matched on text rather than on time. Timestamps come from `Date.now()` in the hook
  /// script and the phone's clock is a different clock, so "newer than my dispatch" is a
  /// comparison across two unsynchronised sources — the same reason `LiveTranscript`
  /// keys entries by content instead of by timestamp.
  ///
  /// The cost of matching on text is named rather than hidden: a dispatch the agent
  /// never files a hook for stays on screen. That is the honest outcome — it *was*
  /// sent — and it beats the alternative, which is a line vanishing while the operator
  /// is still waiting to see whether it landed.
  bool settledBy(Iterable<String> prompts) =>
      state != DispatchState.failed && prompts.contains(text);
}

enum DispatchState {
  /// In flight. The one state that says so out loud.
  sending,

  /// The host took it, but no hook has carried it back yet.
  ///
  /// **Draws exactly like a real bubble — no marker at all**, and that is the point.
  /// The host accepting a dispatch is the moment it stops being a claim, so continuing
  /// to say `sending…` would be false; but the agent may not file a hook for seconds,
  /// or ever, so dropping the line would make what was said disappear. Between those
  /// two wrong answers there is a right one: show it as what it now is.
  accepted,

  /// The gate refused, or the host could not be reached. Carries its own retry, because
  /// a snackbar is gone before an operator who is walking has read it.
  failed,
}
