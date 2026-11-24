import '../../models/conversation.dart';

/// The digit the **terminal** printed beside each of a question's options, read off the screen.
///
/// A cell with a terminal is answered by keystroke, and the probe on 2026-09-09 showed a bare
/// digit selects on this list immediately — the same key the permission card has always sent.
/// What could not be known was *which* digit, because the terminal writes options of its own
/// (`4. Type something.`, `5. Chat about this`) that the tool never asked for. A digit taken
/// from the card's own order would therefore answer a different option than the one the
/// operator tapped, which is the whole of ADR-8.
///
/// So both signals must agree, and this returns **nothing at all** unless they do:
///
/// * the screen is showing *this* question, not one the terminal has since moved on to —
///   a phone drew a card for a question the terminal had already replaced (2026-09-09);
/// * every option is on the screen, so no tap can fall through to a guess;
/// * no two options resolve to the same digit;
/// * there is exactly one question, because the terminal asks several one at a time and this
///   screen is only the first of them.
///
/// [ScreenChoices.none] means read-only, which is what the card draws when it cannot be
/// answered.
ScreenChoices choicesFromScreen(List<UserQuestion> questions, String? screen) {
  if (questions.length != 1 || screen == null || screen.isEmpty) return ScreenChoices.none;
  final asked = questions.single;
  final lines = screen.split('\n').map((l) => l.trimRight()).toList(growable: false);
  if (!screenShows(screen, asked.question)) return ScreenChoices.none;

  final printed = <String, String>{};
  for (final line in lines) {
    final match = _option.firstMatch(line);
    final digit = match?.group(1);
    final text = match?.group(2)?.trim();
    if (digit == null || text == null || text.isEmpty) continue;
    printed.putIfAbsent(text, () => digit);
  }

  final digits = <String, String>{};
  for (final option in asked.options) {
    final line = printed.entries.where((e) => _says(e.key, option.label)).toList(growable: false);
    if (line.length != 1) return ScreenChoices.none;
    if (digits.values.contains(line.single.value)) return ScreenChoices.none;
    digits[option.label] = line.single.value;
  }
  return ScreenChoices(digits: digits, extras: _extras(printed, digits));
}

/// The choices the **terminal** added under the agent's own — `Type something.`,
/// `Chat about this`.
///
/// They are real choices, and the operator at the keyboard has them: they are how a question
/// is answered outside the list. `bb` gives the same escape as an "Other" option with a text
/// box (`user-question-form-state.ts`); here the terminal writes it, so it is read rather than
/// invented — label verbatim, digit as printed.
///
/// Taken only where they **follow the agent's options without a gap**, so a numbered line from
/// somewhere else on the screen cannot become a button.
List<UserQuestionOption> _extras(Map<String, String> printed, Map<String, String> digits) {
  final taken = digits.values.map(int.tryParse).whereType<int>().toList(growable: false);
  if (taken.isEmpty) return const [];
  final byDigit = {
    for (final entry in printed.entries)
      if (int.tryParse(entry.value) != null) int.parse(entry.value): entry.key,
  };
  final extras = <UserQuestionOption>[];
  var next = taken.reduce((a, b) => a > b ? a : b) + 1;
  for (var label = byDigit[next]; label != null; label = byDigit[next]) {
    extras.add(UserQuestionOption(label: label, key: '$next'));
    next++;
  }
  return extras;
}

/// What a screen offers: the agent's own options with the digit each was printed under, and
/// the terminal's own choices beside them.
class ScreenChoices {
  const ScreenChoices({required this.digits, required this.extras});

  static const none = ScreenChoices(digits: {}, extras: []);

  /// Digit by option label, for the options the agent itself wrote.
  final Map<String, String> digits;

  /// The terminal's own choices, in the order it printed them.
  final List<UserQuestionOption> extras;

  /// Nothing here can be answered — the two signals did not agree.
  bool get isEmpty => digits.isEmpty;
}

/// Whether the screen has [text] on a line of its own — allowing for the pane edge having cut
/// it short. What it answers is "is the terminal still showing this", which is how the phone
/// tells a prompt it has already named from one it has not.
bool screenShows(String? screen, String text) =>
    screen != null &&
    screen.split('\n').any((line) => _says(line.trim(), text));

/// `❯ 1. Label`, or `  2. Label` — the marker on the highlighted row is part of the screen,
/// not part of the label.
final _option = RegExp(r'^\s*[>❯›]?\s*(\d+)\.\s+(.+)$');

/// Whether a line of screen is [text] — allowing for the pane edge having cut it short.
///
/// A prefix only counts from six characters, so a narrow pane cannot make two different
/// options look like the same one.
bool _says(String line, String text) =>
    line == text || (line.length >= 6 && text.startsWith(line));
