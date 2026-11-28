import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/agent/turn_progress.dart';
import 'package:lotus_pocket/models/conversation.dart';

final _at = DateTime.fromMillisecondsSinceEpoch(1788820000000);
var _seq = 0;

Part _user(String text) =>
    UserMessagePart(id: 'u${_seq++}', ts: _at, seq: _seq, provenance: Provenance.native, text: text);

Part _prose(String text) => AssistantTextPart(
    id: 'a${_seq++}', ts: _at, seq: _seq, provenance: Provenance.native, text: text,
    streaming: false, truncated: false);

Part _tool(String kind, String title, {String status = 'completed'}) => ToolCallPart(
    id: 'c${_seq++}', ts: _at, seq: _seq, provenance: Provenance.native, toolCallId: 'c$_seq',
    toolName: kind, title: title, kind: kind, status: status, locations: const [], files: const []);

Part _plan(List<(String, PlanStatus)> entries) => PlanUpdatePart(
    id: 'plan', ts: _at, seq: _seq++, provenance: Provenance.native,
    entries: [for (final (c, s) in entries) PlanEntry(content: c, status: s)]);

Turn _turn(List<Part> parts, {bool ended = false}) => Turn(
    turnId: 't-1', startedAt: _at, parts: parts,
    endedAt: ended ? _at.add(const Duration(minutes: 3, seconds: 10)) : null,
    stopReason: ended ? 'end_turn' : null);

List<(String, StepState)> _rows(TurnProgress p) => [for (final s in p.steps) (s.label, s.state)];

void main() {
  test('the agent own plan wins, read as done / now / next', () {
    final p = TurnProgress.of(_turn([
      _user('go'),
      _tool('read', 'a.dart'),
      _plan([
        ('Read the transport', PlanStatus.completed),
        ('Write SshTransport', PlanStatus.inProgress),
        ('Run the tests', PlanStatus.pending),
      ]),
    ]));
    expect(p.fromPlan, isTrue);
    expect(_rows(p), [
      ('Read the transport', StepState.done),
      ('Write SshTransport', StepState.now),
      ('Run the tests', StepState.next),
    ]);
  });

  test('the latest plan replaces the earlier one', () {
    final p = TurnProgress.of(_turn([
      _plan([('Old', PlanStatus.inProgress)]),
      _plan([('New A', PlanStatus.completed), ('New B', PlanStatus.pending)]),
    ]));
    // Nothing in progress while the turn runs: the first open entry is the one being worked on.
    expect(_rows(p), [('New A', StepState.done), ('New B', StepState.now)]);
  });

  test('without a plan, four phases read from the kind of work', () {
    final p = TurnProgress.of(_turn([_user('go'), _tool('read', 'a.dart'), _tool('edit', 'a.dart')]));
    expect(p.fromPlan, isFalse);
    expect(_rows(p), [
      ('Reading', StepState.done),
      ('Changing', StepState.now),
      ('Testing', StepState.next),
      ('Summing up', StepState.next),
    ]);
  });

  test('a test command is testing; any other command is not', () {
    final build = TurnProgress.of(_turn([_tool('edit', 'a'), _tool('execute', 'make build')]));
    expect(build.phase, Phase.changing);
    final test = TurnProgress.of(_turn([_tool('edit', 'a'), _tool('execute', 'flutter test')]));
    expect(test.phase, Phase.testing);
  });

  test('phases never go backwards', () {
    final p = TurnProgress.of(_turn([_tool('edit', 'a'), _tool('execute', 'bun test'), _tool('read', 'b')]));
    expect(p.phase, Phase.testing);
    // Prose followed by more work: the floor the view kept holds the phase where it was.
    final later = TurnProgress.of(_turn([_tool('read', 'a'), _prose('next I check'), _tool('read', 'b')]),
        floor: Phase.summing);
    expect(later.phase, Phase.summing);
  });

  test('prose at the end is summing up; skipped phases are not drawn as done', () {
    final p = TurnProgress.of(_turn([_user('go'), _tool('read', 'a'), _prose('Done. It works.')]));
    expect(_rows(p), [('Reading', StepState.done), ('Summing up', StepState.now)]);
  });

  test('a finished turn: everything done, with a count and the time it took', () {
    final planned = TurnProgress.of(_turn([
      _plan([('A', PlanStatus.completed), ('B', PlanStatus.completed)]),
      _prose('ok'),
    ], ended: true));
    expect(planned.steps.every((s) => s.state == StepState.done), isTrue);
    expect(planned.count, 2);
    expect(planned.took, const Duration(minutes: 3, seconds: 10));

    final unplanned = TurnProgress.of(_turn([
      _tool('read', 'a'), _tool('read', 'b'), _tool('edit', 'a'), _prose('ok'),
    ], ended: true));
    expect(unplanned.count, 3, reason: 'without a plan the count is the tool steps');
    expect(_rows(unplanned).map((r) => r.$2).toSet(), {StepState.done});
  });

  test('a reply with no work behind it has nothing to summarise', () {
    final p = TurnProgress.of(_turn([_user('hi'), _prose('hello')], ended: true));
    expect(p.count, 0);
  });
}
