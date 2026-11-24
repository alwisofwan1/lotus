part of 'conversation.dart';

// A question the agent is putting to the operator, and the shapes it is made of.
//
// A `part` rather than its own library because [Part] is `sealed`: Dart requires every subtype
// in one library, and [QuestionPart] is one. The split is still the right one — these are the
// only shapes here that are *waiting on a person*, where everything left in `conversation.dart`
// records what already happened.

/// One answer an agent is offering, in its own words.
class UserQuestionOption {
  const UserQuestionOption({required this.label, this.description, this.key});
  final String label;

  /// The digit that answers this option, when it can be answered at all. Present on a cell
  /// this host runs itself; absent on a cell with a terminal, where the digits belong to the
  /// screen and deriving one from a position would answer a different question (ADR-8).
  final String? key;

  /// The sentence under the label. Absent when the agent wrote none — and absent is not an
  /// empty string: a line of nothing under an option reads as a rendering fault.
  final String? description;

  factory UserQuestionOption.fromJson(Map<String, Object?> json) => UserQuestionOption(
        label: json['label']! as String,
        description: json['description'] as String?,
        key: json['key'] as String?,
      );
}

/// One question, as the agent asked it.
class UserQuestion {
  const UserQuestion({
    required this.question,
    required this.options,
    this.header,
    this.multiSelect = false,
  });

  final String question;

  /// The agent's own short word for it — `Indentation`, `Scope`. The only label short enough
  /// to name one question among several.
  final String? header;

  /// Whether more than one option may be chosen. Absent on the wire means one.
  final bool multiSelect;
  final List<UserQuestionOption> options;

  factory UserQuestion.fromJson(Map<String, Object?> json) => UserQuestion(
        question: json['question']! as String,
        header: json['header'] as String?,
        multiSelect: json['multiSelect'] as bool? ?? false,
        options: (json['options']! as List<Object?>)
            .map((e) => UserQuestionOption.fromJson(e! as Map<String, Object?>))
            .toList(growable: false),
      );
}

/// A question the agent is putting to the operator — **not** a permission.
///
/// A permission asks leave to act and takes a yes or a no. This asks the operator to *choose*,
/// and every option carries words of its own. Drawing it as a permission is how a five-option
/// design question came to sit under an amber `PERMISSION` banner above **Allow once** and
/// **Deny** — with the question itself nowhere on screen.
class QuestionPart extends Part {
  const QuestionPart({
    required super.id, required super.ts, required super.seq, required super.provenance,
    required this.questions,
    this.answered,
    this.cancelled = false,
    this.toolCallId,
  });

  final List<UserQuestion> questions;

  /// The tool call this question belongs to, when the runner reported one. It is what the
  /// result answering it pairs against — a question has no tool name to fall back on.
  final String? toolCallId;

  /// Chosen labels per question, keyed by the question's own text. Null while it is still open.
  final Map<String, List<String>>? answered;

  /// The operator refused it — Esc at a terminal, or a cell closed while it waited.
  ///
  /// Its own flag rather than an empty [answered], because "chose nothing" and "was never
  /// going to choose" are different things to draw.
  final bool cancelled;

  bool get isAnswered => answered != null;

  /// Still waiting on a person. The only state a control may be drawn for.
  bool get isOpen => answered == null && !cancelled;

  factory QuestionPart.fromJson(
    Map<String, Object?> json, {
    required String id,
    required DateTime ts,
    required int seq,
    required Provenance provenance,
  }) {
    final answered = json['answered'] as Map<String, Object?>?;
    return QuestionPart(
      id: id, ts: ts, seq: seq, provenance: provenance,
      questions: (json['questions']! as List<Object?>)
          .map((e) => UserQuestion.fromJson(e! as Map<String, Object?>))
          .toList(growable: false),
      cancelled: json['cancelled'] as bool? ?? false,
      toolCallId: json['toolCallId'] as String?,
      answered: answered == null
          ? null
          : {
              for (final entry in answered.entries)
                entry.key: (entry.value! as List<Object?>).map((e) => e! as String).toList(),
            },
    );
  }
}
