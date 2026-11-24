import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/splash_gate.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/shared/lotus_mark.dart';

/// What the gate hands over to. A key, so a test can say which side is up.
const beyond = Key('beyond');

Widget harness({Duration? hold}) => MaterialApp(
      theme: buildAppTheme(),
      home: SplashGate(
        line: '2 machines · dialing',
        hold: hold ?? SplashGate.defaultHold,
        builder: (_) => const SizedBox(key: beyond),
      ),
    );

bool showsSplash(WidgetTester tester) => tester.any(find.text('LOTUS'));

bool showsBeyond(WidgetTester tester) => tester.any(find.byKey(beyond));

void main() {
  testWidgets('the splash holds long enough to be seen', (tester) async {
    await tester.pumpWidget(harness());

    await tester.pump(const Duration(milliseconds: 300));
    expect(showsSplash(tester), isTrue,
        reason: 'below ~450 ms a splash reads as a flicker, which is worse than none');
    expect(showsBeyond(tester), isFalse);
  });

  testWidgets('it opens on its own clock, with nothing to wait for', (tester) async {
    // The rule this file exists for. `main()` deliberately does not await
    // `root.start()` — a sleeping host retries for as long as it stays asleep, and
    // holding the first frame for it puts the whole screen behind the slowest
    // machine (R-11). The gate cannot break that, because it takes no future: the
    // only input it has is a duration.
    await tester.pumpWidget(harness());

    await tester.pump(SplashGate.defaultHold);
    await tester.pump(const Duration(milliseconds: 250)); // the cross-fade

    expect(showsBeyond(tester), isTrue);
    expect(showsSplash(tester), isFalse);
  });

  testWidgets('the screen beyond is built once the gate opens, not before',
      (tester) async {
    var built = 0;
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: SplashGate(
        line: 'no machine paired',
        hold: const Duration(milliseconds: 300),
        builder: (_) {
          built += 1;
          return const SizedBox(key: beyond);
        },
      ),
    ));

    await tester.pump(const Duration(milliseconds: 100));
    expect(built, 0, reason: 'the index subscribes to the fleet; it should not do that twice');

    await tester.pump(const Duration(milliseconds: 300));
    expect(built, 1);
  });

  testWidgets('leaving before the gate opens cancels its timer', (tester) async {
    await tester.pumpWidget(harness());
    await tester.pump(const Duration(milliseconds: 100));

    await tester.pumpWidget(const MaterialApp(home: SizedBox()));

    // No assertion of its own: `testWidgets` fails if a timer outlives the widget
    // that scheduled it, and on the launch path that lands as a crash on the only
    // screen there is.
    await tester.pump(const Duration(seconds: 2));
  });

  testWidgets('the status line is drawn, and is the only text that varies',
      (tester) async {
    await tester.pumpWidget(harness());
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('2 machines · dialing'), findsOneWidget);
    expect(find.text('LOTUS'), findsOneWidget);
  });

  testWidgets('the mark sits on the screen centre, not on the column centre',
      (tester) async {
    // The platform SplashScreen draws the launcher icon — the same mark — dead centre
    // and then cross-fades to this screen. Sharing a Column with the wordmark lifted
    // the mark by half a line of type, and the two marks passed each other as a
    // visible double exposure. Caught on a screen recording; both layouts looked
    // right in isolation, which is why it is pinned here.
    await tester.pumpWidget(harness());
    await tester.pump(const Duration(milliseconds: 100));

    final screen = tester.getRect(find.byType(Scaffold).first);
    final mark = tester.getRect(find.byType(LotusMark));

    expect(mark.center.dx, moreOrLessEquals(screen.center.dx, epsilon: 0.5));
    expect(mark.center.dy, moreOrLessEquals(screen.center.dy, epsilon: 0.5));
    // And the wordmark is below it rather than displacing it.
    expect(tester.getRect(find.text('LOTUS')).top, greaterThan(mark.bottom));
  });
}
