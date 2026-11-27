import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/registry.dart';
import 'package:lotus_pocket/app/theme/theme.dart';

/// Generic over each role enum, so a new role is covered without editing this file.
void main() {
  final v = themeRegistry.first.dark;
  const probe = Color(0xFF123456);

  group('AppColors is complete over ColorRole', () {
    final a = v.tokens.colors;
    for (final role in ColorRole.values) {
      test(role.name, () {
        final b = a.copyWith({role: probe});
        expect(b[role], probe);
        expect(b, isNot(a), reason: '== skips $role');
        expect(b.hashCode, isNot(a.hashCode), reason: 'hashCode skips $role');
        expect(a.lerp(b, 1)[role], probe, reason: 'lerp skips $role');
        expect(a.lerp(b, 0.5)[role], isNot(a[role]));
      });
    }

    test('a missing role is refused', () {
      expect(() => AppColors({ColorRole.ground: probe}), throwsArgumentError);
    });
  });

  group('AppType is complete over TypeRole', () {
    final a = v.tokens.fonts;
    for (final role in TypeRole.values) {
      test(role.name, () {
        final b = a.copyWith({role: const TextStyle(letterSpacing: 3)});
        expect(b, isNot(a));
        expect(b.hashCode, isNot(a.hashCode));
        expect(a.lerp(b, 1)[role].letterSpacing, 3);
      });
    }
  });

  group('TerminalPalette is complete over TermRole', () {
    final a = v.terminal;
    for (final role in TermRole.values) {
      test(role.name, () {
        final b = a.copyWith({role: probe});
        expect(b, isNot(a));
        expect(b.hashCode, isNot(a.hashCode));
        expect(a.lerp(b, 1)[role], probe);
      });
    }
    test('lerp(null) keeps itself', () => expect(a.lerp(null, 0.5), a));
  });

  group('AppShape and AppElevation are complete', () {
    for (final role in ShapeRole.values) {
      test('shape ${role.name}', () {
        final b = v.shape.copyWith({role: 1234});
        expect(b, isNot(v.shape));
        expect(b.hashCode, isNot(v.shape.hashCode));
        expect(v.shape.lerp(b, 1)[role], 1234);
      });
    }
    for (final role in ElevationRole.values) {
      test('elevation ${role.name}', () {
        final b = v.elevation.copyWith({role: 99});
        expect(b, isNot(v.elevation));
        expect(b.hashCode, isNot(v.elevation.hashCode));
        expect(v.elevation.lerp(b, 1)[role], 99);
      });
    }
  });

  group('AppTokens delegates to its parts', () {
    final t = v.tokens;
    test('equality follows colours and type', () {
      final c = t.copyWith(colors: t.colors.copyWith({ColorRole.live: probe}));
      expect(c, isNot(t));
      expect(c.hashCode, isNot(t.hashCode));
      expect(t.copyWith(), t);
    });
    test('lerp at the ends, and null', () {
      final other = t.copyWith(colors: t.colors.copyWith({ColorRole.ground: probe}));
      expect(t.lerp(other, 0), t);
      expect(t.lerp(other, 1), other);
      expect(t.lerp(null, 0.5), t);
    });
  });
}
