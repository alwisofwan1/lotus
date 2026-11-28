import 'package:flutter/material.dart';

import '../../app/theme/theme.dart';
import 'draft_editor.dart';
import 'tactile.dart';

/// Above how many lines an arriving block stops being a draft and becomes a thing the
/// operator brought with them.
///
/// Twelve, comfortably past [kComposerMaxLines], so a paragraph someone genuinely typed
/// or dictated is never taken away from them — only a block that could not have been
/// typed into a phone composer in one go.
const int kPasteHeldAt = 12;

/// What was inserted to turn [before] into [after], or null if this was not an insertion.
///
/// Compares the two ends and returns the middle. A *replacement* — the field's whole
/// contents swapped out — comes back as the new text with an empty `before`, which is the
/// right answer: pasting into an empty composer is the common case and it is still a
/// paste. What this rejects is a deletion, or a change that rewrote both ends, because
/// neither of those is something arriving from outside.
String? insertedBlock(String before, String after) {
  if (after.length <= before.length) return null;

  var head = 0;
  while (head < before.length && before[head] == after[head]) {
    head++;
  }
  var tail = 0;
  while (tail < before.length - head &&
      before[before.length - 1 - tail] == after[after.length - 1 - tail]) {
    tail++;
  }
  return after.substring(head, after.length - tail);
}

/// Whether an arriving block is big enough to be held rather than typed into.
bool worthHolding(String? inserted) =>
    inserted != null && draftLines(inserted) > kPasteHeldAt;

/// The message a held [block] and a typed [text] make together.
///
/// The block leads: the sentence is written *about* something the agent has not read yet,
/// so it arrives after the thing it is about.
String withHeld(String? block, String text) => switch ((block, text)) {
      (null, final t) => t,
      (final b?, '') => b,
      (final b?, final t) => '$b\n\n$t',
    };

/// Watches a field for a block arriving too big to have been typed into it, and takes it
/// back out.
///
/// It reads the *change*, not the field's contents, which is the difference between
/// catching a paste and punishing a long draft: eight lines typed one at a time never
/// trigger it, and twelve arriving in one edit always do. That covers the paths that
/// matter without knowing about any of them — a phone's clipboard bar, the selection
/// toolbar and a share target all reach the field the same way, as one large edit.
class PasteCatch {
  PasteCatch(this.field) : _was = field.text;

  final TextEditingController field;

  /// What the field said at the previous notification.
  String _was;

  /// True while this object is rewriting the field, so taking a paste out is not then
  /// read as another paste going in. The composer checks it before asking anything.
  bool get quiet => _quiet;
  bool _quiet = false;

  /// The block taken out of the field, kept until it is sent or dropped.
  String? get held => _held;
  String? _held;

  /// Takes anything that just arrived too big to have been typed, and answers whether
  /// [held] changed — the composer has nothing else to decide, so a bool is the whole
  /// report.
  bool take() {
    final now = field.text;
    final arrived = insertedBlock(_was, now);
    _was = now;
    if (!worthHolding(arrived)) return false;
    // Appended rather than replacing: two logs pasted in a row are two things the
    // operator meant to send, and dropping the first silently is the worse surprise.
    _held = _held == null ? arrived : '${_held!}\n\n$arrived';
    write(now.replaceFirst(arrived!, ''));
    return true;
  }

  /// Puts a block back, or clears it. Used on both sides of a dispatch: emptied when the
  /// words leave, restored whole when nothing took them.
  void hold(String? block) => _held = block;

  /// Replaces the field's contents, caret at the end, without that counting as a paste.
  void write(String text) {
    _quiet = true;
    field.value = TextEditingValue(
      text: text,
      selection: TextSelection.collapsed(offset: text.length),
    );
    _was = text;
    _quiet = false;
  }
}

/// A pasted block, held above the field until it is sent.
///
/// **The same grammar as `QuoteStrip`, deliberately**: a rule down the left, the words
/// behind it, one `✕` that drops the whole thing. The composer already teaches that shape
/// for the quote `Add to chat` picks up, and a second kind of held object should not need
/// a second vocabulary.
///
/// What differs is the label and the preview. A quote is a *pointer* at one sentence, so
/// it shows the sentence; a paste is a *payload* whose size is the thing worth knowing, so
/// it says how many lines it is and shows two of them in the typeface they arrived in.
class HeldPaste extends StatelessWidget {
  const HeldPaste({required this.text, required this.onDrop, super.key});

  final String text;

  /// Removes it. Never disabled, for the same reason the quote's `✕` never is: something
  /// you can attach and not detach is a trap.
  final VoidCallback onDrop;

  /// The first two lines, which is as much as a phone composer can spare.
  String get _preview => firstLines(text, 2);

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
            height: 40,
            margin: const EdgeInsets.only(top: 2),
            decoration: BoxDecoration(
              color: t.lineStrong,
              borderRadius: BorderRadius.circular(1),
            ),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  'Teks tertempel · ${draftLines(text)} baris',
                  style: t.ui.copyWith(fontSize: 12, color: t.muted),
                ),
                const SizedBox(height: 3),
                Text(
                  _preview,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                  // Mono, because whatever this is, it was not prose when it arrived.
                  style: t.mono.copyWith(fontSize: 10.5, height: 1.5, color: t.faint),
                ),
              ],
            ),
          ),
          Semantics(
            button: true,
            label: 'Drop paste',
            child: InkWell(
              onTap: () {
                Tactile.chose();
                onDrop();
              },
              borderRadius: context.shape.radius(ShapeRole.thumb),
              child: SizedBox(
                width: kMinHitTarget,
                height: kMinHitTarget,
                child: Center(
                  child: Text('✕',
                      style: t.ui.copyWith(fontSize: 13, height: 1, color: t.muted)),
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// The first [n] lines of [text], joined back together.
String firstLines(String text, int n) {
  final lines = text.split('\n');
  return lines.length <= n ? text : lines.take(n).join('\n');
}
