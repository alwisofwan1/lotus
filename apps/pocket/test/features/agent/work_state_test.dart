import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/agent/work_state.dart';
import 'package:lotus_pocket/models/conversation.dart';

final _at = DateTime.fromMillisecondsSinceEpoch(1788820000000);

Part _user(String text, {Provenance p = Provenance.native}) => UserMessagePart(
    id: 'u', ts: _at, seq: 0, provenance: p, text: text);

Part _prose(String text, {required bool streaming, Provenance p = Provenance.native}) =>
    AssistantTextPart(
        id: 'a', ts: _at, seq: 1, provenance: p, text: text,
        streaming: streaming, truncated: false);

Part _tool(String name, String title, String status, {Provenance p = Provenance.native}) =>
    ToolCallPart(
        id: 'c$status$title', ts: _at, seq: 2, provenance: p, toolCallId: 'c',
        toolName: name, title: title, kind: 'execute', status: status, locations: const [], files: const []);

Turn _turn(List<Part> parts, {DateTime? endedAt}) =>
    Turn(turnId: 't-1', startedAt: _at, parts: parts, endedAt: endedAt);

void main() {
  test('nothing is running when there is no turn, or the last one closed', () {
    expect(WorkState.of(const []), isNull);
    expect(WorkState.of([_turn([_user('hi')], endedAt: _at)]), isNull);
  });

  test('an open tool call is what the row names, with the runner own words', () {
    final s = WorkState.of([_turn([_user('go'), _tool('bash', 'bun test pty', 'in_progress')])]);
    expect(s!.phase, WorkPhase.tool);
    expect(s.verb, 'bash');
    expect(s.target, 'bun test pty');
    expect(s.label, 'bash');
    expect(s.startedAt, _at);
  });

  test('counts the turn own steps, so one slow step is not the whole story', () {
    final s = WorkState.of([
      _turn([
        _user('go'),
        _tool('read', 'a.dart', 'completed'),
        _tool('grep', 'foo', 'completed'),
        _tool('bash', 'bun test', 'in_progress'),
      ])
    ]);
    expect(s!.steps, 3);
  });

  test('streaming prose is writing', () {
    final s = WorkState.of([_turn([_user('go'), _prose('Bukan logi', streaming: true)])]);
    expect(s!.phase, WorkPhase.writing);
    expect(s.label, 'writing…');
  });

  test('a turn with nothing in it yet is thinking', () {
    final s = WorkState.of([_turn([_user('go')])]);
    expect(s!.phase, WorkPhase.thinking);
    expect(s.label, 'thinking…');
  });

  test('a finished tool call with no prose yet is thinking again', () {
    // Between steps the agent is deciding what to do next, which is thinking.
    final s = WorkState.of([_turn([_user('go'), _tool('read', 'a.dart', 'completed')])]);
    expect(s!.phase, WorkPhase.thinking);
    expect(s.steps, 1);
  });

  /// Measured 2026-09-08: a hook-driven turn produces four events and the prose lands
  /// in one piece at the end. There is no moment such a cell is *known* to be writing,
  /// so the row must not say so.
  test('a hook-driven cell is never called writing', () {
    final s = WorkState.of([
      _turn([
        _user('go', p: Provenance.hook),
        _prose('Halo', streaming: true, p: Provenance.hook),
      ])
    ]);
    expect(s!.phase, WorkPhase.thinking);
  });

  test('a fresh turn with no parts is allowed to stream later', () {
    // Refusing on no evidence would make every turn open in the weaker state.
    final s = WorkState.of([_turn(const [])]);
    expect(s!.phase, WorkPhase.thinking);
  });

  test('the newest open tool call wins over an earlier one', () {
    final s = WorkState.of([
      _turn([
        _tool('read', 'first.dart', 'in_progress'),
        _tool('bash', 'second', 'in_progress'),
      ])
    ]);
    expect(s!.target, 'second');
  });
}
