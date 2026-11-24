import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/features/onboarding/intro_pages.dart';
import 'package:lotus_pocket/features/onboarding/widgets/intro_pane.dart';

void main() {
  late int done;

  Future<void> pumpIntro(WidgetTester tester) async {
    done = 0;
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: IntroPages(onDone: () => done += 1),
    ));
  }

  testWidgets('it opens on what Pocket is, before asking for anything', (tester) async {
    await pumpIntro(tester);

    expect(find.textContaining('remote control'), findsOneWidget);
    // Nothing is being collected here. An intro that asked for something would delay
    // the only thing the operator came to do.
    expect(find.byType(TextField), findsNothing);
  });

  testWidgets('Continue walks all three panes and then finishes', (tester) async {
    await pumpIntro(tester);

    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(find.textContaining('need to be true'), findsOneWidget);

    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    expect(find.textContaining('waiting on you'), findsOneWidget);

    // The last pane names what happens next rather than saying Continue again.
    await tester.tap(find.text('Pair a machine'));
    await tester.pump();
    expect(done, 1);
  });

  testWidgets('Skip finishes from any pane', (tester) async {
    await pumpIntro(tester);
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();

    await tester.tap(find.text('Skip'));
    await tester.pump();

    expect(done, 1, reason: 'skipping is an answer, and it is the same answer');
  });

  testWidgets('Skip is gone on the last pane, where it would be the same tap twice',
      (tester) async {
    await pumpIntro(tester);
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();

    expect(find.text('Skip'), findsNothing);
    expect(find.text('Pair a machine'), findsOneWidget);
  });

  testWidgets('the pane about the fingerprint gate arrives before the first prompt does',
      (tester) async {
    // ADR-8 gates every mutation behind biometrics. Today that sheet appears on the
    // first dispatch with nothing having mentioned it, which reads as the app asking
    // for a fingerprint out of nowhere.
    await pumpIntro(tester);
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();

    expect(find.textContaining('fingerprint'), findsOneWidget);
    expect(find.textContaining('camera', findRichText: true), findsWidgets);
  });

  testWidgets('amber is spent only on the row that is explaining amber', (tester) async {
    await pumpIntro(tester);
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();

    final tokens = buildAppTheme().extension<AppTokens>()!;
    final amber = tester
        .widgetList<DecoratedBox>(find.byType(DecoratedBox))
        .where((d) => (d.decoration as BoxDecoration).color == tokens.waiting);

    // Exactly one. This is the single screen in the app where amber appears without
    // an agent actually waiting — it is being defined here, not reported — and one
    // more would turn the explanation into the decoration it forbids.
    expect(amber.length, 1);
  });

  testWidgets('every control clears the minimum hit target', (tester) async {
    await pumpIntro(tester);

    for (final label in ['Continue', 'Skip']) {
      final size = tester.getSize(find.ancestor(
        of: find.text(label),
        matching: find.byType(InkWell),
      ).first);
      expect(size.height, greaterThanOrEqualTo(kMinHitTarget));
    }
  });

  testWidgets('the second pane counts the rows it actually has', (tester) async {
    // It said "Two things need to be true" over three rows for one afternoon. A
    // number in a heading is a claim about the list under it, and nothing else in
    // this file was checking it.
    await pumpIntro(tester);
    await tester.tap(find.text('Continue'));
    await tester.pumpAndSettle();

    const words = {1: 'One', 2: 'Two', 3: 'Three', 4: 'Four'};
    final rows = tester.widgetList<IntroRow>(find.byType(IntroRow)).length;

    expect(find.textContaining('${words[rows]} things need to be true'), findsOneWidget);
  });
}
