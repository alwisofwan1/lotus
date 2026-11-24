import 'conversation.dart';

/// One answer a permission prompt is offering, read from the terminal.
class PromptOption {
  const PromptOption({required this.key, required this.label, required this.selected});

  /// The digit **as printed** next to the label. Never derived from position: a
  /// prompt whose first option scrolled away starts at `2`, and "the first button"
  /// sending `1` would answer a different question than the one shown.
  final String key;

  /// The option's own words. Rendered verbatim — the mockup for this screen once
  /// invented a label ("No, and tell Claude what to do differently") that the real
  /// prompt does not use, which is why nothing here is paraphrased.
  final String label;

  /// Where the prompt's cursor rests right now.
  final bool selected;

  factory PromptOption.fromJson(Map<String, Object?> json) => PromptOption(
        key: json['key']! as String,
        label: json['label']! as String,
        selected: json['selected']! as bool,
      );
}

class PermissionPrompt {
  const PermissionPrompt({required this.question, required this.options, this.ask});

  final String question;
  final List<PromptOption> options;

  /// `question` when the agent is asking the operator to **choose**, rather than for leave to
  /// act. Absent means a permission — which is what this app read everything as before the
  /// field existed, and the safe way round: a question drawn as a permission is mislabelled,
  /// where a permission drawn as a question is a destructive action wearing a softer word.
  final String? ask;

  bool get isQuestion => ask == 'question';

  factory PermissionPrompt.fromJson(Map<String, Object?> json) => PermissionPrompt(
        question: json['question']! as String,
        ask: json['ask'] as String?,
        options: (json['options']! as List<Object?>)
            .map((e) => PromptOption.fromJson(e! as Map<String, Object?>))
            .toList(growable: false),
      );
}

/// `GET /m/cell/:paneId/permission` — what the cell is asking, and what it accepts.
///
/// Two independent signals must agree before a button may be drawn: the hook says
/// the cell is waiting, and the terminal says which options exist. Either alone is
/// unsafe — the hook does not know the digits, and a parse alone could place buttons
/// on a prompt that was already answered.
class PermissionSnapshot {
  const PermissionSnapshot({
    required this.paneId,
    required this.awaiting,
    required this.hostSupports,
    this.prompt,
    this.question,
    this.readback,
    this.tail,
  });

  final String paneId;

  /// The hook's verdict. `true` with a null [prompt] means "waiting, but the
  /// options could not be read" — render a pointer to the raw terminal, not an
  /// empty state and not a guessed pair of buttons.
  final bool awaiting;

  /// False when this host cannot tell whether a cell is waiting at all (a VPS).
  /// `awaiting: false` then means *not knowable*, not *not waiting*.
  final bool hostSupports;

  final PermissionPrompt? prompt;

  /// What the agent is asking, whole — every option with its own sentence and, where the cell
  /// can be answered from here, its printed digit. Absent on a permission, and on a host too
  /// old to send it; [prompt] then carries the labels alone, as it always did.
  final List<UserQuestion>? question;

  /// The prompt as one spoken sentence, built from its own words. Absent whenever
  /// [prompt] is, so there is never a sentence about the absence of a question.
  /// Spoken with the device's TTS — no API key involved (ADR-11).
  final String? readback;

  /// What the terminal drew, when [awaiting] is true and the options could **not** be named.
  ///
  /// For **reading**, never for answering. The digits still come from a successful parse alone
  /// (ADR-8), so this can put the question on screen but never a button — which is exactly the
  /// trade: a card that names no options is safe, and one that says nothing at all is useless.
  /// Absent from a host too old to send it, and the card then says what it always said.
  final String? tail;

  /// The only condition under which native answer buttons may appear.
  bool get answerable => awaiting && prompt != null && hostSupports;

  factory PermissionSnapshot.fromJson(Map<String, Object?> json) {
    final rawPrompt = json['prompt'] as Map<String, Object?>?;
    return PermissionSnapshot(
      paneId: json['paneId']! as String,
      awaiting: json['awaiting']! as bool,
      hostSupports: json['hostSupports'] as bool? ?? true,
      prompt: rawPrompt == null ? null : PermissionPrompt.fromJson(rawPrompt),
      question: (json['question'] as List<Object?>?)
          ?.map((e) => UserQuestion.fromJson(e! as Map<String, Object?>))
          .toList(growable: false),
      readback: json['readback'] as String?,
      tail: json['tail'] as String?,
    );
  }
}
