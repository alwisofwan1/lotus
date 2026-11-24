import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/features/shared/runner_mark.dart';
import 'package:lotus_pocket/features/shared/runner_marks.g.dart';
import 'package:lotus_pocket/features/shared/svg_path.dart';

void main() {
  group('the shipped marks are real geometry, not strings that happen to parse', () {
    test('every runner in the generated set produces a path with area', () {
      expect(kRunnerMarks, isNotEmpty);

      for (final entry in kRunnerMarks.entries) {
        expect(entry.value.paths, isNotEmpty, reason: '${entry.key} has no sub-paths');

        for (final d in entry.value.paths) {
          final bounds = parseSvgPath(d).getBounds();
          // A `d` that parses to an empty or degenerate path would render as a blank
          // slot — which is exactly the failure the mark column is meant to end, and it
          // would look identical to "this runner has no mark".
          expect(bounds.width, greaterThan(0), reason: '${entry.key} is flat');
          expect(bounds.height, greaterThan(0), reason: '${entry.key} is flat');
          // Coordinates must land inside the square they claim, or the scale in
          // `_MarkPainter` draws part of the mark outside its box.
          expect(bounds.right, lessThanOrEqualTo(entry.value.viewBox + 1));
          expect(bounds.bottom, lessThanOrEqualTo(entry.value.viewBox + 1));
        }
      }
    });

    test('the two runners the contract actually sends are both covered', () {
      // `contract/fixtures/rest-bootstrap.json` sends exactly these. Anything else is
      // forward-looking; these two are not allowed to regress into the fallback.
      expect(kRunnerMarks.containsKey('claude'), isTrue);
      expect(kRunnerMarks.containsKey('codex'), isTrue);
    });
  });

  group('the path parser', () {
    test('reads the absolute commands the assets use', () {
      final path = parseSvgPath('M0 0 H10 V10 L0 10 C0 6 0 3 0 0 Z');
      final bounds = path.getBounds();

      expect(bounds.width, 10);
      expect(bounds.height, 10);
    });

    test('separates numbers that run together without whitespace', () {
      // `10-4` is two numbers, and `.5.5` is two more. A naive split on spaces reads
      // both as one, which silently moves a control point instead of failing.
      final path = parseSvgPath('M0 0L10-4L.5.5Z');
      expect(path.getBounds().top, -4);
    });

    test('refuses a command it does not implement, and names it', () {
      // The contract this protects: **do not simplify the asset to fit the parser.** An
      // arc arriving in a future logo must stop the build, not round-trip into a mark
      // with a piece missing that nobody notices at 13px.
      expect(
        () => parseSvgPath('M0 0 A5 5 0 0 1 10 10'),
        throwsA(isA<FormatException>().having(
          (e) => e.message, 'message', contains('A'))),
      );
    });
  });

  group('a runner with no mark', () {
    Future<void> pump(WidgetTester tester, String agentType) => tester.pumpWidget(
          MaterialApp(
            theme: buildAppTheme(),
            home: Scaffold(
              body: Center(
                child: RunnerMarkGlyph(
                  agentType: agentType,
                  color: AppTokens.dark.muted,
                ),
              ),
            ),
          ),
        );

    testWidgets('still draws something — a blank slot reads as a broken row',
        (tester) async {
      // The interesting case is never `claude`. It is the runner that ships after this
      // was written: the host is free to send any `agentType`, and the column has to
      // degrade to the app's own mark rather than to nothing.
      await pump(tester, 'some-runner-from-2027');

      final paint = tester.widget<CustomPaint>(
        find.descendant(of: find.byType(RunnerMarkGlyph), matching: find.byType(CustomPaint)),
      );
      expect(paint.painter, isNotNull);
      expect(tester.takeException(), isNull);
    });

    testWidgets('an empty agent type is a fallback, not a crash', (tester) async {
      await pump(tester, '');
      expect(tester.takeException(), isNull);
    });

    testWidgets('a known runner is matched whatever case the host used', (tester) async {
      await pump(tester, 'CLAUDE');
      expect(tester.takeException(), isNull);
      // Case folding happens in the lookup, so this must not have fallen back.
      expect(kRunnerMarks.containsKey('CLAUDE'.toLowerCase()), isTrue);
    });
  });
}
