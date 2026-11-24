import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';

/// Pins the token values to the mockups that own them, so a future edit there is caught
/// here rather than discovered by eye on a phone. Hex/alpha math is spelled out per
/// value — see the conversion note on each assertion — because a transposed alpha
/// digit is exactly the kind of error that survives a glance at rendered UI.
///
/// Two mockups, since 2026-08-11. `design/pocket-flow.html` (locked 2026-08-03) still owns
/// everything except the app floor; `design/revamp-ground.html` owns `bg`, `dim`, `muted`
/// and `faint`. The split is recorded in `AppTokens`' own doc together with the measurement
/// that forced it — the old floor was hue 284° against ink at 80°.
void main() {
  group('AppTokens.dark matches the locked mockup exactly', () {
    const t = AppTokens.dark;

    test('opaque colours', () {
      // revamp-ground.html: oklch(0.183 0.004 286°). Cool-neutral on purpose — the hue is
      // spent putting 158° between the field and `waiting`, not on matching `text`.
      expect(t.bg, const Color(0xFF121214));
      expect(t.text, const Color(0xFFF7F2EA)); // --d-text: #f7f2ea
      expect(t.waiting, const Color(0xFFFBBF24)); // --act: #fbbf24
      expect(t.error, const Color(0xFFF87171)); // --fail: #f87171
    });

    test('translucent whites, alpha = round(a * 255)', () {
      // --d-raise: rgba(245, 242, 239, 0.045) -> round(0.045*255)=11=0x0B
      expect(t.raise, const Color(0x0BF5F2EF));
      // All three are solved against `bg` rather than copied from a mockup's alpha, and
      // re-solved on 2026-08-11 when the floor moved. The contrast group below is what
      // actually pins them; these bytes only catch a transposed digit.
      expect(t.dim, const Color(0xA0F7F2EA)); // 7.06:1
      expect(t.muted, const Color(0x79F7F2EA)); // 4.52:1
      expect(t.faint, const Color(0x5AF7F2EA)); // 3.04:1
      // --d-line: rgba(245, 242, 239, 0.085) -> round(0.085*255)=22=0x16
      expect(t.line, const Color(0x16F5F2EF));
      // --d-line-str: rgba(245, 242, 239, 0.16) -> round(0.16*255)=41=0x29
      expect(t.lineStrong, const Color(0x29F5F2EF));
    });

    test('waiting and error share their hex with desktop\'s own status colours', () {
      // apps/desktop/src/styles/canvas/theme.css: --canvas-status-connecting /
      // --canvas-status-error. Not a coincidence to preserve silently — the mockup's
      // own comment calls these tokens "verbatim from src/styles/canvas/".
      expect(t.waiting, const Color(0xFFFBBF24));
      expect(t.error, const Color(0xFFF87171));
    });

    test('three distinct quiet-text levels, not one secondary colour', () {
      final levels = {t.dim, t.muted, t.faint};
      expect(levels, hasLength(3), reason: 'dim/muted/faint must not collapse to the same colour');
    });

    test('the quiet levels stay ordered — dim brighter than muted brighter than faint', () {
      // Guards the reassignment as much as the values: a future edit that lifts faint
      // past muted would leave call sites reading "quieter" while rendering brighter.
      expect(t.dim.a, greaterThan(t.muted.a));
      expect(t.muted.a, greaterThan(t.faint.a));
    });
  });

  /// What `PRODUCT.md` actually promises, measured rather than asserted by hex.
  ///
  /// Pinning the alpha bytes above catches an accidental edit; it cannot catch the
  /// thing that was wrong for months, which is that the pinned values were themselves
  /// below the bar. These compute the real WCAG 2.1 ratio against [AppTokens.bg], so
  /// the requirement is stated as the requirement.
  group('contrast against the app floor meets WCAG 2.1 AA', () {
    const t = AppTokens.dark;

    test('text roles clear 4.5:1', () {
      expect(_contrast(t.text, t.bg), greaterThanOrEqualTo(4.5));
      expect(_contrast(t.dim, t.bg), greaterThanOrEqualTo(4.5));
      // The one that was failing at 3.47:1 and carried row detail and summary copy.
      expect(_contrast(t.muted, t.bg), greaterThanOrEqualTo(4.5));
    });

    test('the two colours allowed to shout clear 4.5:1 as well', () {
      expect(_contrast(t.waiting, t.bg), greaterThanOrEqualTo(4.5));
      expect(_contrast(t.error, t.bg), greaterThanOrEqualTo(4.5));
    });

    test('faint clears 3:1 — the non-text bar, which is all it is now for', () {
      // WCAG 1.4.11. faint is ornament — pips, marks, disabled glyphs — and a call
      // site that puts a sentence in it is the bug this boundary exists to name.
      expect(_contrast(t.faint, t.bg), greaterThanOrEqualTo(3.0));
      // And it stays genuinely quieter than the text floor, or the demotion bought
      // nothing.
      expect(_contrast(t.faint, t.bg), lessThan(_contrast(t.muted, t.bg)));
    });
  });

  group('AppTokens.dark structural rules', () {
    const t = AppTokens.dark;

    test('two divider strengths, and the stronger one is actually stronger', () {
      expect(t.line, isNot(t.lineStrong));
      expect(t.lineStrong.a, greaterThan(t.line.a));
    });

    test('waiting and error are distinct from every quiet colour and from each other', () {
      final quiet = {t.text, t.dim, t.muted, t.faint};
      expect(quiet.contains(t.waiting), isFalse);
      expect(quiet.contains(t.error), isFalse);
      expect(t.waiting, isNot(t.error));
    });

    test('base type styles carry a fallback chain but no baked-in size or colour', () {
      // Sizes and colours vary per label (the mockup uses 9.5px through 21px on the
      // same --mono/--serif roles) — baking one in here would fight every call site.
      expect(t.mono.fontSize, isNull);
      expect(t.mono.color, isNull);
      expect(t.mono.fontFamilyFallback, isNotEmpty);

      expect(t.serif.fontSize, isNull);
      expect(t.serif.fontFamilyFallback, isNotEmpty);

      // --ui: system-ui, ... — the platform default the OS already resolves, so
      // there is deliberately nothing to override here.
      expect(t.ui.fontFamily, isNull);
    });
  });

  group('copyWith', () {
    test('overrides exactly the fields given', () {
      const base = AppTokens.dark;
      final changed = base.copyWith(waiting: const Color(0xFF00FF00));

      expect(changed.waiting, const Color(0xFF00FF00));
      expect(changed.bg, base.bg);
      expect(changed.text, base.text);
      expect(changed.error, base.error);
      expect(changed.mono, base.mono);
    });

    test('with nothing given, returns an equal instance', () {
      const base = AppTokens.dark;
      expect(base.copyWith(), base);
    });
  });

  group('lerp — what makes a future theme swap animate instead of snap', () {
    // A second, deliberately different fixture. Not a real theme — its only job is
    // to make every colour field distinguishable at t=0 vs t=1, so a field silently
    // left out of `lerp` fails this test rather than shipping as a visual glitch.
    //
    // The three type styles are copied unchanged from `AppTokens.dark`, not varied.
    // They are documented as carrying no size or colour by design, so a real second
    // theme has no legitimate reason to differ on them either — and varying them
    // here would test an edge case that cannot arise between two correctly-authored
    // themes: `TextStyle.lerp` does not hold a null `fontSize` at exactly t=0 when
    // the other side sets one (`dart:ui`'s `lerpDouble` treats a null side as `0.0`
    // before interpolating, not as "hold until t=1"). That is real, verified Flutter
    // behaviour, not a bug here — it just does not apply to fields both themes leave
    // unset.
    const other = AppTokens(
      bg: Color(0xFF000000),
      raise: Color(0x22000000),
      text: Color(0xFFFFFFFF),
      dim: Color(0xCCFFFFFF),
      muted: Color(0x88FFFFFF),
      faint: Color(0x44FFFFFF),
      line: Color(0x11FFFFFF),
      lineStrong: Color(0x33FFFFFF),
      waiting: Color(0xFF0000FF),
      error: Color(0xFF00FF00),
      live: Color(0xFF3FBF8F),
      // Same literals as `AppTokens.dark` — not a reference to it, since Dart's
      // const evaluator does not fold a field access on one const object into
      // another const expression here (`ThemeExtension<AppTokens>`'s self-referential
      // generic appears to be why). Repeating the literal is fine for a fixture whose
      // whole point is "two themes agree on this field".
      mono: TextStyle(fontFamilyFallback: ['Menlo', 'SF Mono', 'Consolas', 'monospace']),
      ui: TextStyle(),
      serif: TextStyle(fontFamilyFallback: ['Georgia', 'Palatino', 'serif']),
    );

    test('at t=0 the result matches the receiver', () {
      final result = AppTokens.dark.lerp(other, 0);
      expect(result, AppTokens.dark);
    });

    test('at t=1 the result matches the argument, field for field', () {
      final result = AppTokens.dark.lerp(other, 1);
      expect(result.bg, other.bg);
      expect(result.raise, other.raise);
      expect(result.text, other.text);
      expect(result.dim, other.dim);
      expect(result.muted, other.muted);
      expect(result.faint, other.faint);
      expect(result.line, other.line);
      expect(result.lineStrong, other.lineStrong);
      expect(result.waiting, other.waiting);
      expect(result.error, other.error);
      expect(result.mono.fontSize, other.mono.fontSize);
      expect(result.ui.fontSize, other.ui.fontSize);
      expect(result.serif.fontSize, other.serif.fontSize);
    });

    test('at t=0.5 every colour field has actually moved', () {
      final result = AppTokens.dark.lerp(other, 0.5);
      const base = AppTokens.dark;

      for (final pair in [
        (result.bg, base.bg),
        (result.text, base.text),
        (result.dim, base.dim),
        (result.muted, base.muted),
        (result.faint, base.faint),
        (result.line, base.line),
        (result.lineStrong, base.lineStrong),
        (result.waiting, base.waiting),
        (result.error, base.error),
      ]) {
        expect(pair.$1, isNot(pair.$2));
      }
    });

    test('handed null — a real case, not a hypothetical one — returns itself unchanged',
        () {
      // `ThemeData.lerp` calls exactly this when the *other* ThemeData has no
      // `AppTokens` at all: `a.extension<AppTokens>()?.lerp(b.extension<AppTokens>(),
      // t)`, and the second call is null. A genuinely foreign `ThemeExtension<Other>`
      // can never reach here in the first place — `lerp`'s own signature
      // (`ThemeExtension<AppTokens>?`) accepts only null or another `AppTokens`, and
      // `ThemeData` itself only ever pairs extensions of the same runtime type, keyed
      // by type. So null is the one branch of `if (other is! AppTokens)` that can
      // actually happen, and it is the one worth pinning.
      expect(AppTokens.dark.lerp(null, 0.5), AppTokens.dark);
    });
  });

  test('equality and hashCode are field-wise, so a test can assert without spelling out every field',
      () {
    const a = AppTokens.dark;
    const b = AppTokens.dark;
    final c = AppTokens.dark.copyWith(bg: const Color(0xFF123456));

    expect(a, b);
    expect(a.hashCode, b.hashCode);
    expect(a, isNot(c));
  });
}

/// WCAG 2.1 contrast ratio between a foreground and an opaque background.
///
/// [foreground] is composited over [background] first, which is not a detail here: every
/// quiet token in this file is a translucent white, so reading its channels directly
/// would measure a colour that never appears on screen.
double _contrast(Color foreground, Color background) {
  final composited = Color.alphaBlend(foreground, background);
  final a = _relativeLuminance(composited);
  final b = _relativeLuminance(background);
  final (lighter, darker) = a > b ? (a, b) : (b, a);
  return (lighter + 0.05) / (darker + 0.05);
}

/// Relative luminance, per WCAG 2.1's own definition. Expects an opaque colour.
double _relativeLuminance(Color color) {
  double channel(double value) =>
      value <= 0.03928 ? value / 12.92 : math.pow((value + 0.055) / 1.055, 2.4).toDouble();

  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}
