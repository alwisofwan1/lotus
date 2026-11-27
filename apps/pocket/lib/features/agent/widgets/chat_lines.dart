import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../chat_transcript.dart';
import '../pending_dispatch.dart';
import 'prose_selection.dart';
import 'line_details.dart';

/// Your message, on your side.
///
/// **Right-aligned as of 2026-08-08, and that reverses a locked rule.** `MVP.md` banned
/// alternating sides as a chat cliché and marked authorship by fill alone. On a device
/// that failed: the agent's prose starts at the left margin and a left-inset bubble
/// reads as *more of the same voice*, so six replies and one question rendered as one
/// document. Side is the fastest authorship signal a phone has, and the operator asked
/// for the idiom every chat app uses. The rest of the ban holds — no avatars, no bubble
/// for the agent.
///
/// **It hugs what you said.** Until 2026-08-08 it stretched the full width of the list,
/// so `Hi` drew a bubble the width of the screen with two characters floating at its
/// left edge — seen on a real phone, and the single thing that made this screen read as
/// broken rather than quiet. A bubble is a shape drawn *around* a sentence; a bubble
/// that ignores the sentence is a panel. Capped short of the right edge so a long one
/// still reads as one side of a conversation rather than as the page.
class MineBubble extends StatelessWidget {
  const MineBubble({required this.text, this.at, this.state, this.onRetry, super.key});

  final String text;

  /// When the host says it happened. Null while this is still only the phone's claim,
  /// which is also why a pending bubble offers no timestamp to long-press for.
  final DateTime? at;

  final DispatchState? state;
  final VoidCallback? onRetry;

  bool get _failed => state == DispatchState.failed;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final at = this.at;

    return GestureDetector(
      onTap: _failed ? onRetry : null,
      onLongPress: at == null ? null : () => showLineDetails(context, text: text, at: at),
      child: Opacity(
        // Dimmed rather than marked with a spinner: the sentence is legible, and the
        // fact that it has not landed yet is a property of the whole line.
        opacity: state == DispatchState.sending ? 0.55 : 1,
        child: Padding(
          padding: const EdgeInsets.only(top: 6, bottom: 22),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.end,
            children: [
              // Loose by default, so the bubble takes its own width and is only
              // clamped by what is left. The gutter is what stops it reaching the
              // far edge — no `LayoutBuilder`, and it holds at any width.
              const SizedBox(width: 48),
              Flexible(
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 15, vertical: 11),
                  decoration: BoxDecoration(
                    // One step further off the floor than a row: this is the only
                    // thing on the screen that is a *container*, so it has to survive
                    // being read at arm's length.
                    color: Color.alphaBlend(t.raise, Color.alphaBlend(t.raise, t.bg)),
                    borderRadius: const BorderRadius.only(
                      topLeft: Radius.circular(17),
                      topRight: Radius.circular(17),
                      bottomLeft: Radius.circular(17),
                      bottomRight: Radius.circular(5),
                    ),
                  ),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(text, style: t.ui.copyWith(fontSize: 13, height: 1.45, color: t.text)),
                      // `accepted` deliberately draws nothing: the host has it, so there
                      // is no longer anything to report about it.
                      if (state == DispatchState.sending || _failed) _meta(t),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  /// The send state, on the line it belongs to.
  ///
  /// **Not a snackbar**, which is the shape this replaces: a snackbar reports a failure
  /// somewhere else on the screen, times out, and leaves nothing behind — so an operator
  /// who was walking learns nothing was sent only by noticing that nothing happened. Red
  /// is allowed here because a dispatch that did not leave the device is a failure, which
  /// is the one thing red means.
  Widget _meta(AppTokens t) => Padding(
        padding: const EdgeInsets.only(top: 6),
        child: Text(
          _failed ? 'not sent · tap to retry' : 'sending…',
          style: t.mono.copyWith(
            fontSize: 11,
            letterSpacing: 0.06 * 11,
            color: _failed ? t.error : t.muted,
          ),
        ),
      );
}

/// What it said, in serif. The typeface is the whole signal.
///
/// **The long press that used to open a sheet here is gone, and it had to be.** Measured
/// 2026-09-16 by mounting this widget inside a `SelectionArea` and pressing and holding:
/// the sheet opened and **no selection toolbar appeared at all** — the nearer recognizer
/// wins the gesture arena, so wrapping the transcript in selection would have shipped a
/// feature that silently never starts. A phone has one idiom for "act on this text", and
/// selecting it is the one every other app already taught.
///
/// What the sheet carried is not lost, it is moved into the open: the timestamp now sits
/// in the label row where it costs no gesture, and copy became the selection menu's own
/// `Copy` plus the row under the message.
class ProseLine extends StatelessWidget {
  const ProseLine({
    required this.item,
    required this.agent,
    this.onQuote,
    super.key,
  });

  final ChatItem item;

  /// Who is speaking. Drawn once above the words rather than as an avatar beside them:
  /// six unlabelled replies in a column read as one essay, which is exactly what a
  /// device showed. `MVP.md` bans avatars and this keeps that.
  final String agent;

  /// Quotes text into the composer, **unsent**. Null on a surface with no composer to
  /// quote into, and the affordance is then not drawn rather than drawn and inert.
  final void Function(String text)? onQuote;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Padding(
      padding: const EdgeInsets.only(top: 6, bottom: 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 7),
            child: Row(
              children: [
                Text('∗', style: t.ui.copyWith(fontSize: 11, height: 1, color: t.muted)),
                const SizedBox(width: 7),
                Text(
                  agent.toUpperCase(),
                  style: t.mono.copyWith(
                    fontSize: 11,
                    letterSpacing: 0.16 * 11,
                    color: t.muted,
                  ),
                ),
                const SizedBox(width: 9),
                // Was reachable only by holding the line down, and drawn nowhere. On a
                // ring that spans a night, "an hour ago" and "yesterday" decide whether
                // to act; `DayMark` answers the second and this answers the first.
                Text(
                  clockLabel(item.timestamp),
                  style: t.mono.copyWith(fontSize: 11, color: t.faint),
                ),
              ],
            ),
          ),
          SelectableProse(item: item, onQuote: onQuote),
          if (item.truncated) _cutOff(t),
          ProseActions(text: item.text, onQuote: onQuote),
        ],
      ),
    );
  }

  /// Says the message stops here because the host cut it, not because the agent
  /// finished. Mono under serif prose is this screen's grammar for "the app talking".
  Widget _cutOff(AppTokens t) => Padding(
        padding: const EdgeInsets.only(top: 8),
        child: Text(
          'message cut short by the host — raw terminal has the rest',
          style: t.mono.copyWith(fontSize: 11.5, height: 1.5, color: t.muted),
        ),
      );
}
