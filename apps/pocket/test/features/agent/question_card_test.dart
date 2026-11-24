import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/agent/widgets/question_card.dart';
import 'package:lotus_pocket/models/conversation.dart';

Future<void> show(
  WidgetTester tester,
  List<UserQuestion> questions, {
  void Function(String key)? onAnswer,
  List<UserQuestionOption> extras = const [],
}) =>
    tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(
          body: SingleChildScrollView(
            child: QuestionCard(questions: questions, onAnswer: onAnswer, extras: extras),
          ),
        ),
      ),
    );

const asking = UserQuestion(
  question: 'File jenis apa yang mau dibuat?',
  header: 'Jenis file',
  options: [
    UserQuestionOption(
      label: 'Fitur baru di codespace-demo',
      description: 'Nambah fitur/komponen baru ke project vanilla.',
    ),
    UserQuestionOption(
      label: 'Ticket vault (TKT-XXX)',
      description: 'Scaffold/update ticket note di orbit-vault.',
    ),
  ],
);

void main() {
  /// The card exists because the same question arrived as `AskUserQuestion` above **Allow once**
  /// and **Deny**, and then as box-drawing characters scraped off a terminal. Both lost the words.
  testWidgets('shows the question, every option, and every option\'s own sentence',
      (tester) async {
    await show(tester, const [asking]);

    expect(find.text('QUESTION'), findsOne);
    expect(find.text('File jenis apa yang mau dibuat?'), findsOne);
    expect(find.text('Fitur baru di codespace-demo'), findsOne);
    expect(find.text('Nambah fitur/komponen baru ke project vanilla.'), findsOne);
    expect(find.text('Ticket vault (TKT-XXX)'), findsOne);
    expect(find.text('Scaffold/update ticket note di orbit-vault.'), findsOne);
  });

  testWidgets('prints the digit the terminal printed beside each option', (tester) async {
    await show(tester, const [asking]);

    expect(find.text('1'), findsOne);
    expect(find.text('2'), findsOne);
  });

  /// The words are the whole point, so they have to survive the screen — no clipping and no
  /// ellipsis on the narrowest phone the app supports.
  testWidgets('lets a long description wrap rather than clipping it', (tester) async {
    tester.view.physicalSize = const Size(320 * 3, 640 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    await show(tester, const [asking]);

    final description = tester.widget<Text>(
      find.text('Nambah fitur/komponen baru ke project vanilla.'),
    );
    expect(description.maxLines, isNull);
    expect(description.overflow, anyOf(isNull, TextOverflow.visible));
    expect(tester.takeException(), isNull);
  });

  /// One question does not need its own name — the question says what it is. Several do, and
  /// the header is the agent's own short word for each.
  testWidgets('names each question only when there is more than one', (tester) async {
    await show(tester, const [asking]);
    expect(find.text('JENIS FILE'), findsNothing);

    await show(tester, const [
      asking,
      UserQuestion(
        question: 'Simpan di mana?',
        header: 'Lokasi',
        options: [UserQuestionOption(label: 'tmp/')],
      ),
    ]);

    expect(find.text('QUESTIONS'), findsOne);
    expect(find.text('JENIS FILE'), findsOne);
    expect(find.text('LOKASI'), findsOne);
  });

  testWidgets('says when more than one answer may apply', (tester) async {
    await show(tester, const [
      UserQuestion(
        question: 'Mana saja yang perlu diubah?',
        multiSelect: true,
        options: [UserQuestionOption(label: 'Scope'), UserQuestionOption(label: 'Read-only')],
      ),
    ]);

    expect(find.text('More than one may apply.'), findsOne);
  });

  /// A cell this host runs itself can be answered from here, and the answer is the digit the
  /// **host** printed beside the option — never the one this list happens to show it at.
  group('answering from the card', () {
    const keyed = UserQuestion(
      question: 'Tabs or spaces?',
      options: [
        UserQuestionOption(label: 'Spaces', key: '3'),
        UserQuestionOption(label: 'Tabs', key: '4'),
      ],
    );

    testWidgets('sends the option own digit, not its position', (tester) async {
      final sent = <String>[];
      await show(tester, const [keyed], onAnswer: sent.add);

      await tester.tap(find.text('Tabs'));
      await tester.pump();

      expect(sent, ['4']);
    });

    testWidgets('shows the digit the host gave, where it has one', (tester) async {
      await show(tester, const [keyed], onAnswer: (_) {});
      expect(find.text('3'), findsOne);
      expect(find.text('4'), findsOne);
    });

    /// The TUI lane: options with no digit cannot be answered from here, and a control that
    /// does nothing is worse than none (ADR-8).
    testWidgets('stays read-only when the options carry no digit', (tester) async {
      var tapped = 0;
      await show(tester, const [asking], onAnswer: (_) => tapped++);

      await tester.tap(find.text('Ticket vault (TKT-XXX)'));
      await tester.pump();

      expect(tapped, 0);
    });

    testWidgets('stays read-only when nobody is listening for an answer', (tester) async {
      await show(tester, const [keyed]);
      final taps = find.byWidgetPredicate(
        (w) => w is InkWell && w.onTap != null,
      );
      expect(taps, findsNothing);
    });
  });

  /// **The terminal's own choices are choices too.** Claude prints `Type something.` and
  /// `Chat about this` under every question it asks, and they are how the operator answers
  /// outside the list. Leaving them off the phone left the operator holding fewer answers
  /// than the person at the keyboard — `bb` gives the same escape as "Other" with a text box.
  group('the choices the terminal added', () {
    const extras = [
      UserQuestionOption(label: 'Type something.', key: '4'),
      UserQuestionOption(label: 'Chat about this', key: '5'),
    ];

    testWidgets('draws them under the agent own, with their digits', (tester) async {
      await show(tester, const [asking], onAnswer: (_) {}, extras: extras);

      expect(find.text('Type something.'), findsOne);
      expect(find.text('Chat about this'), findsOne);
      expect(find.text('4'), findsOne);
      expect(find.text('5'), findsOne);
    });

    testWidgets('answers with the digit the terminal printed', (tester) async {
      final sent = <String>[];
      await show(tester, const [asking], onAnswer: sent.add, extras: extras);

      await tester.tap(find.text('Chat about this'));
      await tester.pump();

      expect(sent, ['5']);
    });

    testWidgets('draws nothing extra where the screen gave none', (tester) async {
      await show(tester, const [asking], onAnswer: (_) {});

      expect(find.text('Type something.'), findsNothing);
    });
  });
}
