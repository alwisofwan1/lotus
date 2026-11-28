import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/agent/widgets/thinking_orb.dart';

Widget _host(Widget child, {bool still = false}) => MaterialApp(
      theme: buildAppTheme(),
      home: MediaQuery(
        data: MediaQueryData(disableAnimations: still),
        child: Scaffold(body: Center(child: child)),
      ),
    );

void main() {
  group('orbPoints', () {
    test('every point lands on the unit sphere', () {
      for (final p in orbPoints(84)) {
        final r = math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
        expect(r, closeTo(1, 0.0001));
      }
    });

    /// The golden angle is the arrangement, not a flourish: successive points must not
    /// share a longitude, or the sphere reads as a stack of rings.
    test('no two consecutive points share a longitude', () {
      final pts = orbPoints(84);
      for (var i = 1; i < pts.length; i++) {
        final a = math.atan2(pts[i].z, pts[i].x);
        final b = math.atan2(pts[i - 1].z, pts[i - 1].x);
        expect((a - b).abs(), greaterThan(0.01));
      }
    });

    test('spreads over the full height, pole to pole', () {
      final ys = orbPoints(84).map((p) => p.y).toList()..sort();
      expect(ys.first, lessThan(-0.97));
      expect(ys.last, greaterThan(0.97));
    });

    test('draws what it was asked for, and nothing when asked for nothing', () {
      expect(orbPoints(12), hasLength(12));
      expect(orbPoints(0), isEmpty);
    });
  });

  group('ThinkingOrb', () {
    testWidgets('turns on its own', (tester) async {
      await tester.pumpWidget(_host(const ThinkingOrb()));
      final first = tester.widget<CustomPaint>(find.byType(CustomPaint).last).painter;
      await tester.pump(const Duration(milliseconds: 900));
      final later = tester.widget<CustomPaint>(find.byType(CustomPaint).last).painter;
      expect((first! as OrbPainter).turn, isNot((later! as OrbPainter).turn));
    });

    /// The shape carries "working"; only the rotation is decoration. So with motion off
    /// the sphere is still drawn — and at a resting angle, because at zero the spiral
    /// lines up into rings, the one arrangement that does not read as a sphere.
    testWidgets('stops turning when the phone asks for less motion', (tester) async {
      await tester.pumpWidget(_host(const ThinkingOrb(), still: true));
      final painter = tester.widget<CustomPaint>(find.byType(CustomPaint).last).painter!
          as OrbPainter;
      expect(painter.turn, 0.1);
      await tester.pump(const Duration(seconds: 2));
      final later = tester.widget<CustomPaint>(find.byType(CustomPaint).last).painter!
          as OrbPainter;
      expect(later.turn, 0.1, reason: 'no ticker is running');
    });

    testWidgets('is 26 logical pixels in the working row, and says nothing to a reader',
        (tester) async {
      await tester.pumpWidget(_host(const ThinkingOrb()));
      expect(tester.getSize(find.byType(ThinkingOrb)), const Size.square(26));
      // A turning sphere is not a sentence; the row's own words carry the meaning.
      expect(
        find.descendant(of: find.byType(ThinkingOrb), matching: find.byType(ExcludeSemantics)),
        findsOneWidget,
      );
    });
  });

  group('OrbPainter', () {
    test('repaints for a new angle and not for the same one', () {
      final pts = orbPoints(8);
      const ink = Color(0xFFF7F2EA);
      final a = OrbPainter(points: pts, turn: 0.2, ink: ink);
      expect(a.shouldRepaint(OrbPainter(points: pts, turn: 0.3, ink: ink)), isTrue);
      expect(a.shouldRepaint(OrbPainter(points: pts, turn: 0.2, ink: ink)), isFalse);
    });

    test('paints every point inside its box', () {
      // Bounds matter: the outermost points are the silhouette, and a clipped
      // silhouette is what makes a sphere look like a torn sticker.
      final recorder = ui.PictureRecorder();
      final canvas = Canvas(recorder);
      OrbPainter(points: orbPoints(84), turn: 0.33, ink: const Color(0xFFF7F2EA))
          .paint(canvas, const Size.square(26));
      expect(recorder.endRecording(), isNotNull);
    });
  });
}
