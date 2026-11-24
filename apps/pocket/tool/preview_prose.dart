// One reply, with everything a reply can contain, on a phone and with no host to pair
// with.
//
//   bun run pocket:dev tool/preview_prose.dart
//
// The widget tests around `AgentProse` assert structure — that a table is a `ProseTable`,
// that `[2]` stays two characters, that a link is its own run. None of them can say
// whether the result is *legible on a phone*, and the defects this file exists to watch
// for were all found by looking: a heading in a third typeface, a table fenced in
// near-white lines, a `SOFTWARE` chip the colour of nothing else on the screen.
//
// It mounts the shipping widgets — `ProseLine`, `AgentProse`, `ProseTable`, `ProseActions`
// — through the app's own theme. Nothing here is a mock except the transcript itself.

import 'package:flutter/material.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/features/agent/chat_transcript.dart';
import 'package:lotus_pocket/features/agent/widgets/chat_lines.dart';
import 'package:lotus_pocket/features/agent/widgets/quote_strip.dart';

void main() => runApp(const _Preview());

ChatItem _reply(String text) => ChatItem(
  kind: ChatLine.prose,
  text: text,
  timestamp: DateTime.now().subtract(const Duration(minutes: 15)),
);

const _markdown = '''
## Ringkasan encoder

Dugaan terkuat: HP-mu meng-encode dengan **software**, bukan chip encoder. Pilih opsi [2]
pada baris [42] untuk menggantinya, lalu baca `Pembatas:` di kotak status.

| kolom | nilai | catatan |
|---|---|---|
| encoder | software | ini penyebabnya |
| pembatas | cpu | turunkan ke 1080p30 |
| dikirim | 1920×1080@30 | 8.00 Mbps |

Panelnya ada di http://127.0.0.1:9877/admin dan berkas yang kuubah adalah
lib/features/agent/widgets/agent_prose.dart:88 — dokumentasinya di
https://pub.dev/packages/gpt_markdown.

```bash
adb shell settings put global encoder_profile h264
```
''';

class _Preview extends StatefulWidget {
  const _Preview();

  @override
  State<_Preview> createState() => _PreviewState();
}

class _PreviewState extends State<_Preview> {
  final TextEditingController _composer = TextEditingController();
  String? _quote;

  @override
  void dispose() {
    _composer.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final tokens = AppTokens.dark;

    return MaterialApp(
      title: 'prose preview',
      theme: buildAppTheme(),
      home: Scaffold(
        backgroundColor: tokens.bg,
        body: SafeArea(
          child: Column(
            children: [
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.fromLTRB(18, 16, 18, 8),
                  children: [
                    ProseLine(
                      item: _reply(_markdown),
                      agent: 'nita',
                      onQuote: (text) => setState(() => _quote = text),
                    ),
                  ],
                ),
              ),
              // The other half of `Add to chat`: what landed, quoted, unsent.
              Container(
                decoration: BoxDecoration(
                  border: Border(top: BorderSide(color: tokens.line)),
                ),
                padding: const EdgeInsets.fromLTRB(16, 4, 16, 14),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (_quote case final held?)
                      QuoteStrip(text: held, onDrop: () => setState(() => _quote = null)),
                    TextField(
                      controller: _composer,
                      maxLines: 6,
                      minLines: 1,
                      style: tokens.ui.copyWith(fontSize: 14, color: tokens.text),
                      decoration: InputDecoration.collapsed(
                        hintText: 'Reply to nita',
                        hintStyle: tokens.ui.copyWith(fontSize: 14, color: tokens.muted),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
