import 'package:flutter/material.dart';

/// Pocket's own visual language — colours and base type styles — as a
/// [ThemeExtension] rather than a bag of static constants.
///
/// A [ThemeExtension] buys three things a plain `class AppTokens { static const
/// ... }` would not: [Theme.of] resolves it through the ordinary widget tree, so a
/// future per-screen or per-test override needs no new plumbing; [lerp] makes a
/// theme swap animate instead of snap; and adding a field is the same one-line
/// change whether it is a new colour on the existing theme or the first field of a
/// second theme variant. `flutter_lints`' own docs recommend this exact pattern for
/// design tokens that fall outside [ColorScheme] and [TextTheme] — it is the paved
/// road, not a project invention (ADR-1, ADR-10's reasoning for staying on one).
///
/// Values come from the `:root` custom properties in
/// `plans/lotus-pocket/design/pocket-flow.html` (the mockup locked 2026-08-03) —
/// themselves, by that file's own comment, copied verbatim from
/// `apps/desktop/src/styles/canvas/theme.css`. [waiting] and [error] below are still the
/// same hex as desktop's `--canvas-status-connecting` and `--canvas-status-error`. Change
/// a colour by editing the mockup first — this file follows it, not the other way around.
///
/// **Four of those values were superseded on 2026-08-11 by
/// `design/revamp-ground.html`, the mockup that owns the app floor now: [bg], [dim],
/// [muted], [faint].** The old floor sat at `oklch(0.132 …)`, inside the range where an OLED
/// plus ambient reflection crushes gradation — so [raise] measured a perfectly adequate
/// ΔL +0.052 there and still rendered as nothing. It is a display limit, not a contrast one,
/// and lifting the floor takes the whole surface stack out of that region.
///
/// The floor is now `oklch(0.183 0.004 286°)`: [raise] +0.043, [line] +0.081, and the
/// terminal's well (`oklch(0.130)`) still 0.055 *below* it, so the well keeps reading as the
/// hole it is. **The lightness was verified on a phone** (against `#100E0B` and `#1F1D19`);
/// **the hue is spent on [waiting]**, not on matching [text]. Salience runs on three channels,
/// and this cool-neutral field puts amber 158° from its ground where a warm floor put it 6° —
/// on a screen whose whole job is finding one amber word, hue belongs to the signal.
///
/// **[text], [waiting], [error], [raise], [line], [lineStrong] did not move** — amber stays
/// above 10:1, which matters because it carries this product's single meaning (`MVP.md`),
/// and a colour retuned every time the floor shifts is a colour that will drift. **Desktop's
/// `--canvas-bg` is still `#07070d`, so the two no longer share a floor** — said out loud
/// because this file used to cite that sameness as evidence the palette was not invented
/// here. Bringing it across is a separate decision, not a forgotten one.
///
/// **[dim], [muted] and [faint] are solved against [bg], never copied from a mockup alpha**
/// — a design document is rendered on a desktop display and this screen is read outdoors, so
/// where the two disagree the phone wins. Pinned by `app_tokens_test.dart`, which measures
/// them rather than trusting them (see the table on [dim]).
/// The smallest a control is allowed to be, in logical pixels.
///
/// 44 rather than Material's 48 because that is the number this app already settled
/// on: the send button, the microphone, and both dictation controls are 44×44, and
/// `SwitcherRow` calls 44 "the minimum" when explaining why it uses 52. Stating it
/// once turns that from a convention four widgets happen to share into something a
/// fifth cannot silently miss.
///
/// It exists because several controls *did* miss it — `READ IT IN FULL` on the
/// permission card was ~17px tall, which is the escape hatch for reading a destructive
/// prompt in full before approving it.
const double kMinHitTarget = 44;

@immutable
class AppTokens extends ThemeExtension<AppTokens> {
  const AppTokens({
    required this.bg,
    required this.raise,
    required this.text,
    required this.dim,
    required this.muted,
    required this.faint,
    required this.line,
    required this.lineStrong,
    required this.waiting,
    required this.error, required this.live,
    required this.mono,
    required this.ui,
    required this.serif,
  });

  /// App floor. Nothing sits under it — no card, no container; the 2026-08-02
  /// mockup revamp removed both in favour of flat rows on [bg] directly.
  final Color bg;

  /// Elevated rows and panels — the composer, checklist rows. One step off [bg],
  /// never a second background colour of its own.
  final Color raise;

  /// Primary text, and the ink side of an inverted button — the dispatch/send
  /// button's own treatment is `background: text, foreground: bg`, not a separate
  /// accent colour.
  final Color text;

  /// Two text weights below [text], and one ornament level that is **not for text**.
  ///
  /// A row's title, its caption, and a disabled-looking label are visually distinct kinds of
  /// quiet, and the mockup treats them as three rather than shades of one grey. What changed
  /// on 2026-08-09 is not that count but where the boundary falls: against the old `bg`, the
  /// mockup's own alphas gave
  ///
  /// | token | alpha | contrast | WCAG 2.1 AA |
  /// |---|---|---|---|
  /// | [dim] | 0.62 | 7.07:1 | passes |
  /// | [muted] | 0.40 | 3.47:1 | **fails** (needs 4.5:1) |
  /// | [faint] | 0.22 | **1.80:1** | fails by a factor of two and a half |
  ///
  /// and `PRODUCT.md` targets AA. 1.80:1 is not a quiet grey, it is an invisible one —
  /// and [faint] was carrying sole affordances at 9px: `RAW TERMINAL`, `READ IT IN
  /// FULL`, `DIAGNOSTICS`, `TRY AGAIN`, the back caret. A screen whose stated job is to
  /// be read *at arm's length, while walking* (`MVP.md`) cannot spend its only route
  /// into raw output on 1.8:1.
  ///
  /// Raising [faint] far enough to pass as text would have taken it to 0.48, which is
  /// where [muted] already was — three levels collapsing into two, and the hierarchy
  /// the mockup wanted lost in exchange for the contrast it also wanted. So the fix is
  /// a reassignment, not only a retune:
  ///
  /// * [dim] — where **interactive labels** live.
  /// * [muted] — the floor for anything that is genuinely text.
  /// * [faint] — **ornament only**: pips, marks, disabled glyphs, the inactive half of a
  ///   control. Meets WCAG 1.4.11's 3:1 for non-text UI, which is the bar those actually
  ///   have to clear. Putting a sentence in it is now a bug.
  ///
  /// **All three were re-solved on 2026-08-11 when [bg] moved**: translucent ink loses
  /// contrast as its substrate lightens, so leaving them would have dropped the AA decision
  /// above in silence. Now [dim] 7.06:1, [muted] 4.52:1, [faint] 3.04:1 — two of them went
  /// *down*, since a brighter substrate needs less ink to separate from.
  ///
  /// Those ratios use the arithmetic `Color.alphaBlend` uses — float, no channel rounding —
  /// and the difference is not pedantry: an 8-bit calculation put [dim] at 7.02:1 where
  /// Flutter renders **6.985:1**, a fail. This byte is one step above what that asked for.
  final Color dim;
  final Color muted;
  final Color faint;

  /// Two divider strengths — [line] for the routine ones, [lineStrong] where a
  /// boundary needs to actually read as a boundary (the switcher sheet's grab
  /// handle).
  final Color line;
  final Color lineStrong;

  /// The one warm colour allowed to mean something: an agent is waiting on the
  /// operator. `MVP.md`'s rule is absolute — nothing else on screen is ever
  /// coloured for decoration — so this field must never be reached for anything but
  /// that one state. Same hex as desktop's `--canvas-status-connecting`.
  final Color waiting;

  /// The only other colour allowed to exist: a cell in the `error` turn state.
  /// Same hex as desktop's `--canvas-status-error`.
  final Color error;
  final Color live; // Working now; the Home row dot only (2026-08-27). [waiting] is *you*, this is *it*.

  /// Base style for technical content — identifiers, hosts, timestamps, terminal
  /// output. Carries no size or colour on purpose: the mockup uses this role from
  /// 9.5px to 21px depending on context, so a call site composes with
  /// `tokens.mono.copyWith(fontSize: 10.5, color: tokens.faint)` rather than
  /// fighting a baked-in default.
  final TextStyle mono;

  /// Base style for interface chrome — everything that is not prose and not a
  /// technical label. Left as the platform default (`--ui: system-ui, ...` has
  /// nothing for Flutter to override): iOS and Android already resolve their own
  /// system sans correctly without a font family named here.
  final TextStyle ui;

  /// Base style for the agent's own words. Added 2026-08-03 to the mockup so "what
  /// the agent SAID" (serif prose) reads as unmistakably different from "what it
  /// DID" (mono) — the typeface itself carries that distinction, which is why a
  /// call site should not also reach for a decoration like a left stripe to say the
  /// same thing twice.
  final TextStyle serif;

  /// Pocket ships dark-only today. The locked mockup's `.screen` — the phone's own
  /// content — reads exclusively from these `--d-*` tokens; the mockup file's other
  /// custom properties (`--p-*`, a light "paper" palette) size the design *document*
  /// around the phone frame, not the app inside it, so they have no equivalent here.
  /// This is the only instance that exists; see [AppTokensContext] for what changes
  /// the day a second one does.
  static const AppTokens dark = AppTokens(
    // oklch(0.183 0.004 286°) — cool-neutral, so amber keeps a hue to oppose. Class doc.
    bg: Color(0xFF121214),
    raise: Color(0x0BF5F2EF), // rgba(245, 242, 239, 0.045) — ΔL +0.043 on this floor
    text: Color(0xFFF7F2EA), // 16.78:1
    // All three recomputed on 2026-08-11 for the new floor, with the arithmetic
    // `Color.alphaBlend` actually uses; the table on [dim] has the measurements and why
    // two of the three went *down*.
    dim: Color(0xA0F7F2EA), // 7.06:1, was 0x9E on the old floor
    muted: Color(0x79F7F2EA), // 4.52:1, was 0x80
    faint: Color(0x5AF7F2EA), // 3.04:1, was 0x61
    line: Color(0x16F5F2EF), // rgba(245, 242, 239, 0.085) — ΔL +0.081
    lineStrong: Color(0x29F5F2EF), // rgba(245, 242, 239, 0.16) — ΔL +0.149
    waiting: Color(0xFFFBBF24),
    error: Color(0xFFF87171), live: Color(0xFF3FBF8F),
    mono: TextStyle(fontFamilyFallback: ['Menlo', 'SF Mono', 'Consolas', 'monospace']),
    ui: TextStyle(),
    serif: TextStyle(fontFamilyFallback: ['Georgia', 'Palatino', 'serif']),
  );

  @override
  AppTokens copyWith({
    Color? bg,
    Color? raise,
    Color? text,
    Color? dim,
    Color? muted,
    Color? faint,
    Color? line,
    Color? lineStrong,
    Color? waiting,
    Color? error, Color? live,
    TextStyle? mono,
    TextStyle? ui,
    TextStyle? serif,
  }) =>
      AppTokens(
        bg: bg ?? this.bg,
        raise: raise ?? this.raise,
        text: text ?? this.text,
        dim: dim ?? this.dim,
        muted: muted ?? this.muted,
        faint: faint ?? this.faint,
        line: line ?? this.line,
        lineStrong: lineStrong ?? this.lineStrong,
        waiting: waiting ?? this.waiting,
        error: error ?? this.error, live: live ?? this.live,
        mono: mono ?? this.mono,
        ui: ui ?? this.ui,
        serif: serif ?? this.serif,
      );

  @override
  AppTokens lerp(ThemeExtension<AppTokens>? other, double t) {
    if (other is! AppTokens) return this;
    return AppTokens(
      bg: Color.lerp(bg, other.bg, t)!,
      raise: Color.lerp(raise, other.raise, t)!,
      text: Color.lerp(text, other.text, t)!,
      dim: Color.lerp(dim, other.dim, t)!,
      muted: Color.lerp(muted, other.muted, t)!,
      faint: Color.lerp(faint, other.faint, t)!,
      line: Color.lerp(line, other.line, t)!,
      lineStrong: Color.lerp(lineStrong, other.lineStrong, t)!,
      waiting: Color.lerp(waiting, other.waiting, t)!,
      error: Color.lerp(error, other.error, t)!, live: Color.lerp(live, other.live, t)!,
      mono: TextStyle.lerp(mono, other.mono, t)!,
      ui: TextStyle.lerp(ui, other.ui, t)!,
      serif: TextStyle.lerp(serif, other.serif, t)!,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AppTokens &&
          other.bg == bg &&
          other.raise == raise &&
          other.text == text &&
          other.dim == dim &&
          other.muted == muted &&
          other.faint == faint &&
          other.line == line &&
          other.lineStrong == lineStrong &&
          other.waiting == waiting &&
          other.error == error &&
          other.live == live &&
          other.mono == mono &&
          other.ui == ui &&
          other.serif == serif;

  @override
  int get hashCode => Object.hash(
        bg,
        raise,
        text,
        dim,
        muted,
        faint,
        line,
        lineStrong,
        waiting,
        error,
        live,
        mono,
        ui,
        serif,
      );
}

/// `context.tokens` — the read path every widget under `features/` uses.
///
/// Never `Theme.of(context).extension<AppTokens>()` spelled out at a call site:
/// that would leave the null case — a `ThemeData` built without [AppTokens] at all
/// — to each widget individually instead of to the one place that can give a useful
/// error. [layering_test]'s ban on `features/` reaching `core/` directly has the
/// same shape: one seam, one place to get it right.
extension AppTokensContext on BuildContext {
  AppTokens get tokens {
    final found = Theme.of(this).extension<AppTokens>();
    assert(
      found != null,
      'AppTokens missing from Theme — build it with buildAppTheme(), not ThemeData() directly.',
    );
    return found!;
  }
}
