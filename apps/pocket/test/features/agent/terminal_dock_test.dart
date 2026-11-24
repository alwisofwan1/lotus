import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/features/agent/terminal_geometry.dart';
import 'package:lotus_pocket/features/agent/widgets/terminal_dock.dart';

/// The dock at the foot of Terminal while keys are off (v4 tiket 04, mockup B1).
///
/// Took over from `TerminalBar`, and so from `terminal_bar_test.dart`'s width rounds: the
/// fullest set must fit a 360dp phone, at text scale 1.3 and 2.0 too.
void main() {
  var typed = 0;
  var found = 0;
  var sessions = 0;

  Widget dock({double width = 390, bool keys = true, bool withSessions = false}) => MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(
          body: Align(
            alignment: Alignment.bottomCenter,
            child: SizedBox(
              width: width,
              child: TerminalDock(
                fit: TerminalFit.pinned,
                zoom: TerminalZoom.fit,
                geometry: const TerminalGeometry(columns: 120, rows: 38),
                fontSize: 12,
                onZoom: (_) {},
                onFontSize: (_) {},
                onFind: () => found++,
                onType: keys ? () => typed++ : null,
                onSessions: withSessions ? () => sessions++ : null,
              ),
            ),
          ),
        ),
      );

  Finder byLabel(String label) => find.descendant(
        of: find.bySemanticsLabel(label),
        matching: find.byType(InkWell),
      );

  setUp(() {
    typed = 0;
    found = 0;
    sessions = 0;
  });

  testWidgets('Sessions is a 48px square when the pager hands it a sheet (v4 tiket 08)',
      (tester) async {
    await tester.pumpWidget(dock());
    expect(find.bySemanticsLabel('Sessions'), findsNothing, reason: 'absent beats dead');

    await tester.pumpWidget(dock(withSessions: true));
    expect(tester.getSize(byLabel('Sessions')), const Size(48, 48));
    await tester.tap(byLabel('Sessions'));
    expect(sessions, 1);
  });

  testWidgets('a wide Type to session, 48px tall, naming the size it types into',
      (tester) async {
    await tester.pumpWidget(dock(width: 600));

    final type = byLabel('Type to session');
    expect(tester.getSize(type).height, 48);
    expect(find.text('Type to session'), findsOne);
    expect(find.text('FIXED WIDTH'), findsOne);

    await tester.tap(type);
    expect(typed, 1);
  });

  testWidgets('Find and Aa are 48px squares beside it', (tester) async {
    await tester.pumpWidget(dock());

    for (final label in ['Find in output', 'Text size and zoom']) {
      expect(tester.getSize(byLabel(label)), const Size(48, 48), reason: label);
    }
    await tester.tap(byLabel('Find in output'));
    expect(found, 1);
  });

  testWidgets('Aa holds the look, and only the look', (tester) async {
    await tester.pumpWidget(dock());
    expect(find.text('A+'), findsNothing);

    await tester.tap(byLabel('Text size and zoom'));
    await tester.pumpAndSettle();

    for (final label in ['FIT', '1:1', 'A−', 'A+']) {
      final control = find.widgetWithText(InkWell, label);
      expect(control, findsOne, reason: label);
      expect(tester.getSize(control).height, greaterThanOrEqualTo(kMinHitTarget), reason: label);
    }
    expect(find.text('{}'), findsNothing);
    expect(find.text('⤢'), findsNothing);
  });

  testWidgets('without keys there is no Type button, and the size is still stated',
      (tester) async {
    await tester.pumpWidget(dock(keys: false));

    expect(find.bySemanticsLabel('Type to session'), findsNothing);
    expect(find.text('FIXED WIDTH'), findsOne);
  });

  // Review, LOT2-104: `FIXED WIDTH` beside it halved the room, and the button read
  // `Type to s…` on an ordinary phone. The action keeps its words; the label gives way.
  // The test font is wider than a phone's, so the squeeze is reproduced at 430: room for
  // the words alone, not for the words and the label.
  testWidgets('Type to session is never cut short to show the size', (tester) async {
    await tester.pumpWidget(dock(width: 430));

    final title = tester.renderObject<RenderParagraph>(find.text('Type to session'));
    expect(title.didExceedMaxLines, isFalse);
    expect(find.text('FIXED WIDTH'), findsNothing, reason: 'the label is what gives way');
  });

  for (final scale in [1.0, 1.3, 2.0]) {
    testWidgets('the fullest set fits 360dp at text scale $scale', (tester) async {
      tester.platformDispatcher.textScaleFactorTestValue = scale;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);

      await tester.pumpWidget(dock(width: 360, withSessions: true));
      await tester.tap(byLabel('Text size and zoom'));
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
    });
  }
}
