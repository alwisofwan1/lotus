import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/data/dictation.dart';
import 'package:lotus_pocket/features/shared/dictation_row.dart';

/// The bar while it is listening.
///
/// Everything here is about the trace filling the space it is given. A fixed bar count
/// left a third of the pill empty on a real phone — dead width that reads as a layout
/// nobody finished, which is exactly what it was.
void main() {
  /// Renders the row at [width] and feeds it [samples] loudness readings, the way the
  /// recorder would at roughly 8 per second.
  Future<int> barsAt(WidgetTester tester, double width, {int samples = 40}) async {
    var elapsed = Duration.zero;

    Future<void> pumpWith(double level) async {
      elapsed += const Duration(milliseconds: 120);
      await tester.pumpWidget(MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: width,
              child: DictationRow(
                state: DictationRecording(elapsed: elapsed, level: level),
                onCancel: () {},
                onStop: () {},
              ),
            ),
          ),
        ),
      ));
      await tester.pump(const Duration(milliseconds: 150));
    }

    for (var i = 0; i < samples; i++) {
      await pumpWith(0.2 + (i % 5) * 0.15);
    }
    return tester.widgetList(find.byType(AnimatedContainer)).length;
  }

  testWidgets('a wider bar carries more of the trace, not more empty space',
      (tester) async {
    final narrow = await barsAt(tester, 260);
    final wide = await barsAt(tester, 420);

    expect(wide, greaterThan(narrow),
        reason: 'the trace is sized to the width, not to a number chosen once');
    expect(narrow, greaterThan(0));
  });

  testWidgets('history is capped, so a long recording does not grow without end',
      (tester) async {
    // Far more samples than any phone shows. The buffer keeps 64; a screen wide enough
    // to draw them all does not exist, so the count stays bounded by what fits.
    final bars = await barsAt(tester, 380, samples: 300);

    expect(bars, lessThanOrEqualTo(64));
  });

  testWidgets('the elapsed clock is on screen while listening', (tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(
        body: DictationRow(
          state: const DictationRecording(elapsed: Duration(seconds: 67), level: 0.5),
          onCancel: () {},
          onStop: () {},
        ),
      ),
    ));
    await tester.pump(const Duration(milliseconds: 150));

    expect(find.text('1:07'), findsOne);
  });

  testWidgets('transcribing replaces the trace rather than freezing it', (tester) async {
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: Scaffold(
        body: DictationRow(
          state: const DictationTranscribing(),
          onCancel: () {},
          onStop: () {},
        ),
      ),
    ));
    await tester.pump();

    // A waveform left standing while the audio is already gone would be claiming to
    // hear something. The row says what it is doing instead.
    expect(find.text('transcribing'), findsOne);
    expect(find.byType(AnimatedContainer), findsNothing);
  });
}
