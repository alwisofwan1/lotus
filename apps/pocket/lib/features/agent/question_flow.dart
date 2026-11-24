import 'package:flutter/widgets.dart';

import '../../models/conversation.dart';
import '../../models/permission.dart';
import 'question_digits.dart';

/// What a cell is asking right now, and how — if at all — it can be answered from here.
///
/// Split out of `ChatBody` when that file crossed the 300-line rule, and the seam is a real
/// one: these five answer *what the operator is being asked*, where everything left there
/// answers *what to draw*. They are pure functions over the turns on screen and the cell's
/// own prompt, so each is tested without a widget.

/// Answers the open question in the flow, or **null** when this cell cannot be answered
/// from here.
///
/// Null is the honest state for a cell with a terminal: the digits there belong to the
/// screen, and none reaches this app (ADR-8). The label goes back with the digit so whatever
/// reads the answer says the words the agent wrote rather than a number.
void Function(String key)? answerer(
  List<Turn> turns,
  void Function(PromptOption option) onAnswer, {
  ScreenChoices choices = ScreenChoices.none,
  VoidCallback? onHandover,
}) {
  final offered = [
    for (final q in _open(turns)?.questions ?? const <UserQuestion>[]) ...q.options,
    // The terminal's own choices answer the same question, by the same keystroke.
    ...choices.extras,
  ].where((o) => (o.key ?? choices.digits[o.label]) != null).toList(growable: false);
  if (offered.isEmpty) return null;
  return (key) {
    final option = offered.where((o) => (o.key ?? choices.digits[o.label]) == key).firstOrNull;
    if (option == null) return;
    onAnswer(PromptOption(key: key, label: option.label, selected: false));
    // The terminal's own choices do not answer the question — they end it and put the
    // cursor in the prompt. Probed on two live cells 2026-09-10: `Type something.` reports
    // the question declined, `Chat about this` asks what needs clarifying. Both expect the
    // next thing to be typed, so the keyboard goes where the terminal put its cursor.
    if (choices.extras.contains(option)) onHandover?.call();
  };
}

/// The open question as Terminal's quick answers (v4 tiket 06), or **null** when its digits
/// are not all proven.
///
/// Needed because the host's permission parser names no prompt on a question screen: the
/// options carry description rows, and the terminal's own `Chat about this` sits under a rule
/// (device, 2026-10-04). Chat answers those through [answerer]; this is the same proof, shaped
/// as the chips' [PermissionPrompt].
///
/// Stricter than [answerer] on purpose. A row of chips reads as *all the answers*, so one
/// option without a digit drops the whole row rather than leaving a gap; and a multi-question
/// form is left to Chat, which shows which question a digit belongs to. The terminal's own
/// choices are not chips — they hand over to typing, which is `Type to session`'s job here.
PermissionPrompt? questionPrompt(List<Turn> turns, ScreenChoices choices) {
  final questions = _open(turns)?.questions ?? const <UserQuestion>[];
  if (questions.length != 1) return null;
  final asked = questions.single;
  final options = [
    for (final o in asked.options)
      if (o.key ?? choices.digits[o.label] case final key?)
        PromptOption(key: key, label: o.label, selected: false),
  ];
  if (options.isEmpty || options.length != asked.options.length) return null;
  return PermissionPrompt(question: asked.question, options: options, ask: 'question');
}

/// What the screen offers for the open question: a digit for each of the agent's options,
/// and the terminal's own choices beside them.
///
/// Read from the screen the host already sends for **reading** (`PermissionSnapshot.tail`),
/// and only while that cell is actually waiting — a screen left over from a question the
/// terminal has moved on from would answer something nobody was shown. The rule that both
/// signals must agree lives in `question_digits.dart`; this is where the two meet.
ScreenChoices choicesFor(List<Turn> turns, PermissionSnapshot? permission) {
  final open = _open(turns);
  if (open == null || permission == null || !permission.awaiting) return ScreenChoices.none;
  return choicesFromScreen(open.questions, permission.tail);
}

QuestionPart? _open(List<Turn> turns) => turns
    .expand((t) => t.parts)
    .whereType<QuestionPart>()
    .where((p) => p.isOpen)
    .lastOrNull;

/// Whether the terminal is still showing the question the flow has already named.
///
/// Answering `Type something.` opens a text field **inside the same prompt**, so the cell
/// stays awaiting — and a flow that had just settled its question stopped suppressing the
/// "options could not be named" card, which slid in under the keyboard (2026-09-10). While
/// the screen still shows what the flow named, a tail card adds nothing.
bool namedOnScreen(List<Turn> turns, PermissionSnapshot? permission) {
  if (permission == null || !permission.awaiting) return false;
  final asked = turns
      .expand((t) => t.parts)
      .whereType<QuestionPart>()
      .lastOrNull
      ?.questions
      .firstOrNull;
  return asked != null && screenShows(permission.tail, asked.question);
}

/// Whether the flow is holding a question nobody has answered yet.
///
/// Read from the turns on screen rather than from `/permission`, because the flow is what
/// draws the card and the runner's own record is what settles it — Esc at the desktop closes
/// the question here, and the foot may speak again on the very next frame.
bool asking(List<Turn> turns) => turns.any(
      (t) => t.parts.any((p) => p is QuestionPart && p.isOpen),
    );

/// The keyboard, after an answer that hands the turn back to typing.
///
/// Two rules live here because both were learned the hard way. It is **asked for after the
/// answer lands**: the composer is disabled while a send is in flight, and a disabled field
/// cannot hold focus, so the keyboard opened and closed again on a device (2026-09-10). And
/// the expectation is **spent** when it is met, so the next answer — which may be an ordinary
/// option — does not inherit it.
class TypingHandover {
  final FocusNode node = FocusNode(debugLabel: 'composer');
  bool _expected = false;

  /// The answer now in flight ends the question and expects typing next.
  void expect() => _expected = true;

  /// That answer has landed. Answers whether the keyboard was asked for — a detached node
  /// cannot report its own focus, so this is what a test can hold on to.
  bool landed() {
    if (!_expected) return false;
    _expected = false;
    node.requestFocus();
    return true;
  }

  void dispose() => node.dispose();
}
