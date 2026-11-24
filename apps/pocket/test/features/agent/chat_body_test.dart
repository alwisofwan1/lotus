import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/agent/question_digits.dart';
import 'package:lotus_pocket/features/agent/question_flow.dart';
import 'package:lotus_pocket/features/agent/widgets/chat_body.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/conversation.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/permission.dart';

Cell cell({String? turn}) => Cell(
      host: const HostId('mac'),
      paneId: 'p-1',
      workspaceId: 'ws',
      agentType: 'codex',
      title: 'Kai',
      status: 'live',
      isAlive: true,
      turn: turn,
    );

/// When the foot of Chat may say what was left behind.
void main() {
  test('idle and unknown both count as settled — unknown is Codex, always', () {
    expect(ChatBody.settled(cell(turn: 'idle')), isTrue);
    expect(ChatBody.settled(cell()), isTrue, reason: 'no turn signal is the common case');
  });

  test('a cell the fleet says is running or waiting is not described yet', () {
    expect(ChatBody.settled(cell(turn: 'running')), isFalse);
    expect(ChatBody.settled(cell(turn: 'needs-input')), isFalse);
  });

  /// The foot of Chat holds one thing at a time, and a question is not a permission: drawn as
  /// one, a five-option design question reached a phone as two buttons and no words.
  group('what the foot of Chat holds', () {
    const asked = PermissionSnapshot(
      paneId: 'p-1',
      awaiting: true,
      hostSupports: true,
      question: [
        UserQuestion(
          question: 'Tabs or spaces?',
          options: [
            UserQuestionOption(label: 'Spaces', description: 'Indent with spaces.', key: '1'),
            UserQuestionOption(label: 'Tabs', key: '2'),
          ],
        ),
      ],
      prompt: PermissionPrompt(
        question: 'Tabs or spaces?',
        ask: 'question',
        options: [
          PromptOption(key: '1', label: 'Spaces', selected: false),
          PromptOption(key: '2', label: 'Tabs', selected: false),
        ],
      ),
    );

    Future<void> pump(WidgetTester tester, PermissionSnapshot? permission,
        {void Function(PromptOption)? onAnswer, bool asking = false}) async {
      final footer = ChatBody.footer(
        permission,
        questionOpen: asking,
        onAnswer: onAnswer ?? (_) {},
        onOpenTerminal: () {},
      );
      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(body: SingleChildScrollView(child: footer ?? const SizedBox.shrink())),
      ));
    }

    /// **One interaction on screen, never two.** The question is drawn in the flow, where it
    /// happened; the foot must not put a second card under it saying the same moment could not
    /// be read. A phone showed exactly that pair — a QUESTION card with three named options
    /// above a PERMISSION card apologising that the options could not be named (2026-09-09).
    /// `bb` cannot reach this state at all: an approval and a question are one interaction
    /// there, with one resolution (`domain/pending-interactions.ts`).
    testWidgets('holds nothing while the flow is already asking', (tester) async {
      await pump(tester, asked, asking: true);

      expect(find.text('QUESTION'), findsNothing);
      expect(find.text('PERMISSION'), findsNothing);
    });

    /// The tail card exists for a prompt whose options could not be named — and that is
    /// exactly the case a question in the flow has already named.
    testWidgets('holds nothing while a question is open and the prompt is unreadable',
        (tester) async {
      await pump(
        tester,
        const PermissionSnapshot(paneId: 'p-1', awaiting: true, hostSupports: true, tail: 'raw'),
        asking: true,
      );

      expect(find.text('PERMISSION'), findsNothing);
    });

    testWidgets('still draws the permission card for a permission', (tester) async {
      await pump(
        tester,
        const PermissionSnapshot(
          paneId: 'p-1',
          awaiting: true,
          hostSupports: true,
          prompt: PermissionPrompt(
            question: 'Delete shim.ts?',
            options: [
              PromptOption(key: '1', label: 'Yes', selected: true),
              PromptOption(key: '2', label: 'No', selected: false),
            ],
          ),
        ),
      );

      expect(find.text('PERMISSION'), findsOne);
      expect(find.text('Yes'), findsOne);
    });

    testWidgets('holds nothing when the cell is not waiting', (tester) async {
      await pump(tester, null);
      expect(find.text('QUESTION'), findsNothing);
      expect(find.text('PERMISSION'), findsNothing);
    });
  });

  /// The flow is the authority on whether a question is open: it is what draws the card, and
  /// what the runner's own record settles. A settled one must let the foot speak again.
  group('is the flow asking', () {
    Part question({Map<String, List<String>>? answered, bool cancelled = false}) => QuestionPart(
          id: 'q1',
          ts: DateTime.fromMillisecondsSinceEpoch(1),
          seq: 1,
          provenance: Provenance.derived,
          questions: const [
            UserQuestion(question: 'Tabs or spaces?', options: [UserQuestionOption(label: 'Tabs')]),
          ],
          answered: answered,
          cancelled: cancelled,
        );

    Turn turn(List<Part> parts) => Turn(
        turnId: 't1', startedAt: DateTime.fromMillisecondsSinceEpoch(0), parts: parts);

    test('an unanswered question is open', () {
      expect(asking([turn([question()])]), isTrue);
    });

    test('an answered one is not, and neither is a refused one', () {
      expect(asking([turn([question(answered: const {'Tabs or spaces?': ['Tabs']})])]),
          isFalse);
      expect(asking([turn([question(cancelled: true)])]), isFalse);
    });

    test('a conversation with no question at all is not asking', () {
      expect(asking([turn(const [])]), isFalse);
    });
  });

  /// Whether the flow may be answered at all, and with what.
  group('answering a question in the flow', () {
    QuestionPart part(List<UserQuestionOption> options, {bool open = true}) => QuestionPart(
          id: 'q1',
          ts: DateTime.fromMillisecondsSinceEpoch(1),
          seq: 1,
          provenance: Provenance.derived,
          questions: [UserQuestion(question: 'Tabs or spaces?', options: options)],
          cancelled: !open,
        );

    Turn turn(List<Part> parts) => Turn(
        turnId: 't1', startedAt: DateTime.fromMillisecondsSinceEpoch(0), parts: parts);

    test('sends the digit and the words that go with it', () {
      final sent = <PromptOption>[];
      final answer = answerer([
        turn([
          part(const [
            UserQuestionOption(label: 'Spaces', key: '1'),
            UserQuestionOption(label: 'Tabs', key: '2'),
          ])
        ])
      ], sent.add);

      answer!('2');

      expect(sent.single.key, '2');
      expect(sent.single.label, 'Tabs');
    });

    /// A terminal cell. No digit reaches this app, so there is nothing to answer with, and a
    /// control that does nothing is worse than none.
    test('says there is nothing to answer with when the options carry no digit', () {
      final answer = answerer(
        [turn([part(const [UserQuestionOption(label: 'Spaces')])])],
        (_) {},
      );

      expect(answer, isNull);
    });

    test('says the same once the question is over', () {
      final answer = answerer(
        [turn([part(const [UserQuestionOption(label: 'Spaces', key: '1')], open: false)])],
        (_) {},
      );

      expect(answer, isNull);
    });
  });

  /// **A cell with a terminal, answered from Chat.** The digits come off the screen the host
  /// already sends for reading (`tail`), never from the card's own order — the terminal adds
  /// options the tool never wrote (ADR-8, probed 2026-09-09).
  group('answering a terminal cell', () {
    const screen = '''
Tabs atau spaces?

❯ 1. Spaces
  2. Tabs
  3. Type something.
''';

    final asking = QuestionPart(
      id: 'q1',
      ts: DateTime.fromMillisecondsSinceEpoch(1),
      seq: 1,
      provenance: Provenance.derived,
      questions: const [
        UserQuestion(
          question: 'Tabs atau spaces?',
          options: [UserQuestionOption(label: 'Spaces'), UserQuestionOption(label: 'Tabs')],
        ),
      ],
    );
    final turns = [
      Turn(turnId: 't1', startedAt: DateTime.fromMillisecondsSinceEpoch(0), parts: [asking])
    ];
    const waiting = PermissionSnapshot(
      paneId: 'p-1',
      awaiting: true,
      hostSupports: true,
      tail: screen,
    );

    test('reads each option digit off the screen the host sent', () {
      expect(choicesFor(turns, waiting).digits, {'Spaces': '1', 'Tabs': '2'});
    });

    /// The terminal's own choices reach the phone too, so the operator holds every answer
    /// the person at the keyboard does.
    test('carries the choices the terminal added under them', () {
      final extras = choicesFor(turns, waiting).extras;

      expect(extras.map((o) => o.label), ['Type something.']);
      expect(extras.single.key, '3');
    });

    test('answers one of those with the digit the terminal printed', () {
      final sent = <PromptOption>[];
      final choices = choicesFor(turns, waiting);
      final answer = answerer(turns, sent.add, choices: choices);

      answer!('3');

      expect(sent.single.label, 'Type something.');
    });

    test('answers with that digit, and the words that go with it', () {
      final sent = <PromptOption>[];
      final answer = answerer(turns, sent.add, choices: choicesFor(turns, waiting));

      answer!('2');

      expect(sent.single.key, '2');
      expect(sent.single.label, 'Tabs');
    });

    /// v4 tiket 06: Terminal's chips for a question come from here, because the host's
    /// permission parser names no prompt on a question screen (device, 2026-10-04).
    test('offers the agent options as chips, each with its printed digit', () {
      final asked = questionPrompt(turns, choicesFor(turns, waiting))!;

      expect(asked.question, 'Tabs atau spaces?');
      expect(asked.isQuestion, isTrue);
      expect([for (final o in asked.options) '${o.key} ${o.label}'], ['1 Spaces', '2 Tabs']);
    });

    test('offers no chips when the screen does not prove the digits', () {
      expect(questionPrompt(turns, ScreenChoices.none), isNull);
    });

    test('the screen from the phone: two options with descriptions, and the extras', () {
      const phone = '''
 ☐ Next task

Mau lanjut kerja apa dulu?

❯ 1. GitHub Issues source (Recommended)
     Mulai tambah GitHub Issues sebagai ticket source di Lotus Tasks.
  2. Tes APK di HP
     Cek fitur dock terminal dan quick answers di Infinix.
  3. Type something.
────────────────────────────────────────────────────────────
  4. Chat about this

Enter to select · ↑/↓ to navigate · Esc to cancel
''';
      final next = [
        Turn(
          turnId: 't1',
          startedAt: DateTime.fromMillisecondsSinceEpoch(0),
          parts: [
            QuestionPart(
              id: 'q1',
              ts: DateTime.fromMillisecondsSinceEpoch(1),
              seq: 1,
              provenance: Provenance.derived,
              questions: const [
                UserQuestion(
                  question: 'Mau lanjut kerja apa dulu?',
                  options: [
                    UserQuestionOption(label: 'GitHub Issues source (Recommended)'),
                    UserQuestionOption(label: 'Tes APK di HP'),
                  ],
                ),
              ],
            ),
          ],
        ),
      ];
      const shown = PermissionSnapshot(paneId: 'p-1', awaiting: true, hostSupports: true, tail: phone);

      final asked = questionPrompt(next, choicesFor(next, shown))!;

      expect([for (final o in asked.options) '${o.key} ${o.label}'],
          ['1 GitHub Issues source (Recommended)', '2 Tes APK di HP']);
    });

    test('stays read-only when the cell is not waiting on anything', () {
      const idle = PermissionSnapshot(paneId: 'p-1', awaiting: false, hostSupports: true);

      expect(choicesFor(turns, idle).isEmpty, isTrue);
      expect(answerer(turns, (_) {}, choices: ScreenChoices.none), isNull);
    });
  });

  /// **Both of the terminal's own choices hand the turn back to typing.** Probed on two live
  /// cells, 2026-09-10: `Type something.` ends the question with *"User declined to answer
  /// questions"* and returns to the prompt, and `Chat about this` ends it too and asks what
  /// you would like clarified. Neither is answered by the digit alone — the digit only opens
  /// the way — so the phone must put the keyboard where the terminal put its cursor. `bb`
  /// keeps the text box inside the card because it owns the whole interaction; here the
  /// composer *is* that prompt.
  group('a choice that hands over to typing', () {
    const screen = '''
Tabs atau spaces?

❯ 1. Spaces
  2. Tabs
  3. Type something.
''';
    final asking = QuestionPart(
      id: 'q1',
      ts: DateTime.fromMillisecondsSinceEpoch(1),
      seq: 1,
      provenance: Provenance.derived,
      questions: const [
        UserQuestion(
          question: 'Tabs atau spaces?',
          options: [UserQuestionOption(label: 'Spaces'), UserQuestionOption(label: 'Tabs')],
        ),
      ],
    );
    final turns = [
      Turn(turnId: 't1', startedAt: DateTime.fromMillisecondsSinceEpoch(0), parts: [asking])
    ];
    const waiting = PermissionSnapshot(
      paneId: 'p-1', awaiting: true, hostSupports: true, tail: screen,
    );

    test('asks for the keyboard after one of the terminal own choices', () {
      var handed = 0;
      final answer = answerer(
        turns,
        (_) {},
        choices: choicesFor(turns, waiting),
        onHandover: () => handed++,
      );

      answer!('3');

      expect(handed, 1);
    });

    test('leaves the keyboard alone when the answer was one of the agent own', () {
      var handed = 0;
      final answer = answerer(
        turns,
        (_) {},
        choices: choicesFor(turns, waiting),
        onHandover: () => handed++,
      );

      answer!('2');

      expect(handed, 0);
    });
  });

  /// **The card does not come back as a tail card the moment it is answered.**
  ///
  /// Answering `Type something.` opens a text field *inside* the same terminal prompt, so the
  /// cell is still awaiting — and the flow, having just settled its question, stopped
  /// suppressing the "options could not be named" card. A device showed exactly that: the
  /// keyboard opened, and an amber PERMISSION card slid under it (2026-09-10).
  ///
  /// The rule is the screen: while the terminal is still showing the question the flow has
  /// already named, there is nothing for a tail card to add.
  group('a prompt the flow has already named', () {
    QuestionPart part({bool open = true}) => QuestionPart(
          id: 'q1',
          ts: DateTime.fromMillisecondsSinceEpoch(1),
          seq: 1,
          provenance: Provenance.derived,
          questions: const [
            UserQuestion(question: 'Mau ngerjain apa?', options: [UserQuestionOption(label: 'A')]),
          ],
          answered: open ? null : const {'Mau ngerjain apa?': ['A']},
        );

    List<Turn> turnsOf(QuestionPart p) =>
        [Turn(turnId: 't1', startedAt: DateTime.fromMillisecondsSinceEpoch(0), parts: [p])];

    const showingIt = PermissionSnapshot(
      paneId: 'p-1',
      awaiting: true,
      hostSupports: true,
      tail: 'Mau ngerjain apa?\n\n❯ 1. A\n  2. Type something.',
    );

    test('is still named after the answer, while the terminal holds the same prompt', () {
      expect(namedOnScreen(turnsOf(part(open: false)), showingIt), isTrue);
    });

    test('is not named once the terminal has moved on to another question', () {
      const moved = PermissionSnapshot(
        paneId: 'p-1',
        awaiting: true,
        hostSupports: true,
        tail: 'Pilih fitur mana?\n\n❯ 1. Tic Tac Toe',
      );

      expect(namedOnScreen(turnsOf(part(open: false)), moved), isFalse);
    });

    test('says nothing about a cell that is not waiting at all', () {
      const idle = PermissionSnapshot(paneId: 'p-1', awaiting: false, hostSupports: true);

      expect(namedOnScreen(turnsOf(part()), idle), isFalse);
    });

    testWidgets('holds no tail card while the terminal shows what the flow named',
        (tester) async {
      final footer = ChatBody.footer(
        showingIt,
        questionOpen: namedOnScreen(turnsOf(part(open: false)), showingIt),
        onAnswer: (_) {},
        onOpenTerminal: () {},
      );
      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(body: footer ?? const SizedBox.shrink()),
      ));

      expect(find.text('PERMISSION'), findsNothing);
    });
  });
}
