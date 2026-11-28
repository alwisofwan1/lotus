import 'package:flutter/material.dart';

import '../../../data/agent_repository.dart';
import '../../../data/dictation.dart';
import '../../../models/cell.dart';
import '../../shared/composer.dart';
import '../../shared/mutation_notice.dart';
import 'quote_strip.dart';
import 'composer_context.dart';
import '../page_mode.dart';
import 'view_switch.dart';

/// Puts a chosen line in the field, caret at the end, **unsent**.
///
/// Lives beside the composer rather than in the page because it is a fact about this
/// strip: the palette hands over text, and the operator still reads it and still presses
/// send. A palette that executed would be a wrong machine away from a bad afternoon.
void prefill(TextEditingController field, String line) {
  field.text = line;
  field.selection = TextSelection.collapsed(offset: line.length);
}

/// Sends one key press to the pane's PTY, and says so only when it did not land.
///
/// Beside [prefill] because it is the same concern from the other end: what the operator
/// is saying, and where it goes. Not the page's `_send` — that one echoes a bubble into
/// Chat and lets the host append a submit key, and a keystroke is neither a sentence nor
/// something to remember.
Future<void> sendKeys(
  BuildContext context, {
  required AgentRepository repository,
  required Cell cell,
  required String data,
}) async {
  final outcome =
      await repository.sendInput(cell.ref, data, reason: 'Type into ${cell.title}');
  if (!context.mounted || outcome.succeeded) return;
  final notice = noticeFor(outcome, agent: cell.title);
  if (notice == null) return;
  // Replaces rather than queues. One notice per keystroke would stack a wall of
  // identical snackbars over the terminal the operator is trying to read, and the
  // second one tells them nothing the first did not.
  ScaffoldMessenger.maybeOf(context)
    ?..removeCurrentSnackBar()
    ..showSnackBar(SnackBar(content: Text(notice)));
}

/// Everything the operator can say right now, as one strip at the foot of the page.
///
/// Chat's alone since v4 tiket 06: the quick answers that rode here under Terminal now
/// live inside it, above the dock, so this strip is the composer or nothing.
///
/// **No composer under Terminal** (v4 tiket 04). It used to stay as a one-line field whose
/// ⏎ went through `/dispatch`, beside keys that went through `/input` — two ways to type
/// into one PTY, each ignoring the other. Typing to the session is now the dock's job, and
/// a long prompt is written in Chat, one tap away.
///
/// Pulled out when `agent_page.dart` reached the 300-line ceiling — which is the file
/// telling you it is hiding a collaborator, and this was the collaborator.
class AgentInput extends StatelessWidget {
  const AgentInput({
    required this.cell,
    required this.repository,
    required this.controller,
    this.focusNode,
    required this.sending,
    required this.terminalShown,
    required this.terminalLive,
    required this.answerable,
    required this.onSend,
    this.dictation,
    this.quote,
    this.onDropQuote,
    this.placeholder,
    this.onShow,
    super.key,
  });

  /// What the empty field says for the agent's state; null leaves it to the mood.
  final String? placeholder;

  /// Chat | Terminal, kept by the thumb. Null draws no switch (a Chat-only cell).
  final ValueChanged<AgentSurface>? onShow;

  final Cell cell;
  final AgentRepository repository;

  /// Owned by the page rather than by the composer, so a snippet chosen in the terminal
  /// has somewhere to land. See [Composer.controller].
  final TextEditingController controller;

  /// So a question's `Type something.` can put the keyboard where the terminal put its cursor.
  final FocusNode? focusNode;

  final bool sending;
  final bool terminalShown;

  /// Whether the terminal is taking keys. When it is, this strip **must not** offer a
  /// text field: two fields cannot share one keyboard, and the one that wins is whichever
  /// was tapped last — which is how a command meant for a shell ends up in a composer.
  final bool terminalLive;

  final bool answerable;

  final Dictation? dictation;

  /// What `Add to chat` is holding for this reply, or null when nothing is. The markers
  /// are added at dispatch (`withQuote`), so this is the agent's own words, unmarked.
  final String? quote;

  /// Drops it. Required alongside [quote] in practice — a strip with no way out is the
  /// one shape this must never be.
  final VoidCallback? onDropQuote;

  final Future<bool> Function(String text) onSend;

  @override
  Widget build(BuildContext context) {
    // **Nothing at all under Terminal.** Typing there is the dock's job (tiket 04), and
    // the quick answers moved inside it, above the dock (tiket 06).
    if (terminalShown || terminalLive) return const SizedBox.shrink();

    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (onShow != null)
          Padding(
            padding: const EdgeInsets.only(left: 12, top: 4),
            child: Align(
              alignment: Alignment.centerLeft,
              child: ViewSwitch(shown: AgentSurface.chat, onShow: onShow!),
            ),
          ),
        Composer(
          mood: answerable ? ComposerMood.asking : ComposerMood.working,
          agent: cell.title,
          placeholder: answerable ? null : placeholder,
          enabled: !sending,
          controller: controller,
          focusNode: focusNode,
          // Both halves or neither: a microphone with nowhere to send the audio is a
          // button that can only disappoint. `canDictateOn` reads the host's live
          // capabilities, so a desktop that gains a provider gets its mic without a
          // re-pair — and a Standalone Host never shows one.
          dictation: repository.canDictateOn(cell.host) ? dictation : null,
          dictateOn: cell.host,
          above: switch ((quote, onDropQuote)) {
            (final String held, final VoidCallback drop) =>
              QuoteStrip(text: held, onDrop: drop),
            _ => null,
          },
          about: ComposerContext(cell: cell),
          onSend: (text) => onSend(text),
        ),
      ],
    );
  }
}
