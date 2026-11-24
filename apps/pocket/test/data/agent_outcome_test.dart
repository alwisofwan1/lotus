import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/agent_outcome.dart';
import 'package:lotus_pocket/models/transcript.dart';

TranscriptEntry e(
  String event, {
  String title = 'Edit',
  String target = 'src/a.ts',
  String body = '',
  int? added,
  int? removed,
  int at = 0,
  bool cut = false,
}) =>
    TranscriptEntry(
      event: event,
      status: 'running',
      title: title,
      body: body,
      userPrompt: 'do it',
      toolTarget: target,
      timestamp: DateTime.fromMillisecondsSinceEpoch(1785664800000 + at),
      linesAdded: added,
      linesRemoved: removed,
      bodyTruncated: cut,
    );

/// Job story #3, as arithmetic: what the last turn changed, from entries the phone
/// already holds. Nothing here is fetched, so nothing here may guess.
void main() {
  test('sums the edits of the last turn per file, in first-touched order', () {
    final outcome = AgentOutcome.of([
      e('prompt-submit', body: 'clean up'),
      e('tool-pre', title: 'Read', target: 'src/a.ts', at: 1_000),
      e('tool-post', target: 'src/a.ts', added: 10, removed: 2, at: 2_000),
      e('tool-post', target: 'src/b.ts', added: 5, removed: 0, at: 3_000),
      e('tool-post', target: 'src/a.ts', added: 1, removed: 1, at: 4_000),
      e('stop', body: 'Done.', at: 6 * 60_000),
    ])!;

    expect(outcome.files.map((f) => f.path), ['src/a.ts', 'src/b.ts']);
    expect(outcome.files.first.added, 11);
    expect(outcome.files.first.removed, 3);
    expect(outcome.added, 16);
    expect(outcome.removed, 3);
    expect(outcome.diffSummary, '+16 −3 · 2 files');
    expect(outcome.closing, 'Done.');
    expect(outcome.ranFor, const Duration(minutes: 6));
  });

  test('is nothing while the agent is still working', () {
    expect(AgentOutcome.of([e('prompt-submit'), e('tool-post', added: 1, removed: 0, at: 1)]), isNull);
    expect(AgentOutcome.of(const []), isNull);
  });

  test('a stop that is no longer last belongs to a turn being overwritten', () {
    expect(
      AgentOutcome.of([e('stop', body: 'old'), e('prompt-submit', body: 'again', at: 1)]),
      isNull,
    );
  });

  test('only the last turn counts — an earlier turn\'s edits are not re-billed', () {
    final outcome = AgentOutcome.of([
      e('tool-post', target: 'old.ts', added: 100, removed: 100),
      e('stop', body: 'first', at: 1),
      e('prompt-submit', body: 'more', at: 2),
      e('tool-post', target: 'new.ts', added: 3, removed: 0, at: 3),
      e('stop', body: 'second', at: 4),
    ])!;

    expect(outcome.files.map((f) => f.path), ['new.ts']);
    expect(outcome.closing, 'second');
  });

  test('a Read is not a change, and a stat-less entry never becomes +0 −0', () {
    final outcome = AgentOutcome.of([
      e('tool-pre', title: 'Read', target: 'x.ts'),
      e('tool-post', title: 'Read', target: 'x.ts', at: 1),
      e('tool-post', title: 'Bash', target: 'npm test', at: 2),
      e('stop', body: 'Nothing to change.', at: 3),
    ])!;

    expect(outcome.changedFiles, isFalse);
    expect(outcome.diffSummary, isNull, reason: 'words, not a measurement of nothing');
  });

  test('a one-entry turn has no duration rather than a zero one', () {
    expect(AgentOutcome.of([e('stop', body: 'hi')])!.ranFor, isNull);
  });

  test('the closing keeps the host\'s truncation flag', () {
    expect(AgentOutcome.of([e('stop', body: 'I removed the', cut: true)])!.closingTruncated, isTrue);
  });
}
