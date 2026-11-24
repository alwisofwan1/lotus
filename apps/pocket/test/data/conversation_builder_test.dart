import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/conversation_builder.dart';
import 'package:lotus_pocket/models/conversation.dart';
import 'package:lotus_pocket/models/transcript.dart';

final Directory fixtures = Directory('../../contract/fixtures');

Map<String, Object?> read(String name) =>
    jsonDecode(File('${fixtures.path}/$name.json').readAsStringSync()) as Map<String, Object?>;

/// A part, flattened the way the wire spells it, so two producers can be compared.
Map<String, Object?> wire(Part p) => switch (p) {
      UserMessagePart() => {'type': 'user_message', 'id': p.id, 'seq': p.seq, 'text': p.text},
      AssistantTextPart() => {'type': 'assistant_text', 'id': p.id, 'seq': p.seq, 'text': p.text, 'truncated': p.truncated},
      ToolCallPart() => {
          'type': 'tool_call', 'id': p.id, 'seq': p.seq, 'toolName': p.toolName, 'title': p.title,
          'kind': p.kind, 'status': p.status, 'locations': p.locations,
          'files': [for (final f in p.files) {'path': f.path, 'additions': f.additions, 'deletions': f.deletions}],
        },
      _ => {'type': p.runtimeType.toString(), 'id': p.id, 'seq': p.seq},
    };

void main() {
  /// **The drift guard.** The host converted `rest-transcript.json` into
  /// `rest-conversation.json`; this converts the same entries here. One rule, two
  /// implementations, one test that fails the moment they disagree.
  test('the phone converts the transcript fixture into exactly the conversation fixture', () {
    final entries = TranscriptSnapshot.fromJson(read('rest-transcript')).entries;
    final expected = ConversationPage.fromJson(read('rest-conversation'));

    final turns = turnsFromEntries(entries, Provenance.hook);

    expect(turns.map((t) => t.turnId), expected.turns.map((t) => t.turnId));
    for (var i = 0; i < turns.length; i++) {
      expect(turns[i].startedAt, expected.turns[i].startedAt);
      expect(turns[i].endedAt, expected.turns[i].endedAt);
      expect(turns[i].stopReason, expected.turns[i].stopReason);
      expect(turns[i].parts.map(wire), expected.turns[i].parts.map(wire));
      expect(turns[i].parts.every((p) => p.provenance == Provenance.hook), isTrue);
    }
  });

  test('ids are the host\'s FNV-1a over the same composite key', () {
    // `stableId` in `tool-kind.ts`, run on the fixture's first entry.
    expect(fnv1a('1785664800000|tool-post|Edit|src/legacy/shim.ts|18'), '5ebce443');
    expect(fnv1a(''), '811c9dc5');
  });

  test('tool kinds follow the ACP vocabulary the host uses', () {
    expect(toolKindOf('Bash'), 'execute');
    expect(toolKindOf('apply_patch'), 'edit');
    expect(toolKindOf('web.search'), 'fetch');
    expect(toolKindOf('Something'), 'other');
  });

/// **The same rule, on the lane that has no host to do it.** A phone talking to a host with no
/// `/conversation` route converts entries itself, and until 2026-09-09 that converter knew
/// nothing about questions — so the same cell showed a question card against one host and a
/// bare `askuserquestion` step against another.
group('a question, converted here', () {
  TranscriptEntry entry({
    required String event,
    String title = '',
    String toolTarget = '',
    String? toolCallId,
    List<UserQuestion>? questions,
    Map<String, List<String>>? answers,
    int at = 1,
  }) =>
      TranscriptEntry(
        event: event,
        status: 'running',
        title: title,
        body: '',
        userPrompt: '',
        toolTarget: toolTarget,
        timestamp: DateTime.fromMillisecondsSinceEpoch(at),
        toolCallId: toolCallId,
        questions: questions,
        answers: answers,
      );

  final asking = entry(
    event: 'tool-pre',
    title: 'AskUserQuestion',
    toolTarget: 'Tabs or spaces?',
    toolCallId: 'toolu_9',
    questions: const [
      UserQuestion(
        question: 'Tabs or spaces?',
        options: [UserQuestionOption(label: 'Spaces'), UserQuestionOption(label: 'Tabs')],
      ),
    ],
  );

  test('becomes a question part, not a call whose title is a sentence', () {
    final parts = turnsFromEntries([asking], Provenance.hook).expand((t) => t.parts);

    final question = parts.whereType<QuestionPart>().single;
    expect(question.questions.single.options.map((o) => o.label), ['Spaces', 'Tabs']);
    expect(parts.whereType<ToolCallPart>(), isEmpty);
  });

  test('closes with what the operator chose', () {
    final parts = turnsFromEntries([
      asking,
      entry(event: 'tool-post', toolCallId: 'toolu_9', answers: const {'Tabs or spaces?': ['Tabs']}, at: 2),
    ], Provenance.hook).expand((t) => t.parts);

    final question = parts.whereType<QuestionPart>().single;
    expect(question.answered, {'Tabs or spaces?': ['Tabs']});
    expect(question.isOpen, isFalse);
  });

  test('closes as cancelled when the operator refused it', () {
    final parts = turnsFromEntries([
      asking,
      entry(event: 'tool-post-failed', toolCallId: 'toolu_9', at: 2),
    ], Provenance.hook).expand((t) => t.parts);

    expect(parts.whereType<QuestionPart>().single.cancelled, isTrue);
  });

  test('pairs a result with the call carrying its id, not with whichever came last', () {
    final parts = turnsFromEntries([
      entry(event: 'tool-pre', title: 'Bash', toolTarget: 'sleep 30', toolCallId: 'a'),
      entry(event: 'tool-pre', title: 'Bash', toolTarget: 'ls', toolCallId: 'b'),
      entry(event: 'tool-post', title: 'Bash', toolCallId: 'a', at: 2),
    ], Provenance.hook).expand((t) => t.parts).whereType<ToolCallPart>().toList();

    expect(parts.map((p) => [p.title, p.status]), [
      ['sleep 30', 'completed'],
      ['ls', 'in_progress'],
    ]);
  });
});
}
