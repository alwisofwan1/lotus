import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/app/theme/invariants/contrast.dart';

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
    final t = AppTokens.dark;

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
    final t = AppTokens.dark;

    test('text roles clear 4.5:1', () {
      expect(contrast(t.text, t.bg), greaterThanOrEqualTo(4.5));
      expect(contrast(t.dim, t.bg), greaterThanOrEqualTo(4.5));
      // The one that was failing at 3.47:1 and carried row detail and summary copy.
      expect(contrast(t.muted, t.bg), greaterThanOrEqualTo(4.5));
    });

    test('the two colours allowed to shout clear 4.5:1 as well', () {
      expect(contrast(t.waiting, t.bg), greaterThanOrEqualTo(4.5));
      expect(contrast(t.error, t.bg), greaterThanOrEqualTo(4.5));
    });

    test('faint clears 3:1 — the non-text bar, which is all it is now for', () {
      // WCAG 1.4.11. faint is ornament — pips, marks, disabled glyphs — and a call
      // site that puts a sentence in it is the bug this boundary exists to name.
      expect(contrast(t.faint, t.bg), greaterThanOrEqualTo(3.0));
      // And it stays genuinely quieter than the text floor, or the demotion bought
      // nothing.
      expect(contrast(t.faint, t.bg), lessThan(contrast(t.muted, t.bg)));
    });
  });

  group('AppTokens.dark structural rules', () {
    final t = AppTokens.dark;

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

  test('the surfaces, inks and scrim added as roles keep their hexes', () {
    final t = AppTokens.dark;
    expect(t.raise2, const Color(0xFF232325));
    expect(t.termBg, const Color(0xFF0A0A0B));
    expect(t.key, const Color(0xFF2A2A2D));
    expect(t.keyHi, const Color(0xFF3A3A3E));
    expect(t.live, const Color(0xFF3FBF8F));
    expect(t.onWaiting, const Color(0xFF17130A));
    expect(t.onError, t.bg);
    expect(t.scrim, const Color(0x99000000));
    expect(t.shadow, const Color(0xFF000000));
  });
}
