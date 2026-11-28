import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:gpt_markdown/gpt_markdown.dart';

import '../../../app/theme/theme.dart';
import '../link_target.dart';
import 'prose_links.dart';
import 'prose_table.dart';

/// What the agent said, rendered as the markdown it actually is.
///
/// Chat used to print this through a plain [Text], so `##`, backticks and `**bold**`
/// arrived on screen as characters. That was not a small blemish: measured across 279
/// real assistant messages, 30% carry inline code, 27% bold, 25% a fenced block — so a
/// quarter of replies were showing a wall of triple-backticks where a code block
/// belonged.
///
/// **Every builder here exists to take something away.** A general markdown renderer
/// arrives with a palette — blue links, coloured headings, a grey code panel — and this
/// screen allows exactly two colours: amber means an agent needs you, red means a cell
/// errored (`MVP.md`). Nothing else is permitted to be coloured, so the structure has
/// to be carried by typeface and weight instead, which is the same rule the three kinds
/// of Chat line already follow.
class AgentProse extends StatelessWidget {
  const AgentProse({required this.text, this.onLink, super.key});

  final String text;

  /// Opens a link the agent wrote — a bare address, a path, or a markdown `[a](b)`, all
  /// three arriving here classified. Null leaves every link as plain underlined text,
  /// which is what this screen did for its whole life until 2026-09-17.
  final void Function(BuildContext context, LinkTarget target)? onLink;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return GptMarkdownTheme(
      gptThemeData: _theme(t),
      child: _markdown(context, t),
    );
  }

  /// Headings, rules and link colours, pulled back into this app's two-colour palette.
  ///
  /// Left alone, the package takes headings from Material's `textTheme` — which is
  /// **sans**, and that was visible the first time this ran on the emulator: a reply
  /// with a `##` in it rendered its heading in a third typeface. `MVP.md` gives the
  /// letterforms one job each — serif is what the agent said, mono is what it did — and
  /// a sans heading inside the agent's own words is a voice the design does not have.
  ///
  /// Sizes step down rather than shout: this is a phone, and an `h1` at Material's
  /// `headlineLarge` is larger than the screen's own title.
  static GptMarkdownThemeData _theme(AppTokens t) {
    TextStyle heading(double size) => t.serif.copyWith(
          fontSize: size,
          height: 1.3,
          fontWeight: FontWeight.w600,
          color: t.text,
        );

    return GptMarkdownThemeData(
      brightness: Brightness.dark,
      h1: heading(19),
      h2: heading(17),
      h3: heading(15.5),
      h4: heading(14.5),
      h5: heading(14.5),
      h6: heading(14.5),
      // The rule the package draws under an `h1`, and the one a `---` produces: this
      // app's hairline, whose job is to separate rows without fencing them in.
      hrLineColor: t.line,
      hrLineThickness: 1,
      hrLinePadding: const EdgeInsets.symmetric(vertical: 8),
      // Blue and red are the package's defaults and neither is available here — red is
      // reserved for a cell in the error state. `linkBuilder` already draws the link,
      // so these only matter if that builder is ever removed; they are set so the
      // fallback is quiet rather than loud.
      linkColor: t.dim,
      linkHoverColor: t.dim,
      highlightColor: t.raise,
    );
  }

  /// The package's inline set, minus the one component that reads the agent's own words
  /// as markup.
  ///
  /// **`SourceTag` matches `[2]` anywhere in a sentence.** Its pattern is
  /// `(?:【.*?)?\[(\d+?)\]` — written for a chat model that cites sources, and this app
  /// talks to an agent that writes `pilih opsi [2]` and `baris [42]`. Measured
  /// 2026-09-16 by rendering that exact sentence and reading the widgets back: the
  /// prose came out as `Pilih opsi ￼ pada baris ￼`, with the digits moved into two
  /// `Material(OvalBorder)` chips styled by Material's own text theme — a third
  /// typeface in the middle of the agent's voice, brackets deleted, and the digit
  /// pulled out of the paragraph's text so a copy of that line loses it.
  ///
  /// [GptMarkdownConfig.inlineComponents] *replaces* the default list rather than
  /// adding to it, so dropping one component means restating the rest. That is the
  /// price of the fix; the list is pinned by a test so a package upgrade that adds a
  /// component cannot go missing here quietly.
  List<MarkdownComponent> get _inline => [
        ATagMd(),
        ImageMd(),
        TableMd(),
        StrikeMd(),
        BoldMd(),
        ItalicMd(),
        UnderLineMd(),
        LatexMath(),
        LatexMathMultiLine(),
        HighlightedText(),
        // Last, so every construct with a syntax of its own claims its text first: a URL
        // inside backticks stays code, and `[label](url)` stays one link rather than a
        // label beside a second one.
        if (onLink case final open?) AutoLinkMd(onTap: open),
      ];

  /// The list above, for the test that pins it against the package's own.
  @visibleForTesting
  List<MarkdownComponent> get debugInlineComponents => _inline;

  Widget _markdown(BuildContext context, AppTokens t) => GptMarkdown(
      text,
      inlineComponents: _inline,
      tableBuilder: (context, rows, style, config) => ProseTable(rows: rows, config: config),
      // Serif is the signal that this is the agent talking rather than the app
      // reporting — the distinction `MVP.md` bought a whole typeface for.
      style: t.serif.copyWith(fontSize: 14.5, height: 1.55, color: t.text),
      // Links keep the prose colour instead of the framework's blue.
      followLinkColor: true,
      // A markdown link goes through the same door a bare one does, so an operator
      // cannot tell from the outcome which syntax the agent happened to use. What each
      // target offers is decided by `LinkTarget`, not by this call site: the old
      // blanket "nothing opens" was right about a loopback port and wrong about the doc
      // page beside it.
      onLinkTap: (url, _) {
        final open = onLink;
        if (open == null) return;
        open(context, LinkTarget.of(url));
      },
      linkBuilder: (context, span, url, style) => Text.rich(
        span,
        style: style.copyWith(
          color: t.dim,
          decoration: TextDecoration.underline,
          decorationColor: t.line,
        ),
      ),
      highlightBuilder: (context, inline, style) => _InlineCode(text: inline),
      codeBuilder: (context, name, code, closed) => _CodeBlock(code: code, language: name),
      );
}

/// `` `paneId` `` inside a sentence.
///
/// Mono at a slightly smaller size so it sits on the serif baseline without looking
/// like a different paragraph. No background fill — filled shapes are reserved for the
/// two things this app lets you press.
class _InlineCode extends StatelessWidget {
  const _InlineCode({required this.text});

  final String text;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Text(
      text,
      style: t.mono.copyWith(fontSize: 12.5, height: 1.4, color: t.dim),
    );
  }
}

/// A fenced block.
///
/// **Scrolls horizontally rather than wrapping**, and that is the load-bearing choice:
/// `issues/03` measured a real agent session at 93 columns against a 390px phone, and
/// found that re-flowing code to a narrower width turns it into overlapping nonsense.
/// Wrapping a diff or a shell command does the same thing more quietly. So the block
/// keeps its own width and moves under the finger, which is also why it never lets the
/// page itself scroll sideways.
class _CodeBlock extends StatelessWidget {
  const _CodeBlock({required this.code, required this.language});

  final String code;

  /// The fence's info string (`bash`, `dart`), empty when it carried none.
  final String language;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Container(
      margin: const EdgeInsets.symmetric(vertical: 10),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        // One step off the app floor, the relationship `raise` already encodes — not a
        // second background colour, and not a border, which would fence it in.
        color: Color.alphaBlend(t.raise, t.bg),
        borderRadius: context.shape.radius(ShapeRole.chip),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.only(bottom: 6),
            child: Row(
              children: [
                Text(
                  language,
                  style: t.mono.copyWith(fontSize: 11, letterSpacing: 0.98, color: t.muted),
                ),
                const Spacer(),
                // The one thing a code block on a phone is for. It already scrolls
                // sideways rather than wrapping (`issues/03`), which makes reading a long
                // command possible and re-typing it at the desk the only way to use it.
                Semantics(
                  button: true,
                  label: 'Copy code',
                  child: GestureDetector(
                    onTap: () => Clipboard.setData(ClipboardData(text: code.trimRight())),
                    behavior: HitTestBehavior.opaque,
                    child: Padding(
                      padding: const EdgeInsets.only(left: 12, top: 2, bottom: 2),
                      child: Text(
                        'COPY',
                        style: t.mono.copyWith(
                          fontSize: 11,
                          letterSpacing: 0.14 * 11,
                          color: t.muted,
                        ),
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ),
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Text(
              code.trimRight(),
              softWrap: false,
              style: t.mono.copyWith(fontSize: 11.5, height: 1.5, color: t.dim),
            ),
          ),
        ],
      ),
    );
  }
}
