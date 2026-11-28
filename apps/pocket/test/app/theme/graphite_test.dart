import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/invariants/contrast.dart';
import 'package:lotus_pocket/app/theme/registry.dart';
import 'package:lotus_pocket/app/theme/theme.dart';

/// Graphite & Paper: the default look. The invariant suite already runs over it; these
/// pin what makes it Graphite and the three colours re-solved for WCAG AA.
void main() {
  final graphite = themeById('graphite');

  test('is registered beside classic and is the default', () {
    expect(themeRegistry.map((d) => d.id), containsAll(['classic', 'graphite']));
    expect(defaultThemeId, 'graphite');
    expect(themeById('no-such-theme').id, 'graphite');
  });

  test('ships a real light and a real dark, with no waivers', () {
    expect(graphite.light.brightness, Brightness.light);
    expect(graphite.dark.brightness, Brightness.dark);
    for (final v in graphite.variants) {
      expect(v.waivers, isEmpty);
    }
  });

  test('grounds are the mockup hexes', () {
    expect(graphite.dark.tokens.bg, const Color(0xFF121211));
    expect(graphite.light.tokens.bg, const Color(0xFFF5F3EF));
  });

  test('text3 is re-solved to AA on ground and raised, hue kept', () {
    for (final v in graphite.variants) {
      final t = v.tokens;
      final onRaised = Color.alphaBlend(t.raise, t.bg);
      expect(contrast(t.muted, t.bg), greaterThanOrEqualTo(4.5), reason: v.brightness.name);
      expect(contrast(t.muted, onRaised), greaterThanOrEqualTo(4.5), reason: v.brightness.name);
    }
    expect(graphite.dark.tokens.muted, const Color(0xFF868279)); // was #7C786F, 3.96:1
    expect(graphite.light.tokens.muted, const Color(0xFF736E69)); // was #85807A, 3.53:1
  });

  test('light amber is re-solved to AA on every surface, hue kept', () {
    final amber = graphite.light.tokens.waiting;
    expect(amber, const Color(0xFF8E5205)); // was #9A5A06, 4.16:1 on the pressed surface
    expect((oklch(amber).h - oklch(const Color(0xFF9A5A06)).h).abs(), lessThan(1.0));
  });

  test('UI is Geist and code is Geist Mono', () {
    for (final v in graphite.variants) {
      expect(v.tokens.ui.fontFamily, 'Geist');
      expect(v.tokens.mono.fontFamily, 'GeistMono');
    }
  });

  test('radii follow the 10 / 16 / 24 / pill scale', () {
    final s = graphite.dark.shape;
    expect(s[ShapeRole.chip], 10);
    expect(s[ShapeRole.card], 16);
    expect(s[ShapeRole.sheet], 24);
    expect(s[ShapeRole.pill], 999);
  });
}
