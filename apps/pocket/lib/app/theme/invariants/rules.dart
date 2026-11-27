import 'package:flutter/painting.dart';

import '../theme_variant.dart';
import '../tokens/brand_marks.dart';
import '../tokens/color_role.dart';
import '../tokens/terminal_palette.dart';
import 'contrast.dart';

/// One broken rule; [measured] against [required] says by how much.
typedef Violation = ({String subject, String rule, double measured, double required});

const _surfaces = [ColorRole.ground, ColorRole.raised, ColorRole.track, ColorRole.key, ColorRole.keyActive];

/// Where each foreground must clear which WCAG 2.1 ratio. Mirrors where the app draws it.
const Map<ColorRole, (double, List<ColorRole>)> pairingMatrix = {
  ColorRole.text: (4.5, _surfaces),
  ColorRole.text2: (4.5, _surfaces),
  ColorRole.text3: (4.5, [ColorRole.ground, ColorRole.raised]), // raised = sheets
  ColorRole.ornament: (3.0, [ColorRole.ground]), // non-text only (WCAG 1.4.11)
  ColorRole.waiting: (4.5, _surfaces),
  ColorRole.error: (4.5, [ColorRole.ground, ColorRole.raised, ColorRole.track]),
  ColorRole.live: (3.0, [ColorRole.ground, ColorRole.raised]), // a dot, not text
  ColorRole.onWaiting: (4.5, [ColorRole.waiting]),
  ColorRole.onError: (4.5, [ColorRole.error]),
  ColorRole.onCamera: (4.5, [ColorRole.camera]),
  ColorRole.onCamera2: (4.5, [ColorRole.camera]),
  ColorRole.onCamera3: (4.5, [ColorRole.camera]),
};

/// Roles that must stay grey, so amber keeps the only hue that means something.
const neutralRoles = [
  ..._surfaces, ColorRole.termGround, ColorRole.text, ColorRole.text2, ColorRole.text3, //
  ColorRole.ornament, ColorRole.hairline, ColorRole.hairlineStrong, ColorRole.scrim, ColorRole.shadow,
  ColorRole.camera, ColorRole.onCamera, ColorRole.onCamera2, ColorRole.onCamera3,
];

const _brands = ['claude', 'codex', 'cursor', 'gemini', 'grok', 'kimi', 'opencode'];

/// Every rule a registered theme must pass; empty means the variant may ship.
/// Subjects in [ThemeVariant.waivers] are dropped unless [applyWaivers] is false.
List<Violation> checkTheme(ThemeVariant v, {bool applyWaivers = true}) {
  final c = v.tokens.colors;
  final out = <Violation>[];
  void need(String subject, String rule, double measured, double required, {bool atMost = false}) {
    if (atMost ? measured > required : measured < required) {
      out.add((subject: subject, rule: rule, measured: measured, required: required));
    }
  }

  final ground = c[ColorRole.ground];
  // Translucent roles are judged as drawn: composited over the app floor.
  Color solid(ColorRole r) => Color.alphaBlend(c[r], ground);

  pairingMatrix.forEach((fg, rule) {
    for (final bg in rule.$2) {
      need('${fg.name} on ${bg.name}', 'contrast', contrast(c[fg], solid(bg)), rule.$1);
    }
  });

  final levels = [ColorRole.text, ColorRole.text2, ColorRole.text3, ColorRole.ornament];
  for (var i = 1; i < levels.length; i++) {
    final louder = contrast(c[levels[i - 1]], ground);
    need('${levels[i].name} below ${levels[i - 1].name}', 'order', louder - contrast(c[levels[i]], ground), 0.01);
  }

  final amber = oklch(c[ColorRole.waiting]);
  need('waiting hue', 'amber-hue', 22.5 - hueGap(amber.h, 72.5), 0); // 50–95°
  need('waiting chroma', 'amber-hue', amber.c, 0.10);
  for (final r in neutralRoles) {
    need('${r.name} chroma', 'neutral', oklch(solid(r)).c, 0.03, atMost: true);
    need('${r.name} vs waiting', 'neutral', deltaEok(solid(r), c[ColorRole.waiting]), 0.10);
  }
  for (final r in [ColorRole.live, ColorRole.error]) {
    need('${r.name} hue', 'status-hue', hueGap(oklch(c[r]).h, amber.h), 60);
  }

  final term = v.terminal;
  // The terminal draws transparent (backgroundOpacity 0) over termGround, so that is the ground.
  final termBg = c[ColorRole.termGround];
  need('terminal foreground on termGround', 'contrast', contrast(term[TermRole.foreground], termBg), 4.5);
  need('terminal cursor on termGround', 'contrast', contrast(term[TermRole.cursor], termBg), 3.0);
  for (final r in ansiRoles) {
    need('ansi ${r.name} on termGround', 'contrast', contrast(term[r], termBg), 3.0);
  }
  // Black is also a ground (inverse video), so white must read on it.
  need('ansi white on black', 'contrast', contrast(term[TermRole.white], term[TermRole.black]), 4.5);
  for (final b in _brands) {
    for (final bg in [ColorRole.ground, ColorRole.raised]) {
      need('brand $b on ${bg.name}', 'contrast', contrast(brandColorFor(b, v.brightness)!, solid(bg)), 3.0);
    }
  }
  return applyWaivers ? out.where((x) => !v.waivers.containsKey(x.subject)).toList() : out;
}
