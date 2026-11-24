import 'package:flutter/widgets.dart';

import 'chat_transcript.dart';

/// Where Chat is looking, and the only three things allowed to move it.
///
/// Split out of `ChatView` when that file crossed the 300-line rule, and the cut is where it
/// is because the widget answers *what the conversation looks like* while everything here
/// answers *where in it the operator is standing* — a question with its own state, its own
/// failure modes, and no opinion about rows at all.
///
/// The three movers, and nothing else may:
///
/// * **[stickToBottom]** — new content pulls the view down, until the operator scrolls away.
/// * **[noteTranscript]** — a page of older history arrived above; put the reader back.
/// * the operator's own finger, which this never fights.
class ChatScroll {
  ChatScroll({required this.onStickChanged, required this.onReachedTop}) {
    controller.addListener(_onScroll);
  }

  final ScrollController controller = ScrollController();

  /// Called only when stickiness actually flips, so the widget sets state once per change.
  final void Function(bool stuck) onStickChanged;

  /// Called while the viewport is within [topSlack] of the start. Deliberately **not**
  /// debounced here: a scroll fires this many times and `TranscriptPager` already refuses a
  /// second request for a cell it is still fetching. Two guards would be two places to get
  /// the reset wrong.
  final VoidCallback onReachedTop;

  /// How close to an edge still counts as being at it.
  ///
  /// Not zero: a line arriving between the scroll notification and the frame that follows
  /// leaves a few pixels of slack, and demanding an exact match would drop stickiness at
  /// random.
  static const double topSlack = 48;
  static const double bottomSlack = 48;

  bool _stuck = true;
  bool _disposed = false;

  /// Whether new content should pull the view down with it.
  ///
  /// True until the operator scrolls up, and true again the moment they come back to the
  /// bottom. Without the release, reading something from earlier in the turn would be yanked
  /// away every time the agent ran another tool.
  bool get stuck => _stuck;

  /// Pins to the bottom and stays there until the operator scrolls away.
  void stick() {
    _setStuck(true);
    stickToBottom();
  }

  void dispose() {
    _disposed = true;
    controller.dispose();
  }

  /// Scrolls to the end after the frame that adds the new content.
  ///
  /// Post-frame, and **repeated**, because a `ListView` builds lazily: `maxScrollExtent` only
  /// describes the part that has been laid out, so the first jump lands on the bottom as it
  /// was *before* the new lines existed. Each jump extends the built range and the next frame
  /// reports a larger extent, so this converges in two or three passes. Measured: opening on
  /// an 80-step transcript stopped 23px short with a single pass.
  ///
  /// Bounded rather than looped until equal — a list that somehow kept growing would
  /// otherwise spin every frame forever, and being a few pixels off the end is a far smaller
  /// failure than a pinned main thread.
  void stickToBottom({int attempts = 4}) {
    if (!_stuck) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_disposed || !controller.hasClients || !_stuck) return;
      final end = controller.position.maxScrollExtent;
      if (controller.position.pixels >= end) return;
      controller.jumpTo(end);
      if (attempts > 1) stickToBottom(attempts: attempts - 1);
    });
  }

  /// Takes the transcript as it now is, and reports how many rows arrived **in front of**
  /// what was there before — keeping the operator's place when any did.
  ///
  /// A `ListView` measures its scroll from the top, so content inserted above the viewport
  /// moves everything below it down while `pixels` stays where it was. Measured 2026-09-08:
  /// one page put 3000px in front and the line under the operator's thumb went from
  /// `recent line 25` to `OLDER line 25` — mid-read, and again on the page after that,
  /// because the offset stayed inside the band that asks for more.
  ///
  /// The correction is `bb`'s, from `bottom-anchored-scroll-body.tsx`: remember the extent
  /// before the page lands, add the growth back after it has. Nothing here tries to be clever
  /// about *which* row to anchor to — the delta is the anchor. It is an estimate while the
  /// prepended rows are still unlaid-out, and an estimate off by a few pixels is a different
  /// order of wrong from being off by three thousand.
  ///
  /// **Only while the operator is reading history.** At the bottom [stickToBottom] already
  /// owns the position, and the two would fight over the same frame.
  int noteTranscript(ChatTranscript before, ChatTranscript now) {
    final prepended = prependedCount(before, now);
    if (prepended == 0 || _stuck || !controller.hasClients) return prepended;

    final extentBefore = controller.position.maxScrollExtent;
    final pixelsBefore = controller.position.pixels;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_disposed || !controller.hasClients) return;
      final position = controller.position;
      final added = position.maxScrollExtent - extentBefore;
      // Nothing measurable arrived, or the list shrank. Either way there is no correction to
      // make, and jumping on a guess is worse than the pixel or two it would have saved.
      if (added <= 0) return;
      final target =
          (pixelsBefore + added).clamp(position.minScrollExtent, position.maxScrollExtent);
      if ((target - position.pixels).abs() < 0.5) return;
      controller.jumpTo(target);
    });
    return prepended;
  }

  /// How many rows [now] gained in front of [before].
  ///
  /// Counted rather than inferred from the growth, because a page of history and a line of
  /// the agent's reply can land in the same frame: the list grew by 41 and only 40 of them
  /// are old. Found by locating the previous first row in the new list, and searched no
  /// further than the growth itself — beyond that the front did not simply gain rows, and the
  /// honest answer is zero.
  ///
  /// Compared by value, not identity: `ChatTranscript.ofTurns` rebuilds every item on every
  /// store notification, so identity would report "all different" on every frame.
  static int prependedCount(ChatTranscript before, ChatTranscript now) {
    if (before.items.isEmpty) return 0;
    final lead = _keyOf(before.items.first);
    final growth = now.items.length - before.items.length;
    if (growth <= 0) return 0;
    final limit = growth < now.items.length ? growth : now.items.length - 1;
    for (var i = 0; i <= limit; i++) {
      if (_keyOf(now.items[i]) == lead) return i;
    }
    return 0;
  }

  /// What makes two rendered lines the same line, for the comparison above only.
  ///
  /// Not an identity the rest of the app may rely on — [ChatItem] deliberately has none, and
  /// inventing one here would be inventing it everywhere. These are the three fields that
  /// cannot coincide across two different lines of one transcript.
  static String _keyOf(ChatItem item) =>
      '${item.kind}|${item.timestamp.microsecondsSinceEpoch}|${item.text}';

  void _onScroll() {
    if (_disposed || !controller.hasClients) return;
    final position = controller.position;
    // Near the top, not at it: a list that has to reach exactly zero never triggers on a
    // flick that decelerates a few pixels short.
    if (position.pixels <= topSlack) onReachedTop();
    _setStuck(position.pixels >= position.maxScrollExtent - bottomSlack);
  }

  void _setStuck(bool value) {
    if (value == _stuck) return;
    _stuck = value;
    onStickChanged(value);
  }
}
