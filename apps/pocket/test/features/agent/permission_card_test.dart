import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/agent/widgets/permission_card.dart';
import 'package:lotus_pocket/models/permission.dart';

PermissionSnapshot snapshot(PermissionPrompt prompt) => PermissionSnapshot(
      paneId: 'p-1',
      awaiting: true,
      hostSupports: true,
      prompt: prompt,
    );

Future<void> show(WidgetTester tester, PermissionSnapshot value) => tester.pumpWidget(
      MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(
          body: PermissionCard(
            snapshot: value,
            onAnswer: (_) {},
            onOpenTerminal: () {},
          ),
        ),
      ),
    );

void main() {
  testWidgets('a request to act is announced as a permission', (tester) async {
    await show(
      tester,
      snapshot(const PermissionPrompt(
        question: 'Bash rm -f notes.txt',
        options: [
          PromptOption(key: '1', label: 'Allow once', selected: true),
          PromptOption(key: '2', label: 'Deny', selected: false),
        ],
      )),
    );

    expect(find.text('PERMISSION'), findsOne);
    expect(find.text('Bash rm -f notes.txt'), findsOne);
  });

  /// The card the operator was shown for a five-option design question read **PERMISSION**
  /// above it. The word is not decoration: it tells them what kind of act they are about to
  /// commit, and answering a question is not granting leave to do anything.
  testWidgets('a question the agent is asking is announced as a question', (tester) async {
    await show(
      tester,
      snapshot(const PermissionPrompt(
        ask: 'question',
        question: 'Tabs or spaces?',
        options: [
          PromptOption(key: '1', label: 'Spaces', selected: true),
          PromptOption(key: '2', label: 'Tabs', selected: false),
        ],
      )),
    );

    expect(find.text('QUESTION'), findsOne);
    expect(find.text('PERMISSION'), findsNothing);
    // Its own words, and its own options, answered by their printed digits (ADR-8).
    expect(find.text('Tabs or spaces?'), findsOne);
    expect(find.text('Spaces'), findsOne);
    expect(find.text('Tabs'), findsOne);
  });

  testWidgets('a host that could not read the options still says so', (tester) async {
    await show(
      tester,
      const PermissionSnapshot(paneId: 'p-1', awaiting: true, hostSupports: true),
    );

    expect(find.text('PERMISSION'), findsOne);
    expect(find.textContaining('could not be read'), findsOne);
  });

  /**
   * The card that could not name the options used to be a dead end: one sentence saying so, and
   * a button to the terminal. The words the terminal had already printed never crossed — so the
   * operator had to leave Chat to find out what was even being asked.
   */
  testWidgets('shows what the terminal drew when the options could not be named',
      (tester) async {
    await show(
      tester,
      const PermissionSnapshot(
        paneId: 'p-1',
        awaiting: true,
        hostSupports: true,
        tail: '│ Save the indicator, or match Figma exactly?\n│\n│ ❯ 1. Keep it\n│   2. Remove it',
      ),
    );

    expect(find.textContaining('Save the indicator'), findsOne);
    expect(find.textContaining('1. Keep it'), findsOne);
    // No buttons: the digits come from a successful parse alone (ADR-8), and this card has
    // none. Reading is what it adds; answering stays behind the terminal.
    expect(find.text('READ IT IN FULL'), findsOne);
  });

  testWidgets('a host too old to send the tail still says what it can', (tester) async {
    await show(
      tester,
      const PermissionSnapshot(paneId: 'p-1', awaiting: true, hostSupports: true),
    );

    expect(find.textContaining('could not be read'), findsOne);
  });

  /// **The label is the safety feature, so it has to survive the screen.**
  ///
  /// The rule Lotus can compose for a standing grant is the tool's own name, so granting one
  /// `rm` grants every `Bash` in the cell. The words are the only place that scope is stated —
  /// a label clipped to "Allow all Bash until this…" would promise less than the button gives,
  /// on the narrowest phone the app supports.
  testWidgets('a standing grant states its whole scope, even on a narrow screen',
      (tester) async {
    tester.view.physicalSize = const Size(320 * 3, 640 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);

    await show(
      tester,
      snapshot(const PermissionPrompt(
        question: 'Bash rm -f doomed.txt',
        options: [
          PromptOption(key: '1', label: 'Allow once', selected: true),
          PromptOption(key: '2', label: 'Allow all Bash until this cell closes', selected: false),
          PromptOption(key: '3', label: 'Deny', selected: false),
        ],
      )),
    );

    final label = tester.widget<Text>(
      find.text('Allow all Bash until this cell closes'),
    );
    // No clipping and no ellipsis: whatever `maxLines` this ends up with, the words wrap.
    expect(label.maxLines, isNull);
    expect(label.overflow, anyOf(isNull, TextOverflow.visible));
    expect(tester.takeException(), isNull);
  });

  group('the card matches A2 (v4 tiket 06)', () {
    const prompt = PermissionPrompt(
      question: 'Do you want to delete src/legacy/shim.ts?',
      options: [
        PromptOption(key: '1', label: 'Yes', selected: true),
        PromptOption(key: '2', label: 'Yes, allow all edits during this session', selected: false),
        PromptOption(key: '3', label: 'No', selected: false),
      ],
    );

    Finder answer(String label) => find.ancestor(
          of: find.text(label),
          matching: find.byType(InkWell),
        );

    testWidgets('every answer is at least 48px tall', (tester) async {
      await show(tester, snapshot(prompt));

      for (final label in ['Yes', 'Yes, allow all edits during this session', 'No']) {
        expect(tester.getSize(answer(label)).height, greaterThanOrEqualTo(48), reason: label);
      }
    });

    testWidgets('each digit sits in its own box', (tester) async {
      await show(tester, snapshot(prompt));

      for (final key in ['1', '2', '3']) {
        final box = find.ancestor(of: find.text(key), matching: find.byKey(ValueKey('digit-$key')));
        expect(box, findsOne, reason: key);
        expect(tester.getSize(box).width, tester.getSize(box).height);
      }
    });

    testWidgets('says the answers go as keys, naming the printed digits', (tester) async {
      await show(tester, snapshot(prompt));

      expect(find.text('Answers are sent as key 1/2/3 to the session'), findsOne);
    });

    testWidgets('no sentence about keys when there is nothing to press', (tester) async {
      await show(
        tester,
        const PermissionSnapshot(paneId: 'p-1', awaiting: true, hostSupports: true),
      );

      expect(find.textContaining('sent as key'), findsNothing);
    });

    testWidgets('nor when the prompt offers no options at all', (tester) async {
      await show(tester, snapshot(const PermissionPrompt(question: 'Continue?', options: [])));

      expect(find.textContaining('sent as key'), findsNothing);
    });
  });
}
