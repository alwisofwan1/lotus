import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/agent/question_flow.dart';
import 'package:lotus_pocket/features/shared/composer.dart';

/// **Where the terminal put its cursor, the phone puts the keyboard.**
///
/// `Type something.` and `Chat about this` end a question and expect the next thing to be
/// typed (probed on two live cells, 2026-09-10). The composer is this app's prompt, so it has
/// to be reachable from outside — `bb` keeps its text box inside the card because it owns the
/// whole interaction; here the terminal hands typing back to its own prompt.
void main() {
  testWidgets('the composer takes a focus node, and answers to it', (tester) async {
    final node = FocusNode();
    addTearDown(node.dispose);

    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(
        body: Composer(
          mood: ComposerMood.asking,
          agent: 'Atlas',
          focusNode: node,
          onSend: (_) async => true,
        ),
      ),
    ));

    expect(node.hasFocus, isFalse);
    node.requestFocus();
    await tester.pump();

    expect(node.hasFocus, isTrue);
    expect(tester.widget<TextField>(find.byType(TextField)).focusNode, same(node));
  });

  /// **A disabled field cannot hold focus.** The composer is disabled while a send is in
  /// flight, so asking for the keyboard *during* the send drops it on the floor — the keyboard
  /// appeared and closed again on a device, 2026-09-10. It has to be asked for once the answer
  /// has landed.
  testWidgets('loses the keyboard while a send is in flight', (tester) async {
    final node = FocusNode();
    addTearDown(node.dispose);

    Future<void> pump({required bool enabled}) => tester.pumpWidget(MaterialApp(
          theme: buildAppTheme(),
          home: Scaffold(
            body: Composer(
              mood: ComposerMood.asking,
              agent: 'Atlas',
              focusNode: node,
              enabled: enabled,
              onSend: (_) async => true,
            ),
          ),
        ));

    await pump(enabled: true);
    node.requestFocus();
    await tester.pump();
    expect(node.hasFocus, isTrue);

    await pump(enabled: false);
    await tester.pump();

    expect(node.hasFocus, isFalse);
  });

  /// The rule itself, without a widget: ask for the keyboard **after** the answer lands.
  group('TypingHandover', () {
    test('takes the keyboard only for an answer that expects typing next', () {
      final handover = TypingHandover();
      addTearDown(handover.dispose);

      expect(handover.landed(), isFalse);

      handover.expect();
      expect(handover.landed(), isTrue);
    });

    test('forgets the expectation once it has been met', () {
      final handover = TypingHandover();
      addTearDown(handover.dispose);

      handover.expect();
      handover.landed();

      expect(handover.landed(), isFalse, reason: 'the next answer is not this one');
    });
  });
}
