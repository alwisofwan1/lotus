import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/agent/chat_scroll.dart';
import 'package:lotus_pocket/features/agent/chat_transcript.dart';

final DateTime at = DateTime.utc(2026, 8, 7, 12);

/// A line's timestamp belongs to the line, not to where it currently sits — that is what
/// makes it the same line after a page lands in front of it. A helper that stamped by index
/// would be testing a transcript this app cannot produce.
ChatTranscript of(List<String> lines) => ChatTranscript([
      for (final line in lines)
        ChatItem(
          kind: ChatLine.prose,
          text: line,
          truncated: false,
          timestamp: at.add(Duration(milliseconds: line.hashCode % 1000)),
        ),
    ]);

void main() {
  group('counting what arrived in front', () {
    test('a page of older history is counted, and only it', () {
      final before = of(['a', 'b', 'c']);
      final now = of(['x', 'y', 'a', 'b', 'c']);

      expect(ChatScroll.prependedCount(before, now), 2);
    });

    /// The case that actually happens on a phone: the operator scrolls up while the agent is
    /// still talking, so a page of history and a line of the reply land in the same frame.
    /// Counting the growth instead of the page would report 3 and hide the one genuinely new
    /// line from the unread counter.
    test('a reply arriving in the same frame is not counted as history', () {
      final before = of(['a', 'b', 'c']);
      final now = of(['x', 'y', 'a', 'b', 'c', 'new']);

      expect(ChatScroll.prependedCount(before, now), 2);
    });

    test('a reply on its own is not history', () {
      expect(ChatScroll.prependedCount(of(['a', 'b']), of(['a', 'b', 'c'])), 0);
    });

    test('nothing held before means nothing to keep in place', () {
      expect(ChatScroll.prependedCount(of([]), of(['a'])), 0);
    });

    test('a shrinking transcript is never a prepend', () {
      expect(ChatScroll.prependedCount(of(['a', 'b', 'c']), of(['b', 'c'])), 0);
    });

    /// Fails closed. If the first row is simply gone — trimmed from the front while the
    /// operator was away — the growth cannot be attributed and no correction is invented.
    /// A view that does not move is a far smaller wrong than one that jumps somewhere
    /// arbitrary.
    test('a front that changed without gaining the old first row counts as nothing', () {
      final before = of(['a', 'b', 'c']);
      final now = of(['x', 'y', 'z', 'b', 'c']);

      expect(ChatScroll.prependedCount(before, now), 0);
    });
  });
}
