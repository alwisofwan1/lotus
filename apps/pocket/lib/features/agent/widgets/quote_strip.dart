import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../shared/tactile.dart';

/// What `Add to chat` picked up, held above the field until it is sent.
///
/// **It is a held object, not text typed into the field**, and that is the correction to
/// the first version of this feature. Quoting used to paste `> …` straight into the
/// composer, which read badly for two reasons an operator meets immediately: the `>`
/// markers are for the agent to parse, not for a person to re-read on a phone, and a
/// quote sitting *inside* the field is something the caret walks through and the
/// backspace key eats one character at a time.
///
/// Here the quote is one thing with one control — a rule down its left, the agent's own
/// words behind it, and a `✕` that drops it whole. What the agent receives is unchanged:
/// the markers are added back at send (`quoteBlock`), so the reply still arrives marked
/// as a response to something it said.
///
/// Two lines at most. A quote is a *pointer* at the sentence being answered, and a phone
/// composer that grows to six lines of context has pushed the keyboard over the answer.
class QuoteStrip extends StatelessWidget {
  const QuoteStrip({required this.text, required this.onDrop, super.key});

  final String text;

  /// Removes the quote. Never disabled: something you can attach and not detach is a
  /// trap, and the operator is one keystroke from needing the room.
  final VoidCallback onDrop;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Padding(
      // No horizontal inset of its own: the composer's box supplies it, so the rule
      // starts exactly where the first character of the draft below does. It used to
      // carry 11/5 to compensate for a pill whose padding changed with its leading
      // control — that pill is gone (2026-09-17).
      padding: const EdgeInsets.only(bottom: 10),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 2,
            // Sized against the two lines it fences rather than stretched: a rule that
            // fills the row would grow with the dismiss target and stop matching the words.
            height: 34,
            margin: const EdgeInsets.only(top: 2),
            decoration: BoxDecoration(
              color: t.lineStrong,
              borderRadius: BorderRadius.circular(1),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Padding(
              padding: const EdgeInsets.only(top: 1),
              child: Text(
                quotePreview(text),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                // Serif, because it is still the agent talking — the same letterform the
                // transcript spent a whole typeface on. Muted, because it is context for
                // the sentence being written rather than the sentence itself.
                style: t.serif.copyWith(fontSize: 12.5, height: 1.45, color: t.muted),
              ),
            ),
          ),
          Semantics(
            button: true,
            label: 'Drop quote',
            child: InkWell(
              onTap: () {
                Tactile.chose();
                onDrop();
              },
              borderRadius: BorderRadius.circular(9),
              child: SizedBox(
                width: kMinHitTarget,
                height: kMinHitTarget,
                child: Center(
                  child: Text(
                    '✕',
                    style: t.mono.copyWith(fontSize: 12, color: t.muted),
                  ),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The quote as a person reads it, with the markup taken off.
///
/// **Found by looking at the emulator on 2026-09-17**: quoting a reply that opened with
/// a heading put `## Ringkasan encoder` in the composer. The strip holds the agent's
/// *words*, and `##`, `**` and backticks are instructions to a renderer — the exact
/// defect `AgentProse` was built to end, reappearing one widget later.
///
/// Everything collapses to one flowing run, because two lines of a heading followed by
/// a blank line is a layout, and this is a pointer at a sentence.
String quotePreview(String text) {
  var line = text.trim();

  // Fences first: their content is kept, their ``` rows are not a sentence.
  line = line.replaceAll(RegExp(r'^[ \t]*```.*$', multiLine: true), ' ');
  line = line.replaceAll(RegExp(r'^[ \t]{0,3}(#{1,6}|>)[ \t]+', multiLine: true), '');
  line = line.replaceAll(RegExp(r'^[ \t]{0,3}(?:[-*+]|\d+\.)[ \t]+', multiLine: true), '');
  // `[label](url)` keeps its label, and an image keeps nothing worth reading.
  line = line.replaceAll(RegExp(r'!\[[^\]]*\]\([^)]*\)'), '');
  line = line.replaceAllMapped(
      RegExp(r'\[([^\]]*)\]\([^)]*\)'), (m) => m.group(1) ?? '');
  line = line.replaceAll(RegExp(r'(\*\*|~~|__|`)'), '');
  // Emphasis last, so `**bold**` has already lost its pair and a lone `*` is a marker.
  line = line.replaceAll(RegExp(r'(?<!\w)\*(?!\s)|(?<!\s)\*(?!\w)'), '');

  return line.replaceAll(RegExp(r'\s+'), ' ').trim();
}

/// The markers the agent reads, added at the last moment.
///
/// Kept apart from [QuoteStrip] so the screen can show words and the wire can carry
/// markup, and so this rule stays a pure function the tests can hold still.
String quoteBlock(String text) =>
    text.trim().split('\n').map((line) => '> ${line.trimRight()}').join('\n');

/// A reply with its quote in front of it, or the reply alone when nothing is held.
String withQuote(String? quote, String reply) =>
    quote == null || quote.trim().isEmpty ? reply : '${quoteBlock(quote)}\n\n$reply';
