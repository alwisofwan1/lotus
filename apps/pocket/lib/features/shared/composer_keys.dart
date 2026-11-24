import 'package:flutter/services.dart';

/// How tall the field is allowed to get before it scrolls instead of growing.
///
/// Eight rather than the four it was: four was chosen when no key on the phone could
/// produce a newline, so the field only ever had to hold a wrapped sentence. Now that ⏎
/// writes a line, four turns a paragraph into a peephole.
///
/// Eight is where the *field* stops, not where the draft stops — past it the text scrolls
/// and the composer offers the whole screen (`DraftEditor`) instead of eating the
/// transcript. On a 390×844 phone with the keyboard up, eight lines plus the send row is
/// about as much as can stand above the keyboard without the reply being written blind.
const int kComposerMaxLines = 8;

/// What the phone's keyboard does in the composer.
///
/// The field holds a *message*, and a message has paragraphs: the return key has to write
/// a line, because a phone has no Shift+Enter to tell a line from a dispatch. Only the send
/// button commits.
///
/// It used to be [TextInputAction.send], and that is what the bug was: the IME draws a ➤
/// where the ⏎ goes, so on the phone **no key produced a newline at all** and a paragraph
/// could not be typed.
///
/// There was a second set, for a one-line terminal composer whose ⏎ was the payload. It
/// went with that composer in v4 tiket 04: typing into a PTY goes through the emulator
/// now, and nothing else.
class ComposerKeys {
  const ComposerKeys._({
    required this.maxLines,
    required this.keyboardType,
    required this.action,
  });

  /// A message: grows, and the return key writes a line.
  static const chat = ComposerKeys._(
    maxLines: kComposerMaxLines,
    keyboardType: TextInputType.multiline,
    action: TextInputAction.newline,
  );

  final int maxLines;
  final TextInputType keyboardType;
  final TextInputAction action;
}
