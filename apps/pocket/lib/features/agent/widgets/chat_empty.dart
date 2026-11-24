import 'package:flutter/material.dart';

import '../../../app/theme/app_tokens.dart';
import '../../shared/refreshable.dart';

/// The way into raw output.
///
/// Drawn directly rather than as a `TextButton`, which gave it a filled pill the width
/// of the list — visible on a real phone, and a second earned container on a screen
/// whose whole argument is that the permission card is the only one.
///
/// Shared by [ChatEmpty] and the transcript itself because it is the same door in both:
/// at the end of a transcript it is the live tail, and on an empty one it is the only
/// thing there is to look at. Two copies is how the two would drift apart.
class RawTerminalRow extends StatelessWidget {
  const RawTerminalRow({required this.onTap, super.key});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Semantics(
      button: true,
      label: 'Open raw terminal',
      child: GestureDetector(
        onTap: onTap,
        behavior: HitTestBehavior.opaque,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 14),
          child: Text(
            'RAW TERMINAL',
            textAlign: TextAlign.center,
            style: t.mono.copyWith(
              fontSize: 11,
              letterSpacing: 0.16 * 11,
              color: t.dim,
            ),
          ),
        ),
      ),
    );
  }
}

/// An agent whose transcript has nothing in it yet.
///
/// **A state, not an absence, and the placement is what says which.** This used to be
/// the ordinary list with one faint sentence as its first row, so an agent with no
/// transcript showed a line of grey text pinned under the header and seven hundred
/// pixels of nothing beneath it. That reads as a screen that failed to load — which is
/// precisely the wrong reading, because the host's ring lives in memory: it starts empty
/// after every desktop restart and fills on the agent's next turn. The sentence already
/// said so. The placement undercut it.
///
/// Centred in the space it actually has, with [RawTerminalRow] beneath it, because when
/// there is no transcript the raw output is the only thing to look at and it should not
/// be a footnote at the top of an empty page.
///
/// Pullable, through [Refreshable.fill]: a transcript that is empty because the socket
/// died looks exactly like one that is empty because the agent has not spoken, and
/// asking again is the cheapest way to tell them apart.
class ChatEmpty extends StatelessWidget {
  const ChatEmpty({
    required this.note,
    required this.onRefresh,
    required this.onOpenTerminal,
    super.key,
  });

  final String note;
  final Future<void> Function() onRefresh;
  final VoidCallback onOpenTerminal;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return Refreshable.fill(
      onRefresh: onRefresh,
      child: Center(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 32),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                note,
                textAlign: TextAlign.center,
                style: t.mono.copyWith(fontSize: 11.5, height: 1.6, color: t.muted),
              ),
              const SizedBox(height: 10),
              RawTerminalRow(onTap: onOpenTerminal),
            ],
          ),
        ),
      ),
    );
  }
}
