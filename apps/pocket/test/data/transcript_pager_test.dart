import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/live_conversation.dart';
import 'package:lotus_pocket/models/conversation.dart';
import 'package:lotus_pocket/data/transcript_pager.dart';
import 'package:lotus_pocket/models/host_id.dart';
import 'package:lotus_pocket/models/transcript.dart';

const HostId mac = HostId('mac');
const CellRef atlas = CellRef(mac, 'p-1');

TranscriptEntry entry(String body) => TranscriptEntry(
      event: 'stop',
      status: 'idle',
      title: 'Finished working',
      body: body,
      userPrompt: '',
      toolTarget: '',
      timestamp: DateTime.fromMillisecondsSinceEpoch(1),
    );

TranscriptSnapshot page(List<String> bodies, {int? oldestCursor}) => TranscriptSnapshot(
      paneId: 'p-1',
      total: bodies.length,
      entries: bodies.map(entry).toList(),
      hostSupports: true,
      runnerReports: true,
      outlook: TranscriptOutlook.expected,
      oldestCursor: oldestCursor,
      hasMore: oldestCursor != null,
    );

void main() {
  late LiveConversation live;

  setUp(() => live = LiveConversation(const Stream.empty())..follow([atlas]));
  tearDown(() => live.dispose());

  test('nothing is asked for until a cursor is known', () async {
    var calls = 0;
    final pager = TranscriptPager(fetch: (_, _) async {
      calls += 1;
      return null;
    });

    await pager.loadOlder(atlas, live);

    expect(calls, 0, reason: 'a host that sent no cursor has nothing to page');
    expect(pager.canLoadOlder(atlas), isFalse);
  });

  test('the first scroll-up uses the cursor the open page already carries', () async {
    int? asked;
    final pager = TranscriptPager(fetch: (_, before) async {
      asked = before;
      return page(['old'], oldestCursor: 20);
    });

    await pager.loadOlder(atlas, live, from: 40);

    expect(asked, 40);
    // A `stop` entry carries the agent's own words, so it lands as prose, not a prompt.
    expect(
      live.turnsFor(atlas).expand((t) => t.parts).whereType<AssistantTextPart>().map((p) => p.text),
      ['old'],
    );
    expect(pager.canLoadOlder(atlas), isTrue, reason: 'the page said there is more');
  });

  test('the cursor advances, so a second page does not refetch the first', () async {
    final asked = <int>[];
    final pager = TranscriptPager(fetch: (_, before) async {
      asked.add(before);
      return page(['p$before'], oldestCursor: before - 20);
    });

    await pager.loadOlder(atlas, live, from: 40);
    await pager.loadOlder(atlas, live, from: 999);

    expect(asked, [40, 20], reason: 'the second read ignores the stale `from`');
  });

  /// Reaching the start of the file and a host with no cursor are both "nothing older",
  /// and both must stop a scroll-up from retrying forever.
  test('reaching the start stops the asking', () async {
    final pager = TranscriptPager(fetch: (_, _) async => page(['first'], oldestCursor: 0));

    await pager.loadOlder(atlas, live, from: 10);

    expect(pager.canLoadOlder(atlas), isFalse);
  });

  test('a failed read leaves the cursor where it was, so the scroll can retry', () async {
    final pager = TranscriptPager(fetch: (_, _) async => null);

    await pager.loadOlder(atlas, live, from: 30);

    expect(live.turnsFor(atlas), isEmpty);
    expect(pager.canLoadOlder(atlas), isFalse, reason: 'nothing was learned to keep');
  });

  test('cells outside the window are forgotten, cursors with them', () async {
    final pager = TranscriptPager(fetch: (_, _) async => page(['x'], oldestCursor: 5));
    await pager.loadOlder(atlas, live, from: 10);
    expect(pager.canLoadOlder(atlas), isTrue);

    pager.follow(const [CellRef(HostId('other'), 'p-2')]);

    expect(pager.canLoadOlder(atlas), isFalse);
  });
}
