import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/agent/task_finished.dart';
import 'package:lotus_pocket/models/cell.dart';
import 'package:lotus_pocket/models/conversation.dart';
import 'package:lotus_pocket/models/host_id.dart';

final _at = DateTime.fromMillisecondsSinceEpoch(1788820000000);
var _seq = 0;

Part _user(String text) =>
    UserMessagePart(id: 'u${_seq++}', ts: _at, seq: _seq, provenance: Provenance.hook, text: text);

Part _prose(String text) => AssistantTextPart(
    id: 'a${_seq++}', ts: _at, seq: _seq, provenance: Provenance.hook, text: text,
    streaming: false, truncated: false);

Part _tool() => ToolCallPart(
    id: 'c${_seq++}', ts: _at, seq: _seq, provenance: Provenance.hook, toolCallId: 'c$_seq',
    toolName: 'Edit', title: 'a.dart', kind: 'edit', status: 'completed',
    locations: const [], files: const []);

Part _plan(List<PlanStatus> states) => PlanUpdatePart(
    id: 'plan${_seq++}', ts: _at, seq: _seq, provenance: Provenance.hook,
    entries: [for (final (i, s) in states.indexed) PlanEntry(content: 'Step $i', status: s)]);

Part _error() => ErrorPart(
    id: 'e${_seq++}', ts: _at, seq: _seq, provenance: Provenance.hook, message: 'boom', recoverable: false);

Part _openQuestion() => QuestionPart(
    id: 'q${_seq++}', ts: _at, seq: _seq, provenance: Provenance.hook, questions: const []);

Turn _turn(List<Part> parts, {String? stop = 'end_turn', bool ended = true}) => Turn(
    turnId: 't-${_seq++}', startedAt: _at, parts: parts,
    endedAt: ended ? _at.add(const Duration(minutes: 1)) : null, stopReason: ended ? stop : null);

Cell _cell({String? turn = 'idle'}) => Cell(
    host: const HostId('mac'), paneId: 'p-1', workspaceId: 'W', agentType: 'claude',
    title: 'Nyx', status: 'live', isAlive: true, turn: turn);

/// A turn that did real work and ended with a plain statement.
List<Part> _worked({String closing = 'All done.'}) => [_user('fix it'), _tool(), _prose(closing)];

bool _finished(List<Turn> turns, {Cell? cell, bool promptPending = false}) =>
    taskLooksFinished(cell: cell ?? _cell(), turns: turns, promptPending: promptPending);

void main() {
  test('idle, worked, ended normally, closing statement: finished', () {
    expect(_finished([_turn(_worked())]), isTrue);
  });

  group('the agent state', () {
    test('working is not finished', () {
      expect(_finished([_turn(_worked())], cell: _cell(turn: 'running')), isFalse);
    });
    test('an unknown turn is not finished', () {
      expect(_finished([_turn(_worked())], cell: _cell(turn: null)), isFalse);
    });
    test('waiting for the operator is not finished', () {
      expect(_finished([_turn(_worked())], cell: _cell(turn: 'needs-input')), isFalse);
    });
    test('no turns at all is not finished', () {
      expect(_finished(const []), isFalse);
    });
    test('an open last turn is not finished', () {
      expect(_finished([_turn(_worked(), ended: false)]), isFalse);
    });
    test('a question still open is not finished', () {
      expect(_finished([_turn([..._worked(), _openQuestion()])]), isFalse);
    });
  });

  group('how the turn ended', () {
    test('an error part is not finished', () {
      expect(_finished([_turn([..._worked(), _error()])]), isFalse);
    });
    test('stopped by the operator is not finished', () {
      expect(_finished([_turn(_worked(), stop: 'cancelled')]), isFalse);
    });
    test('an error or max-turns stop is not finished', () {
      expect(_finished([_turn(_worked(), stop: 'error')]), isFalse);
      expect(_finished([_turn(_worked(), stop: 'max_turns')]), isFalse);
    });
  });

  group('real work', () {
    test('a greeting is not a task', () {
      expect(_finished([_turn([_user('hi'), _prose('Hi! What can I help you with?')])]), isFalse);
      expect(_finished([_turn([_user('hi'), _prose('Hello there.')])]), isFalse,
          reason: 'no tool call, no plan: a chat reply');
    });
    test('a plan step alone counts as work', () {
      expect(_finished([_turn([_user('go'), _plan([PlanStatus.completed]), _prose('Done.')])]), isTrue);
    });
  });

  group('the plan', () {
    test('an open step is not finished', () {
      final parts = [..._worked(), _plan([PlanStatus.completed, PlanStatus.pending])];
      expect(_finished([_turn(parts)]), isFalse);
      final doing = [..._worked(), _plan([PlanStatus.inProgress])];
      expect(_finished([_turn(doing)]), isFalse);
    });
    test('only the latest plan counts', () {
      final parts = [
        _user('go'), _tool(),
        _plan([PlanStatus.pending]),
        _plan([PlanStatus.completed, PlanStatus.completed]),
        _prose('Done.'),
      ];
      expect(_finished([_turn(parts)]), isTrue);
    });
  });

  group('the closing words', () {
    test('ending on a question hands the ball back', () {
      expect(_finished([_turn(_worked(closing: 'Fixed. Want me to add a test?'))]), isFalse);
      expect(_finished([_turn(_worked(closing: 'Fixed.\n\nShall I open a PR?\n'))]), isFalse);
      expect(_finished([_turn(_worked(closing: 'Fixed (should I push?)'))]), isFalse);
    });
    test('a question in the middle does not', () {
      expect(_finished([_turn(_worked(closing: 'Why did it fail? A stale cache.\nFixed.'))]), isTrue);
    });
    test('no closing prose at all still counts', () {
      expect(_finished([_turn([_user('go'), _tool()])]), isTrue);
    });
  });

  group('the operator spoke again', () {
    test('a sent prompt the host has not echoed yet is not finished', () {
      expect(_finished([_turn(_worked())], promptPending: true), isFalse);
    });
    test('a newer turn without work is not finished', () {
      expect(_finished([_turn(_worked()), _turn([_user('thanks!'), _prose('You are welcome.')])]), isFalse);
    });
  });
}
