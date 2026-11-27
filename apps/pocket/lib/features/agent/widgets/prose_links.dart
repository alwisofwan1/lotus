import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:gpt_markdown/custom_widgets/markdown_config.dart';
import 'package:gpt_markdown/custom_widgets/selectable_adapter.dart';
import 'package:gpt_markdown/gpt_markdown.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../../app/theme/theme.dart';
import '../../shared/tactile.dart';
import '../link_target.dart';

/// A URL or a file path the agent simply typed, made pressable.
///
/// **Bare links were not links.** Measured 2026-09-16 by rendering
/// `Buka http://127.0.0.1:9877/admin lalu cek /Users/alwi/file.dart` through `AgentProse`
/// and reading the widgets back: one plain `Text`, no spans, nothing to press. The
/// package's own link component matches `[text](url)` and nothing else — and an agent
/// reporting where it put something writes the address, it does not write markdown.
///
/// Two shapes, and the second one is why this is stricter than it looks:
///
/// * `https://…` and `http://…`, stopping before the punctuation that ends a sentence,
///   so `lihat http://host/x.` does not swallow the full stop.
/// * a path with a separator **and** an extension — `lib/main.dart`,
///   `/etc/hosts.conf`, `agent_prose.dart:88`. Requiring both is what keeps `dan/atau`
///   and `dua/tiga` out of it; a slash alone appears in ordinary prose far too often.
class AutoLinkMd extends InlineMd {
  AutoLinkMd({required this.onTap});

  /// Opens the sheet. Held by the component rather than looked up from the tree so the
  /// same instance can be reused across rebuilds of the list.
  final void Function(BuildContext context, LinkTarget target) onTap;

  static final RegExp _pattern = RegExp(
    r'(?:https?://[^\s<>()\[\]]*[^\s<>()\[\].,;:!?])'
    r'|(?:[\w.\-~]*(?:/[\w.\-~]+)+\.\w{1,8}(?::\d+)?)',
  );

  @override
  RegExp get exp => _pattern;

  @override
  InlineSpan span(BuildContext context, String text, GptMarkdownConfig config) {
    final raw = text.trim();
    final target = LinkTarget.of(raw);
    final t = context.tokens;

    return WidgetSpan(
      alignment: PlaceholderAlignment.baseline,
      baseline: TextBaseline.alphabetic,
      // Registers the run with the enclosing selection, so dragging across a sentence
      // that contains a link still yields the link's text rather than a hole. Without it
      // a `WidgetSpan` is invisible to `SelectionArea`.
      child: SelectableAdapter(
        selectedText: raw,
        child: GestureDetector(
          onTap: () {
            Tactile.chose();
            onTap(context, target);
          },
          child: Text(
            raw,
            style: (config.style ?? const TextStyle()).copyWith(
              color: t.text,
              decoration: TextDecoration.underline,
              decorationColor: t.lineStrong,
              // Mono for an address, the way this app writes every machine fact. Serif
              // is what the agent *said*; a path is something it found.
              fontFamily: t.mono.fontFamily,
              fontFamilyFallback: t.mono.fontFamilyFallback,
              fontSize: 13,
            ),
          ),
        ),
      ),
    );
  }
}

/// What a link can do, offered when one is pressed.
///
/// **Three rows at most, and the first one is missing on purpose when it would lie.** A
/// browser row on `http://127.0.0.1:9877` is an action that cannot work from a phone —
/// the address names the agent's own machine — so the sheet says where the target lives
/// instead of offering to fail.
Future<void> showLinkActions(
  BuildContext context, {
  required LinkTarget target,
  void Function(String text)? onQuote,
}) {
  final t = context.tokens;

  return showModalBottomSheet<void>(
    context: context,
    backgroundColor: Color.alphaBlend(t.raise, t.bg),
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(18)),
    ),
    builder: (sheet) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 6),
            child: Text(
              target.raw,
              style: t.mono.copyWith(fontSize: 12.5, height: 1.4, color: t.text),
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 14),
            child: Text(
              switch (target.kind) {
                LinkKind.web => 'terbuka di ponsel ini',
                LinkKind.machine => 'alamat di mesin agen — bukan di ponsel ini',
                LinkKind.path => 'berkas di mesin agen',
              },
              style: t.mono.copyWith(fontSize: 11, color: t.muted),
            ),
          ),
          Container(height: 1, color: t.line),
          if (target.reachableFromPhone)
            _LinkAction(
              label: 'BUKA',
              onTap: () async {
                final uri = Uri.parse(target.raw);
                final opened = await launchUrl(uri, mode: LaunchMode.externalApplication);
                if (!sheet.mounted) return;
                Navigator.of(sheet).pop();
                if (!opened) _sayNothingOpened(context);
              },
            ),
          if (onQuote != null)
            _LinkAction(
              label: 'ADD TO CHAT',
              onTap: () {
                onQuote(target.raw);
                Navigator.of(sheet).pop();
              },
            ),
          _LinkAction(
            label: 'SALIN',
            onTap: () async {
              await Clipboard.setData(ClipboardData(text: target.raw));
              if (sheet.mounted) Navigator.of(sheet).pop();
            },
          ),
        ],
      ),
    ),
  );
}

/// The one failure worth a word: a phone with no browser installed for the scheme, which
/// `canLaunchUrl` would also have reported — this asks forgiveness rather than
/// permission so the common path costs no extra platform call.
void _sayNothingOpened(BuildContext context) {
  final t = context.tokens;
  if (!context.mounted) return;

  ScaffoldMessenger.maybeOf(context)?.showSnackBar(
    SnackBar(
      backgroundColor: Color.alphaBlend(t.raise, t.bg),
      content: Text(
        'tidak ada aplikasi yang membuka tautan ini',
        style: t.mono.copyWith(fontSize: 12, color: t.dim),
      ),
    ),
  );
}

class _LinkAction extends StatelessWidget {
  const _LinkAction({required this.label, required this.onTap});

  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return InkWell(
      onTap: onTap,
      child: Container(
        height: kMinHitTarget + 6,
        alignment: Alignment.centerLeft,
        padding: const EdgeInsets.symmetric(horizontal: 20),
        child: Text(
          label,
          style: t.mono.copyWith(
            fontSize: 11.5,
            letterSpacing: 0.14 * 11.5,
            color: t.dim,
          ),
        ),
      ),
    );
  }
}
