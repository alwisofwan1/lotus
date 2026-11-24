// A host that answers `/m/*` from constants, for looking at screens without a machine.
//
// Only the **transports** are faked. `KeychainStore` and `DeviceBiometrics` — the two
// platform implementations no unit test can reach — are used for real by the previews, so
// running one on a device exercises the Keystore and the biometric gate rather than a
// stand-in. That is the point of the seams: swapping the network does not require swapping
// anything else.
//
// Payloads are inlined rather than read from `contract/fixtures/`, because a phone has no
// repo checked out. They are the same shapes; the fixtures remain the thing tests assert on.

import 'dart:convert';

import 'package:lotus_pocket/core/transport.dart';

/// Answers the handful of routes the two screens read, and accepts every mutation.
class PreviewHttpTransport implements HttpTransport {
  /// Pane ids that should look like they are asking permission.
  PreviewHttpTransport({this.askingPanes = const {'p-1'}});

  final Set<String> askingPanes;

  /// Every request made, so a preview can print what a screen actually asked for.
  final List<String> seen = [];

  @override
  Future<HttpReply> send({
    required String method,
    required Uri uri,
    Map<String, String> headers = const {},
    String? body,
  }) async {
    seen.add('$method ${uri.path}');
    // A visible beat, so loading states are seen rather than skipped past. A real tailnet
    // round trip is not instant either.
    await Future<void>.delayed(const Duration(milliseconds: 180));

    final segments = uri.pathSegments;
    final pane = segments.length > 2 ? segments[2] : 'p-1';

    if (uri.path.endsWith('/transcript')) {
      return HttpReply(status: 200, body: _transcript(pane));
    }
    if (uri.path.endsWith('/permission')) {
      return HttpReply(status: 200, body: _permission(pane, askingPanes.contains(pane)));
    }
    if (uri.path.endsWith('/dispatch') || uri.path.endsWith('/stop')) {
      return const HttpReply(status: 200, body: '{"ok":true}');
    }
    if (uri.path.endsWith('/devices/refresh')) {
      return HttpReply(
        status: 200,
        body: jsonEncode({
          'deviceToken': 'preview-token',
          'expiresAt': DateTime.now()
              .add(const Duration(hours: 72))
              .millisecondsSinceEpoch,
        }),
      );
    }
    return const HttpReply(status: 200, body: '{}');
  }

  /// A turn with all three kinds of line in it: the prompt, the steps it ran, and what it
  /// said — which is the only way to see whether the typeface split actually reads.
  String _transcript(String pane) {
    const prompt = 'Clean up the unused legacy files';
    int at(int offset) =>
        DateTime.now().subtract(Duration(seconds: 60 - offset)).millisecondsSinceEpoch;

    Map<String, Object?> step(
      String title,
      String target,
      int offset, {
      int? added,
      int? removed,
    }) =>
        {
          'event': 'tool-post',
          'status': 'running',
          'title': title,
          'body': target,
          'userPrompt': prompt,
          'toolTarget': target,
          // Null-aware entries: omitted rather than sent as null, so a step without a diff
          // looks to the client exactly as the host would leave it.
          'linesAdded': ?added,
          'linesRemoved': ?removed,
          'timestamp': at(offset),
        };

    return jsonEncode({
      'paneId': pane,
      'total': 6,
      'entries': [
        step('Grep', 'TODO in src/', 0),
        step('Read', 'src/legacy/shim.ts', 5),
        {
          'event': 'stop',
          'status': 'idle',
          'title': 'Finished working',
          // `body` on a stop payload is the assistant's last message — and agents write
          // **markdown**, which Chat printed literally until 2026-08-07. Measured across
          // 279 real replies: inline code 30%, bold 27%, fenced blocks 25%, bullets 17%,
          // headings 10%. This one carries each of those, because a preview that only
          // shows prose is a preview that cannot catch a broken renderer.
          'body': '## What I found\n\n'
              'Neither file is referenced anywhere. `src/legacy/shim.ts` is imported '
              'by **nothing**, and the barrel re-export was already dead.\n\n'
              'Order of operations:\n\n'
              '- remove the shim\n'
              '- drop the re-export\n'
              '- re-run the suite\n\n'
              '```bash\n'
              'rg --files-with-matches "legacy/shim" src/ | head -20\n'
              'bun test --filter legacy\n'
              '```\n\n'
              'The second command is the one that matters.',
          'userPrompt': prompt,
          'toolTarget': '',
          'timestamp': at(10),
        },
        // A reply the host cut at its 8000-byte cap. Chat has to say so, or a sentence
        // stopping mid-word reads as the agent having stopped there.
        {
          'event': 'stop',
          'status': 'idle',
          'title': 'Finished working',
          'body': 'I removed the shim and updated the three call sites. The last one',
          'bodyTruncated': true,
          'userPrompt': prompt,
          'toolTarget': '',
          'timestamp': at(35),
        },
        step('Edit', 'src/legacy/shim.ts', 20, added: 0, removed: 34),
        step('Bash', 'bun test --filter legacy', 30),
      ],
    });
  }

  String _permission(String pane, bool asking) => jsonEncode({
        'paneId': pane,
        'awaiting': asking,
        'prompt': asking
            ? {
                'question': 'Do you want to delete src/legacy/shim.ts?',
                // Digits as printed. A prompt whose first option scrolled away would start
                // at 2, which is why nothing here is derived from position.
                'options': [
                  {'key': '1', 'label': 'Yes', 'selected': true},
                  {
                    'key': '2',
                    'label': 'Yes, allow all edits during this session (shift+tab)',
                    'selected': false,
                  },
                  {'key': '3', 'label': 'No', 'selected': false},
                ],
              }
            : null,
        if (asking)
          'readback': 'Do you want to delete src/legacy/shim.ts? '
              'Option 1: Yes. Option 2: Yes, allow all edits during this session. Option 3: No.',
      });
}

/// A socket that never connects, so nothing retries in the background while a screen is
/// being looked at. The previews drive the fleet by hand instead.
class SilentTransport implements Transport {
  const SilentTransport();

  @override
  Future<MessageChannel> open(Uri uri) async =>
      throw const TransportUnavailable('preview: no socket', cause: TransportCause.refused);
}
