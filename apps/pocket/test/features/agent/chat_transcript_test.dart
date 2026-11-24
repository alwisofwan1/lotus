import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/agent/chat_transcript.dart';
import 'package:lotus_pocket/models/conversation.dart';
import 'package:lotus_pocket/models/transcript.dart';

final Directory fixtures = Directory('../../contract/fixtures');

TranscriptEntry entry({
  String event = 'tool-pre',
  String title = 'Read',
  String body = '',
  String userPrompt = 'clean up the legacy files',
  String toolTarget = 'src/legacy/shim.ts',
  int? linesAdded,
  int? linesRemoved,
  int at = 1785664800000,
}) =>
    TranscriptEntry(
      event: event,
      status: 'running',
      title: title,
      body: body,
      userPrompt: userPrompt,
      toolTarget: toolTarget,
      timestamp: DateTime.fromMillisecondsSinceEpoch(at),
      linesAdded: linesAdded,
      linesRemoved: linesRemoved,
    );

/// Kept as a function though it now returns its argument.
///
/// `ChatTranscript.of` used to take a `TranscriptSnapshot`; it takes entries since the
/// live path started merging socket frames into the same list, and a snapshot is only
/// one of the two sources. The call sites below read the same either way, and losing
/// the word "snapshot" from them would lose what they are describing.
List<TranscriptEntry> snapshot(List<TranscriptEntry> entries) => entries;

void main() {
  _questionGroup();
  _reasoningTests();
  _turnBoundaryTests();
  _noticeTests();
  group('the three kinds of line, told apart by typeface', () {
    test('a tool event is a step, carrying the tool name and its target', () {
      final chat = ChatTranscript.of(snapshot([entry(title: 'Read')]));

      final step = chat.items.last;
      expect(step.kind, ChatLine.step);
      expect(step.label, 'Read');
      expect(step.text, 'src/legacy/shim.ts');
    });

    test('a stop event is prose — the assistant\'s own last message', () {
      // `body` on a stop payload is filled from `last_assistant_message`
      // (scripts/agent-notify/payload-extractors.mjs), so it is literally what it said.
      final chat = ChatTranscript.of(snapshot([
        entry(event: 'stop', title: 'Finished working', body: 'Neither file is referenced.'),
      ]));

      final prose = chat.items.last;
      expect(prose.kind, ChatLine.prose);
      expect(prose.text, 'Neither file is referenced.');
      // No tool name and no diff: prose is not a step wearing a different font.
      expect(prose.label, isNull);
      expect(prose.diff, isNull);
    });

    test('the prompt becomes a bubble, ahead of the work it caused', () {
      final chat = ChatTranscript.of(snapshot([entry(userPrompt: 'clean up the legacy files')]));

      expect(chat.items.first.kind, ChatLine.prompt);
      expect(chat.items.first.text, 'clean up the legacy files');
      expect(chat.items[1].kind, ChatLine.step);
    });
  });

  group('the prompt repeats in the payload, but not on screen', () {
    test('one bubble for a run of entries sharing a prompt', () {
      final chat = ChatTranscript.of(snapshot([
        entry(title: 'Read'),
        entry(title: 'Grep'),
        entry(title: 'Edit'),
      ]));

      // Every hook payload carries the prompt that led to the turn. Emitting it per
      // entry would repeat the operator's own sentence three times.
      expect(chat.items.where((i) => i.kind == ChatLine.prompt), hasLength(1));
      expect(chat.items, hasLength(4));
    });

    test('a new prompt opens a new bubble', () {
      final chat = ChatTranscript.of(snapshot([
        entry(userPrompt: 'first thing'),
        entry(userPrompt: 'second thing'),
      ]));

      final prompts = chat.items.where((i) => i.kind == ChatLine.prompt).toList();
      expect(prompts.map((p) => p.text), ['first thing', 'second thing']);
    });

    test('a prompt returning after another still opens its own bubble', () {
      // Compared with the previous entry, never with everything seen: coming back to an
      // earlier phrasing is a new turn, and silently folding it into the first bubble
      // would put later steps under a prompt that did not cause them.
      final chat = ChatTranscript.of(snapshot([
        entry(userPrompt: 'A'),
        entry(userPrompt: 'B'),
        entry(userPrompt: 'A'),
      ]));

      expect(chat.items.where((i) => i.kind == ChatLine.prompt), hasLength(3));
    });

    test('the same sentence sent again after a turn ends opens its own bubble', () {
      // The disappearance this fixes: comparing text alone means `run the tests`, a
      // finish, then `run the tests` again draws one bubble for two turns — and the
      // second turn's steps then hang under a prompt that did not cause them.
      final chat = ChatTranscript.of(snapshot([
        entry(title: 'Read'),
        entry(event: 'stop', title: 'Finished working', body: 'Done.'),
        entry(title: 'Read'),
      ]));

      expect(chat.items.where((i) => i.kind == ChatLine.prompt), hasLength(2));
    });

    test('the line that ends a turn stays under the prompt that caused it', () {
      // `stop` carries the prompt of the turn it is *closing*, so opening a bubble on it
      // would put a turn's last words under the heading of the next one.
      final chat = ChatTranscript.of(snapshot([
        entry(title: 'Read'),
        entry(event: 'stop', title: 'Finished working', body: 'Done.'),
      ]));

      expect(chat.items.where((i) => i.kind == ChatLine.prompt), hasLength(1));
      expect(chat.items.last.kind, ChatLine.prose);
    });

    test('an empty prompt draws no bubble at all', () {
      final chat = ChatTranscript.of(snapshot([entry(userPrompt: '')]));

      expect(chat.items.every((i) => i.kind != ChatLine.prompt), isTrue);
    });
  });

  group('diff badges — absent is not zero', () {
    test('both counts present renders the badge', () {
      final chat = ChatTranscript.of(snapshot([
        entry(title: 'Edit', linesAdded: 0, linesRemoved: 34),
      ]));

      expect(chat.items.last.diff, '+0 −34');
    });

    test('neither count renders no badge — a Read must not say +0 −0', () {
      final chat = ChatTranscript.of(snapshot([entry(title: 'Read')]));

      expect(chat.items.last.diff, isNull);
    });

    test('one count present still renders, treating the missing side as zero', () {
      final chat = ChatTranscript.of(snapshot([entry(title: 'Write', linesAdded: 12)]));

      expect(chat.items.last.diff, '+12 −0');
    });

    test('a genuine zero-change edit says so, and is not hidden', () {
      // The distinction this whole field exists for: "changed nothing" is a real result,
      // and it differs from "no diff applies here".
      final chat = ChatTranscript.of(snapshot([
        entry(title: 'Edit', linesAdded: 0, linesRemoved: 0),
      ]));

      expect(chat.items.last.diff, '+0 −0');
    });
  });

  group('edges', () {
    test('an empty transcript is empty, not a placeholder line', () {
      expect(ChatTranscript.of(snapshot([])).isEmpty, isTrue);
    });

    test('a stop with nothing to say adds no line', () {
      final chat = ChatTranscript.of(snapshot([entry(event: 'stop', body: '')]));

      expect(chat.items.where((i) => i.kind == ChatLine.prose), isEmpty);
    });

    test('a prompt-submit entry is the bubble, in its own place', () {
      // The host sends what the operator typed as its own entry with its own timestamp
      // (`settings.rs`, CLAUDE_HOOK_EVENTS), so it sorts into the turn it opened instead
      // of landing wherever the once-per-turn `userPrompt` field happened to ride.
      final chat = ChatTranscript.of(snapshot([
        entry(event: 'prompt-submit', title: 'You', body: 'Buatkan pantun', userPrompt: '', toolTarget: ''),
        entry(event: 'stop', title: 'Finished working', body: 'Berikut pantunnya:', userPrompt: ''),
      ]));

      expect(chat.items.map((i) => i.kind), [ChatLine.prompt, ChatLine.prose]);
      expect(chat.items.first.text, 'Buatkan pantun');
    });

    test('and it suppresses the inferred one, so nothing is said twice', () {
      final chat = ChatTranscript.of(snapshot([
        entry(event: 'prompt-submit', title: 'You', body: 'run the tests', userPrompt: '', toolTarget: ''),
        entry(title: 'Read', userPrompt: 'run the tests'),
      ]));

      expect(chat.items.where((i) => i.kind == ChatLine.prompt), hasLength(1));
    });

    test('the same words asked twice draw two bubbles, because they happened twice', () {
      final chat = ChatTranscript.of(snapshot([
        entry(event: 'prompt-submit', body: 'Hi', userPrompt: '', toolTarget: ''),
        entry(event: 'stop', body: 'Hello.', userPrompt: ''),
        entry(event: 'prompt-submit', body: 'Hi', userPrompt: '', toolTarget: ''),
      ]));

      expect(chat.items.where((i) => i.kind == ChatLine.prompt), hasLength(2));
    });

    test('an empty prompt-submit draws nothing at all', () {
      final chat = ChatTranscript.of(snapshot([
        entry(event: 'prompt-submit', title: 'You', body: '', userPrompt: '', toolTarget: ''),
      ]));

      expect(chat.items, isEmpty);
    });

    test('an entry that names nothing draws nothing', () {
      // `notification_event.rs`: only `UserPromptSubmit` populates `user_prompt`, so
      // that entry arrives carrying the prompt and nothing else. Rendered as a step it
      // became a silent empty row between two things the agent said — which on a phone
      // reads as the transcript having lost something.
      final chat = ChatTranscript.of(snapshot([
        entry(title: '', toolTarget: '', body: '', userPrompt: 'Hi'),
      ]));

      // The prompt still lands, as the bubble it is.
      expect(chat.items.map((i) => i.kind), [ChatLine.prompt]);
    });

    test('a step with a name but no target still draws — it did happen', () {
      final chat = ChatTranscript.of(snapshot([
        entry(title: 'Bash', toolTarget: '', body: ''),
      ]));

      expect(chat.items.last.kind, ChatLine.step);
      expect(chat.items.last.label, 'Bash');
    });

    test('a step with no toolTarget falls back to body', () {
      final chat = ChatTranscript.of(snapshot([
        entry(title: 'Bash', toolTarget: '', body: 'bun run test'),
      ]));

      expect(chat.items.last.text, 'bun run test');
    });

    test('an event kind this app has never seen is treated as a step, not dropped', () {
      // The host may be newer than the app (ADR-10). A step is the honest fallback:
      // something happened, and it is shown rather than silently swallowed.
      final chat = ChatTranscript.of(snapshot([entry(event: 'tool-mid', title: 'Whatever')]));

      expect(chat.items.last.kind, ChatLine.step);
      expect(chat.items.last.label, 'Whatever');
    });

    test('order is preserved — oldest first, as the contract sends it', () {
      final chat = ChatTranscript.of(snapshot([
        entry(title: 'First', at: 1000),
        entry(title: 'Second', at: 2000),
      ]));

      final steps = chat.items.where((i) => i.kind == ChatLine.step).toList();
      expect(steps.map((s) => s.label), ['First', 'Second']);
    });
  });

  test('the real fixture renders as one bubble, two steps, a diff and a cut reply', () {
    final json = jsonDecode(File('${fixtures.path}/rest-transcript.json').readAsStringSync())
        as Map<String, Object?>;
    final chat = ChatTranscript.of(TranscriptSnapshot.fromJson(json).entries);

    // rest-transcript.json: two tool entries sharing one prompt, one with a diff and
    // one without — which is exactly the pair that proves the badge rule.
    expect(chat.items.where((i) => i.kind == ChatLine.prompt), hasLength(1));
    expect(chat.items.where((i) => i.kind == ChatLine.step), hasLength(2));
    expect(chat.items.where((i) => i.diff != null), hasLength(1));
    expect(chat.items.firstWhere((i) => i.diff != null).diff, '+0 −34');

    // And the turn's own words, cut by the host's cap. The flag has to survive the
    // whole way from the fixture to the rendered item, or the screen shows a sentence
    // stopping mid-word as though the agent stopped there.
    final prose = chat.items.singleWhere((i) => i.kind == ChatLine.prose);
    expect(prose.truncated, isTrue);
  });
}

/// The runners send `reasoning` every turn and the app dropped it until 2026-09-08 —
/// `_lineFor` mapped five kinds and closed with `_ => null`. It is the material the
/// thinking state is made of, and it was already arriving.
void _reasoningTests() {
  group('what it was working out', () {
    Part reasoning(String text, {bool redacted = false}) => ReasoningPart(
        id: 'r', ts: DateTime.fromMillisecondsSinceEpoch(1788820000000), seq: 0,
        provenance: Provenance.native, text: text, redacted: redacted);

    test('reasoning becomes its own kind of line', () {
      final items = ChatTranscript.ofTurns([
        Turn(
          turnId: 't-1',
          startedAt: DateTime.fromMillisecondsSinceEpoch(1788820000000),
          parts: [reasoning('Flaky di CI tapi tidak lokal biasanya soal waktu.')],
        )
      ]).items;
      expect(items, hasLength(1));
      expect(items.single.kind, ChatLine.thinking);
      expect(items.single.text, startsWith('Flaky di CI'));
    });

    test('withheld reasoning draws nothing, rather than an empty block', () {
      final items = ChatTranscript.ofTurns([
        Turn(
          turnId: 't-1',
          startedAt: DateTime.fromMillisecondsSinceEpoch(1788820000000),
          parts: [reasoning('', redacted: false), reasoning('hidden', redacted: true)],
        )
      ]).items;
      expect(items, isEmpty);
    });
  });
}

/// A question is its own thing on screen — options with words of their own, and nothing a
/// `step` line could carry. `bb` models it the same way (`user-question-form-state.ts`), and
/// that is the line that stops a five-option design question arriving as a bare
/// `askuserquestion` step.
void _questionGroup() {
  group('a question the agent is asking', () {
    final part = QuestionPart(
      id: 'q-1',
      ts: DateTime.utc(2026, 9, 9, 8),
      seq: 3,
      provenance: Provenance.hook,
      questions: const [
        UserQuestion(
          question: 'Tabs or spaces?',
          header: 'Indentation',
          options: [
            UserQuestionOption(label: 'Spaces', description: 'Indent with spaces.'),
            UserQuestionOption(label: 'Tabs'),
          ],
        ),
      ],
    );

    test('parses from the wire with every option and its words', () {
      final parsed = Part.fromJson({
        'id': 'q-1',
        'ts': 1757404800000,
        'seq': 3,
        'provenance': 'hook',
        'type': 'question',
        'questions': [
          {
            'question': 'Tabs or spaces?',
            'header': 'Indentation',
            'options': [
              {'label': 'Spaces', 'description': 'Indent with spaces.'},
              {'label': 'Tabs'},
            ],
          },
        ],
      });

      expect(parsed, isA<QuestionPart>());
      final q = (parsed as QuestionPart).questions.single;
      expect(q.question, 'Tabs or spaces?');
      expect(q.header, 'Indentation');
      expect(q.multiSelect, isFalse);
      expect(q.options.map((o) => o.label), ['Spaces', 'Tabs']);
      expect(q.options.first.description, 'Indent with spaces.');
      expect(parsed.isAnswered, isFalse);
    });

    test('becomes a line of its own, never a step', () {
      final items = ChatTranscript.ofTurns([
        Turn(turnId: 't-1', startedAt: part.ts, parts: [part]),
      ]).items;

      expect(items.single.kind, ChatLine.question);
      expect(items.single.questions, isNotNull);
      expect(items.single.text, 'Tabs or spaces?');
    });

    /// **A card only while it is a question.** Once it is over, the options are no longer
    /// anything to choose between — they are a list of roads not taken, sitting above the
    /// agent's reply and taking half the screen. `bb` does not keep them either: the form is a
    /// *pending* interaction there, and a resolved one leaves the thread with the ordinary
    /// event and the agent's own words (`ThreadPendingInteractionBanner.tsx`).
    List<ChatItem> itemsFor(QuestionPart p) =>
        ChatTranscript.ofTurns([Turn(turnId: 't-1', startedAt: p.ts, parts: [p])]).items;

    test('collapses to one step line naming what was chosen', () {
      final items = itemsFor(QuestionPart(
        id: part.id, ts: part.ts, seq: part.seq, provenance: part.provenance,
        questions: part.questions,
        answered: const {'Tabs or spaces?': ['Tabs']},
      ));

      expect(items.single.kind, ChatLine.step);
      expect(items.single.label, 'question');
      expect(items.single.text, 'Tabs');
      expect(items.single.status, 'completed');
      expect(items.single.questions, isNull, reason: 'nothing left to draw a card from');
    });

    test('names every answer when more than one was chosen', () {
      final items = itemsFor(QuestionPart(
        id: part.id, ts: part.ts, seq: part.seq, provenance: part.provenance,
        questions: part.questions,
        answered: const {'Tabs or spaces?': ['Tabs', 'Spaces']},
      ));

      expect(items.single.text, 'Tabs, Spaces');
    });

    test('says what was asked when the operator refused it', () {
      final items = itemsFor(QuestionPart(
        id: part.id, ts: part.ts, seq: part.seq, provenance: part.provenance,
        questions: part.questions,
        cancelled: true,
      ));

      expect(items.single.kind, ChatLine.step);
      expect(items.single.text, 'Tabs or spaces?');
      expect(items.single.status, 'cancelled');
    });

    /// An answer the runner recorded without naming the choice — the sentence it writes does
    /// not always carry one. The step still says the question ended, rather than nothing.
    test('falls back to what was asked when the answer has no words', () {
      final items = itemsFor(QuestionPart(
        id: part.id, ts: part.ts, seq: part.seq, provenance: part.provenance,
        questions: part.questions,
        answered: const {},
      ));

      expect(items.single.text, 'Tabs or spaces?');
      expect(items.single.status, 'completed');
    });
  });
}

/// The turn boundary the host already decided, kept rather than flattened away.
///
/// `ofTurns` walked `turn.parts` and appended into one list, so `turnId` — and with it any
/// chance of drawing a turn as one block — was dropped one line before rendering. Issue 01 of
/// `plans/pocket-chat-turn-presentation`.
void _turnBoundaryTests() {
  Turn turn(String id, List<Part> parts, {String? stopReason}) => Turn(
        turnId: id,
        startedAt: DateTime.fromMillisecondsSinceEpoch(1788820000000),
        stopReason: stopReason,
        parts: parts,
      );

  Part said(String text) => AssistantTextPart(
      id: 'a-$text', ts: DateTime.fromMillisecondsSinceEpoch(1788820000000), seq: 0,
      provenance: Provenance.native, text: text, streaming: false, truncated: false);

  Part asked(String text) => UserMessagePart(
      id: 'u-$text', ts: DateTime.fromMillisecondsSinceEpoch(1788820000000), seq: 0,
      provenance: Provenance.native, text: text);

  group('a line remembers which turn it came from', () {
    test('every line of one turn carries that turn id', () {
      final items = ChatTranscript.ofTurns([
        turn('t-1', [asked('rapikan berkas lama'), said('sudah, tiga berkas dihapus')]),
      ]).items;

      expect(items, hasLength(2));
      expect(items.map((i) => i.turnId), everyElement('t-1'));
    });

    test('why the turn ended rides on every line of it, not only the last', () {
      // Every line, because `ChatLayout` groups on `turnId` and then asks the group how it
      // ended — hunting for "the last item" breaks the moment a line is filtered out, and
      // `_lineFor` already drops redacted reasoning and empty prose.
      final items = ChatTranscript.ofTurns([
        turn('t-1', [asked('jalankan test'), said('dihentikan')], stopReason: 'cancelled'),
      ]).items;

      expect(items, hasLength(2));
      expect(items.map((i) => i.stopReason), everyElement('cancelled'));
    });

    test('two turns keep two ids — the second is not folded into the first', () {
      final items = ChatTranscript.ofTurns([
        turn('t-1', [asked('rapikan'), said('sudah')]),
        turn('t-2', [asked('sekarang test'), said('hijau')]),
      ]).items;

      expect(items.map((i) => i.turnId).toList(), ['t-1', 't-1', 't-2', 't-2']);
    });

    test('a turn still open says nothing about how it ended', () {
      final items = ChatTranscript.ofTurns([
        turn('t-1', [asked('mulai')]),
      ]).items;

      expect(items.single.stopReason, isNull);
    });
  });
}

/// A warning is not a failure, and the wire has said so all along.
///
/// The host sends a plan-window change as `{type: "error", recoverable: true}`
/// (`bridges/claude/conversation.ts`). `ErrorPart.recoverable` was parsed and then never
/// read, so `overage plan limit: allowed_warning` — a heads-up on a turn that succeeded —
/// drew in `AppTokens.error`, identical to an interrupted turn. Seen on a real VPS cell
/// on 2026-09-10.
void _noticeTests() {
  Part err(String message, {required bool recoverable}) => ErrorPart(
      id: 'e-$message', ts: DateTime.fromMillisecondsSinceEpoch(1788820000000), seq: 0,
      provenance: Provenance.native, message: message, recoverable: recoverable);

  ChatTranscript one(Part part) => ChatTranscript.ofTurns([
        Turn(
          turnId: 't-1',
          startedAt: DateTime.fromMillisecondsSinceEpoch(1788820000000),
          parts: [part],
        )
      ]);

  group('a recoverable error is a notice, not a failure', () {
    test('a plan-window warning does not draw as an error', () {
      final item = one(err('five_hour plan limit: allowed_warning.', recoverable: true))
          .items
          .single;

      expect(item.kind, ChatLine.notice);
    });

    test('an unrecoverable error is still a failure', () {
      final item = one(err('Interrupted', recoverable: false)).items.single;

      expect(item.kind, ChatLine.problem);
    });
  });
}
