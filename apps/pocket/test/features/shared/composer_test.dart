import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/shared/composer.dart';
import 'package:lotus_pocket/features/shared/composer_box.dart';
import 'package:lotus_pocket/features/shared/draft_editor.dart';
import 'package:lotus_pocket/features/shared/held_paste.dart';
import 'package:lotus_pocket/features/shared/send_button.dart';

/// The composer's own rules, at the one seam both surfaces share.
///
/// Agent and Home each build a [Composer] and hand it an `onSend`; nothing else about
/// them differs here. So these tests pump the widget alone rather than a page — a rule
/// that holds for the composer holds for both places it is used, and a page test would
/// drag a transport and a pairing along to prove it.
Future<void> pumpComposer(
  WidgetTester tester, {
  ComposerMood mood = ComposerMood.working,
  Future<bool> Function(String text)? onSend,
  TextEditingController? controller,
  Widget? about,
}) async {
  await tester.pumpWidget(MaterialApp(
    theme: buildAppTheme(),
    home: Scaffold(
      body: Composer(
        mood: mood,
        agent: 'Nita',
        controller: controller,
        about: about,
        onSend: onSend ?? (_) async => true,
      ),
    ),
  ));
  await tester.pump();
}

void main() {
  group('who is allowed to dispatch', () {
    testWidgets('the keyboard cannot; the button can', (tester) async {
      final sent = <String>[];
      await pumpComposer(tester, onSend: (text) async {
        sent.add(text);
        return true;
      });

      await tester.enterText(find.byType(TextField), 'halo');
      await tester.pump();

      // The return key is the operator asking for a line, not for a dispatch. On a
      // phone there is no Shift+Enter to tell the two apart, so the key never sends.
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pump();
      expect(sent, isEmpty,
          reason: 'pressing return dispatched — the keyboard is still the send button');

      await tester.tap(find.byType(SendButton));
      await tester.pump();
      expect(sent, ['halo']);
    });

  });

  group('how far the field grows', () {
    /// The field's own height with [lines] lines of draft in it.
    Future<double> heightAt(WidgetTester tester, int lines) async {
      await tester.enterText(
          find.byType(TextField), List.filled(lines, 'x').join('\n'));
      await tester.pump();
      return tester.getSize(find.byType(TextField)).height;
    }

    testWidgets('it does not stop at four', (tester) async {
      await pumpComposer(tester);

      final four = await heightAt(tester, 4);
      final six = await heightAt(tester, 6);

      // Now that a line can be typed, a cap of four turns a paragraph into a peephole:
      // the text scrolls away with nothing on screen saying it is there.
      expect(six, greaterThan(four),
          reason: 'the sixth line is hidden behind a cap of four');
    });

    testWidgets('it stops before it eats the transcript', (tester) async {
      await pumpComposer(tester);

      final cap = await heightAt(tester, kComposerMaxLines);
      // Two past the cap, and deliberately short of [kPasteHeldAt]: a longer block would
      // be taken away as a paste and this would end up measuring an empty field, which is
      // the same number for an entirely different reason.
      final past = await heightAt(tester, kComposerMaxLines + 2);

      expect(find.byType(HeldPaste), findsNothing,
          reason: 'the draft was held as a paste, so this measures nothing about growth');
      expect(past, cap,
          reason: 'the field keeps growing, so a long draft pushes the reply off screen');
    });

  });

  group('the way out of a small field', () {
    testWidgets('the control waits until the draft has outgrown the field',
        (tester) async {
      await pumpComposer(tester);

      await tester.enterText(find.byType(TextField), 'satu\ndua');
      await tester.pump();
      expect(find.byType(ExpandDraftButton), findsNothing,
          reason: 'a two-line draft fits, so the way out is a control with nothing to do');

      await tester.enterText(find.byType(TextField), 'satu\ndua\ntiga\nempat');
      await tester.pump();
      expect(find.byType(ExpandDraftButton), findsOneWidget);
    });

    testWidgets('taking it carries the draft onto the whole screen', (tester) async {
      await pumpComposer(tester);
      await tester.enterText(find.byType(TextField), 'satu\ndua\ntiga\nempat');
      await tester.pump();

      await tester.tap(find.byType(ExpandDraftButton));
      await tester.pumpAndSettle();

      // Same words, same caret, a bigger surface. Nothing is retyped and nothing is
      // re-read: the editor writes into the field the composer already had.
      expect(find.byType(DraftEditor), findsOneWidget);
      expect(find.text('satu\ndua\ntiga\nempat'), findsOneWidget);
    });

    testWidgets('sending from up there dispatches and comes back down',
        (tester) async {
      final sent = <String>[];
      await pumpComposer(tester, onSend: (text) async {
        sent.add(text);
        return true;
      });
      await tester.enterText(find.byType(TextField), 'satu\ndua\ntiga\nempat');
      await tester.pump();
      await tester.tap(find.byType(ExpandDraftButton));
      await tester.pumpAndSettle();

      await tester.tap(find.text('Kirim'));
      await tester.pumpAndSettle();

      expect(sent, ['satu\ndua\ntiga\nempat']);
      expect(find.byType(DraftEditor), findsNothing,
          reason: 'the editor stayed up over a field it had just emptied');
    });

    testWidgets('leaving it keeps every word', (tester) async {
      await pumpComposer(tester);
      await tester.enterText(find.byType(TextField), 'satu\ndua\ntiga\nempat');
      await tester.pump();
      await tester.tap(find.byType(ExpandDraftButton));
      await tester.pumpAndSettle();

      await tester.enterText(
          find.byType(TextField), 'satu\ndua\ntiga\nempat\nlima');
      await tester.pump();
      await tester.tap(find.byType(CollapseDraftButton));
      await tester.pumpAndSettle();

      // No save, because there was never a second copy: the editor and the composer are
      // two views of one controller.
      expect(find.byType(DraftEditor), findsNothing);
      expect(find.text('satu\ndua\ntiga\nempat\nlima'), findsOneWidget);
    });
  });

  group('a long paste', () {
    /// A log the length of the thing an operator actually pastes from a phone.
    String log(int lines) =>
        List.generate(lines, (i) => '[rate] target 12000 kbps · actual ${4000 + i}').join('\n');

    testWidgets('is held, not poured into the field', (tester) async {
      final controller = TextEditingController();
      addTearDown(controller.dispose);
      await pumpComposer(tester, controller: controller);

      await tester.enterText(find.byType(TextField), log(48));
      await tester.pump();

      // Forty-eight lines in the composer is not a draft, it is a wall with a keyboard
      // under it. Held instead: one object, one line saying how big it is.
      expect(find.byType(HeldPaste), findsOneWidget);
      expect(controller.text, isEmpty,
          reason: 'the paste filled the field the message was supposed to go in');
    });

    testWidgets('goes with the message when it is sent', (tester) async {
      final sent = <String>[];
      await pumpComposer(tester, onSend: (text) async {
        sent.add(text);
        return true;
      });

      await tester.enterText(find.byType(TextField), log(48));
      await tester.pump();
      await tester.enterText(find.byType(TextField), 'ini lognya');
      await tester.pump();
      await tester.tap(find.byType(SendButton));
      await tester.pump();

      // Held is not dropped: the block and the sentence about it are one dispatch, block
      // first, because the sentence is written *about* something the agent has not read.
      expect(sent.single, '${log(48)}\n\nini lognya');
      expect(find.byType(HeldPaste), findsNothing,
          reason: 'the block stayed attached to the next message too');
    });

    testWidgets('alone, with nothing typed, is still worth sending', (tester) async {
      final sent = <String>[];
      await pumpComposer(tester, onSend: (text) async {
        sent.add(text);
        return true;
      });

      await tester.enterText(find.byType(TextField), log(48));
      await tester.pump();
      await tester.tap(find.byType(SendButton));
      await tester.pump();

      // Pasting a log and pressing send is a complete thing to say. The button has to be
      // live on the strength of the block alone, or the operator is made to type a word
      // they do not have.
      expect(sent.single, log(48));
    });

    testWidgets('can be dropped whole', (tester) async {
      await pumpComposer(tester);
      await tester.enterText(find.byType(TextField), log(48));
      await tester.pump();

      await tester.tap(find.text('✕'));
      await tester.pump();

      expect(find.byType(HeldPaste), findsNothing);
    });

  });

  group('where the send button sits', () {
    testWidgets('it rides the bottom of a tall field, not its middle',
        (tester) async {
      await pumpComposer(tester);
      await tester.enterText(
          find.byType(TextField), List.filled(6, 'x').join('\n'));
      await tester.pump();

      final field = tester.getRect(find.byType(TextField));
      final send = tester.getRect(find.byType(SendButton));

      // Centred, it floats beside the middle of a paragraph with nothing to do with the
      // line the thumb is on.
      expect(send.center.dy, greaterThan(field.center.dy),
          reason: 'the button is still centred against a six-line draft');
    });
  });

  group('the capsule (v4 tiket 09)', () {
    testWidgets('a filled box with a 22px corner, send a 36px circle inside a 44px target',
        (tester) async {
      await pumpComposer(tester);

      final box = tester.widget<Container>(find.descendant(
          of: find.byType(ComposerBox), matching: find.byType(Container)).first);
      final shape = box.decoration! as BoxDecoration;
      expect(shape.borderRadius, BorderRadius.circular(22));
      expect(shape.color, isNotNull);

      expect(tester.getSize(find.byType(SendButton)), const Size(44, 44));
      final mark = tester.widget<AnimatedContainer>(find.descendant(
          of: find.byType(SendButton), matching: find.byType(AnimatedContainer)));
      expect((mark.decoration! as BoxDecoration).shape, BoxShape.circle);
      expect(mark.constraints, const BoxConstraints.tightFor(width: 36, height: 36));
    });

    testWidgets('send sits beside the field, in the box, not on a row of its own',
        (tester) async {
      await pumpComposer(tester);

      final field = tester.getRect(find.byType(TextField));
      final send = tester.getRect(find.byType(SendButton));
      expect(send.left, greaterThan(field.right));
      expect(send.top, lessThan(field.bottom));
      expect(find.descendant(of: find.byType(ComposerBox), matching: find.byType(SendButton)),
          findsOne);
    });

    testWidgets('the line underneath carries what the page hands in, under the box',
        (tester) async {
      await pumpComposer(tester, about: const Text('Lotus'));

      expect(tester.getRect(find.text('Lotus')).top,
          greaterThanOrEqualTo(tester.getRect(find.byType(ComposerBox)).bottom));
    });

    testWidgets('with nothing to say, there is no line underneath', (tester) async {
      await pumpComposer(tester);

      final composer = tester.getRect(find.byType(Composer));
      final box = tester.getRect(find.byType(ComposerBox));
      // Only the composer's own bottom inset is left below the box.
      expect(composer.bottom - box.bottom, lessThanOrEqualTo(10));
    });
  });
}
