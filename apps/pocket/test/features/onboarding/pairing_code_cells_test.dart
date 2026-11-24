import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/features/onboarding/widgets/pairing_code_cells.dart';

/// The cells are a drawing of one hidden field, so most of what is checked here is the
/// field's value — what the host will receive — and the few states the drawing adds.
void main() {
  late TextEditingController code;
  late int filled;

  setUp(() {
    code = TextEditingController();
    filled = 0;
  });

  Widget cells({bool refused = false, bool enabled = true, bool still = false}) => MaterialApp(
        theme: buildAppTheme(),
        home: MediaQuery(
          data: MediaQueryData(size: const Size(390, 800), disableAnimations: still),
          child: Scaffold(
            body: Padding(
              padding: const EdgeInsets.all(20),
              child: PairingCodeCells(
                label: 'Pairing code',
                controller: code,
                refused: refused,
                enabled: enabled,
                onFilled: () => filled += 1,
              ),
            ),
          ),
        ),
      );

  Finder field() => find.byType(TextField);

  /// Not `pumpAndSettle`: a focused field blinks its caret for as long as it is focused.
  Future<void> settle(WidgetTester tester) => tester.pump(const Duration(milliseconds: 600));

  /// Types at the end of what is there, the way a keyboard does — `enterText` would
  /// replace the whole value and hide the difference between appending and replacing.
  Future<void> append(WidgetTester tester, String typed) async {
    final next = code.text + typed;
    tester.testTextInput.updateEditingValue(
      TextEditingValue(text: next, selection: TextSelection.collapsed(offset: next.length)),
    );
    await settle(tester);
  }

  /// Cells drawn in the error colour. Eight after a refusal, none otherwise.
  int redCells(WidgetTester tester) {
    final error = tester.element(field()).tokens.error;
    return tester
        .widgetList<AnimatedContainer>(find.byType(AnimatedContainer))
        .where((c) => (c.decoration as BoxDecoration?)?.border == Border.all(color: error))
        .length;
  }

  double shakeOffset(WidgetTester tester) => tester
      .widgetList<Transform>(find.byType(Transform))
      .map((t) => t.transform.getTranslation().x.abs())
      .fold(0, (a, b) => a > b ? a : b);

  testWidgets('draws each digit in its own cell', (tester) async {
    await tester.pumpWidget(cells());
    await tester.enterText(field(), '12345678');
    await settle(tester);

    for (final d in '12345678'.split('')) {
      expect(find.descendant(of: find.byType(AnimatedSwitcher), matching: find.text(d)), findsOne);
    }
  });

  testWidgets('takes the code the way the desktop prints it', (tester) async {
    await tester.pumpWidget(cells());

    for (final printed in ['1234 5678', '1234-5678', ' 12345678 ']) {
      await tester.enterText(field(), printed);
      await settle(tester);
      expect(code.text, '12345678', reason: printed);
    }
  });

  testWidgets('stops at eight digits', (tester) async {
    await tester.pumpWidget(cells());
    await tester.enterText(field(), '12345678');
    await append(tester, '9');

    expect(code.text, '12345678');
  });

  testWidgets('reports a typed code complete once, and a scanned one not at all',
      (tester) async {
    await tester.pumpWidget(cells());
    await tester.enterText(field(), '1234567');
    expect(filled, 0);
    await append(tester, '8');
    expect(filled, 1);

    // A scan writes the controller and submits on its own; moving focus under it
    // would be a second actor on the same moment.
    code.text = '87654321';
    await settle(tester);
    expect(filled, 1);
  });

  group('a refused code', () {
    Future<void> refuse(WidgetTester tester, {bool still = false}) async {
      await tester.pumpWidget(cells(still: still));
      await tester.enterText(field(), '12345678');
      await settle(tester);
      await tester.pumpWidget(cells(refused: true, still: still));
    }

    testWidgets('shakes once and turns every cell red', (tester) async {
      await refuse(tester);
      var widest = 0.0;
      for (var i = 0; i < 25; i++) {
        await tester.pump(const Duration(milliseconds: 20));
        widest = widest > shakeOffset(tester) ? widest : shakeOffset(tester);
      }
      expect(widest, greaterThan(5));

      await settle(tester);
      expect(shakeOffset(tester), 0);
      expect(redCells(tester), 8);
    });

    testWidgets('holds still under reduced motion, and is still red', (tester) async {
      await refuse(tester, still: true);
      for (var i = 0; i < 25; i++) {
        await tester.pump(const Duration(milliseconds: 20));
        expect(shakeOffset(tester), 0);
      }
      expect(redCells(tester), 8);
    });

    testWidgets('stays readable until the next edit', (tester) async {
      await refuse(tester);
      await settle(tester);

      // Planes clears after 600ms; this code is kept so it can be read against the
      // desktop's.
      expect(code.text, '12345678');
    });

    testWidgets('the next keystroke starts a new code', (tester) async {
      await refuse(tester);
      await settle(tester);
      await tester.showKeyboard(field());

      await append(tester, '9');

      expect(code.text, '9');
      expect(redCells(tester), 0);
    });

    testWidgets('a paste replaces the dead code whole', (tester) async {
      await refuse(tester);
      await settle(tester);
      await tester.showKeyboard(field());

      await append(tester, '8765 4321');

      expect(code.text, '87654321');
    });

    testWidgets('a deletion empties it', (tester) async {
      await refuse(tester);
      await settle(tester);
      await tester.showKeyboard(field());

      tester.testTextInput.updateEditingValue(
        const TextEditingValue(text: '1234567', selection: TextSelection.collapsed(offset: 7)),
      );
      await settle(tester);

      expect(code.text, '');
    });

    testWidgets('only after the refusal: an edit before it is an ordinary edit',
        (tester) async {
      await tester.pumpWidget(cells());
      await tester.enterText(field(), '1234');
      await append(tester, '5');

      expect(code.text, '12345');
    });
  });

  testWidgets('cannot be typed into while a pairing is in flight', (tester) async {
    await tester.pumpWidget(cells(enabled: false));

    expect(tester.widget<TextField>(field()).enabled, isFalse);
  });

  testWidgets('offers the keyboard a one-time code to autofill', (tester) async {
    await tester.pumpWidget(cells());

    final f = tester.widget<TextField>(field());
    expect(f.autofillHints, contains(AutofillHints.oneTimeCode));
    expect(f.keyboardType, TextInputType.number);
  });
}
