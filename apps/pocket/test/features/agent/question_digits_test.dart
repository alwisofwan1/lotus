import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/agent/question_digits.dart';
import 'package:lotus_pocket/models/conversation.dart';

const asking = UserQuestion(
  question: 'Mau ngerjain apa sekarang?',
  header: 'Next task',
  options: [
    UserQuestionOption(label: 'Lanjut coding project ini', description: 'Kerjain fitur/bug'),
    UserQuestionOption(label: 'Kerjain ticket TKT-XXX'),
    UserQuestionOption(label: 'Cuma iseng test tool'),
  ],
);

/// Verbatim from the rendered screen of a live cell, 2026-09-09 — including the two options
/// the **terminal** adds that the tool never wrote, and the marker on the highlighted row.
const screen = '''
 □ Next task

Mau ngerjain apa sekarang?

❯ 1. Lanjut coding project ini
     Kerjain fitur/bug di codespace-demo
  2. Kerjain ticket TKT-XXX
     Buka/update ticket di orbit-vault
  3. Cuma iseng test tool
     Ga ada task serius, cuma nyoba
  4. Type something.
  5. Chat about this
Enter to select · ↑/↓ to navigate · Esc to cancel
''';

void main() {
  /// Probed against a live cell on 2026-09-09: a bare digit selects immediately on this list,
  /// with no Enter — the same keystroke the permission card has always sent. What was missing
  /// was knowing **which** digit, and it can only be read off the screen: the terminal adds
  /// options of its own (`4. Type something.`), so a digit derived from the card's own order
  /// would answer a different question than the one shown (ADR-8).
  test('reads each option own printed digit off the screen', () {
    expect(choicesFromScreen([asking], screen).digits, {
      'Lanjut coding project ini': '1',
      'Kerjain ticket TKT-XXX': '2',
      'Cuma iseng test tool': '3',
    });
  });

  test('reads a label the screen had to cut at the pane edge', () {
    const narrow = '''
Mau ngerjain apa sekarang?

❯ 1. Lanjut coding proj
  2. Kerjain ticket TKT
  3. Cuma iseng test to
''';
    expect(choicesFromScreen([asking], narrow).digits.length, 3);
    expect(choicesFromScreen([asking], narrow).digits['Kerjain ticket TKT-XXX'], '2');
  });

  /// **The two signals must agree.** A phone showed a card for one question while the terminal
  /// had moved on to another (2026-09-09). Answering that screen by the card's digits would
  /// have answered a question the operator never read.
  test('gives nothing when the screen is showing another question', () {
    const other = '''
Pertanyaan pilihan ganda soal apa?

❯ 1. Soal teknis
  2. Trivia umum
''';
    expect(choicesFromScreen([asking], other).isEmpty, isTrue);
  });

  test('gives nothing when an option cannot be found on the screen', () {
    const missing = '''
Mau ngerjain apa sekarang?

❯ 1. Lanjut coding project ini
  2. Kerjain ticket TKT-XXX
''';
    expect(choicesFromScreen([asking], missing).isEmpty, isTrue);
  });

  test('gives nothing when two options would answer with the same digit', () {
    const twice = '''
Mau ngerjain apa sekarang?

❯ 1. Lanjut coding project ini
  1. Kerjain ticket TKT-XXX
  3. Cuma iseng test tool
''';
    expect(choicesFromScreen([asking], twice).isEmpty, isTrue);
  });

  test('gives nothing at all when there is no screen to read', () {
    expect(choicesFromScreen([asking], null).isEmpty, isTrue);
    expect(choicesFromScreen([asking], '').isEmpty, isTrue);
  });

  /// More than one question at once cannot be answered by a single digit: the terminal asks
  /// them one after another, and this screen is only the first.
  test('gives nothing when more than one question was put at once', () {
    expect(
      choicesFromScreen(
        [asking, const UserQuestion(question: 'Lalu?', options: [UserQuestionOption(label: 'x')])],
        screen,
      ).isEmpty,
      isTrue,
    );
  });

  /// **The terminal's own choices are real choices.** Claude adds `Type something.` and
  /// `Chat about this` under every question it asks, and they are how the operator answers
  /// outside the list — the same escape `bb` gives as "Other" with a text box
  /// (`user-question-form-state.ts`). Leaving them off the phone left the operator with
  /// options the agent never offered them at the keyboard.
  test('carries the choices the terminal added, with their digits', () {
    final extras = choicesFromScreen([asking], screen).extras;

    expect(extras.map((o) => o.label), ['Type something.', 'Chat about this']);
    expect(extras.map((o) => o.key), ['4', '5']);
  });

  test('takes an extra only where it follows the options without a gap', () {
    const gapped = '''
Mau ngerjain apa sekarang?

❯ 1. Lanjut coding project ini
  2. Kerjain ticket TKT-XXX
  3. Cuma iseng test tool
  9. Something from elsewhere on the screen
''';
    expect(choicesFromScreen([asking], gapped).extras, isEmpty);
  });

  test('has no extras to carry when the screen could not be read at all', () {
    expect(choicesFromScreen([asking], null).extras, isEmpty);
  });
}
