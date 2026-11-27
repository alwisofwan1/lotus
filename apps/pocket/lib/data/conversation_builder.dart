import '../models/conversation.dart';
import '../models/transcript.dart';

/// Match the host entry-to-parts conversion for older hosts; fixture tests guard drift (`issues/12`).
List<Turn> turnsFromEntries(List<TranscriptEntry> entries, Provenance provenance) {
  final builder = _Builder(provenance);
  for (final entry in entries) {
    builder.feed(entry);
  }
  return builder.turns();
}

/// The composite key `LiveTranscript._keyOf` dedupes on — and the host hashes into a part
/// id. Same key, same hash, same id on both sides of the wire.
String stableId(TranscriptEntry e) => fnv1a(
      '${e.timestamp.millisecondsSinceEpoch}|${e.event}|${e.title}|${e.toolTarget}|${e.body.length}',
    );

/// FNV-1a, 32-bit, hex — the host's `stableId`, character for character (UTF-16 units,
/// which is what `charCodeAt` reads).
String fnv1a(String key) {
  var h = 0x811c9dc5;
  for (final unit in key.codeUnits) {
    h ^= unit;
    h = (h * 0x01000193) & 0xffffffff;
  }
  return h.toRadixString(16).padLeft(8, '0');
}

/// `toolKindOf` from the host's `tool-kind.ts`.
String toolKindOf(String toolName) => switch (toolName.trim().toLowerCase()) {
      'read' || 'notebookread' => 'read',
      'edit' || 'multiedit' || 'write' || 'notebookedit' || 'apply_patch' => 'edit',
      'bash' || 'exec' || 'shell' => 'execute',
      'glob' || 'grep' || 'rg' => 'search',
      'websearch' || 'webfetch' || 'web.search' => 'fetch',
      'task' || 'agent' || 'todowrite' || 'taskcreate' => 'think',
      _ => 'other',
    };

bool _kindNamesAFile(String kind) =>
    kind == 'read' || kind == 'edit' || kind == 'delete' || kind == 'move';

class _Builder {
  _Builder(this.provenance);

  final Provenance provenance;
  final List<_Turn> _turns = [];
  String? _lastPrompt;
  bool _turnEnded = false;

  /// Whether the open turn came from a real `prompt-submit`. While it did, a differing
  /// `userPrompt` on a later entry is not a new turn — the two fields are clipped at
  /// different caps, so a long prompt would otherwise open a phantom turn on its next step.
  bool _openedBySubmit = false;
  int _seq = 0;

  _Turn? get _current => _turns.isEmpty ? null : _turns.last;

  List<Turn> turns() => [for (final t in _turns) t.freeze()];

  _Turn _open(DateTime at, String id) {
    final turn = _Turn('t-$id', at);
    _turns.add(turn);
    _turnEnded = false;
    return turn;
  }

  void feed(TranscriptEntry e) {
    final event = e.event.trim().toLowerCase();
    final id = stableId(e);

    if (event == 'prompt-submit') {
      final seq = _seq++;
      final turn = _open(e.timestamp, id);
      _lastPrompt = e.body;
      _openedBySubmit = true;
      if (e.body != '') {
        turn.parts.add(UserMessagePart(id: id, ts: e.timestamp, seq: seq, provenance: provenance, text: e.body));
      }
      return;
    }

    if (e.userPrompt != '' && (_turnEnded || (!_openedBySubmit && e.userPrompt != _lastPrompt))) {
      final seq = _seq++;
      final turn = _open(e.timestamp, '$id-p');
      _openedBySubmit = false;
      _lastPrompt = e.userPrompt;
      turn.parts.add(UserMessagePart(id: '$id-p', ts: e.timestamp, seq: seq, provenance: provenance, text: e.userPrompt));
    }

    final turn = _current ?? _open(e.timestamp, id);
    final seq = _seq++;

    switch (event) {
      case 'stop' || 'agent-response' || 'after-agent':
        if (e.body != '') {
          turn.parts.add(AssistantTextPart(
            id: id, ts: e.timestamp, seq: seq, provenance: provenance,
            text: e.body, streaming: false, truncated: e.bodyTruncated,
          ));
        }
        if (event == 'stop') {
          turn.endedAt = e.timestamp;
          turn.stopReason = 'end_turn';
          _turnEnded = true;
        }
      case 'tool-pre':
        // A question is not a call with a sentence for a title: its options and their words
        // have nowhere to live on one, and a client re-parsing a title draws them wrong.
        final asking = e.questions;
        if (asking != null && asking.isNotEmpty) {
          turn.parts.add(QuestionPart(
            id: id, ts: e.timestamp, seq: seq, provenance: provenance,
            questions: asking, toolCallId: e.toolCallId,
          ));
          break;
        }
        turn.parts.add(_toolCall(id, seq, e, 'in_progress'));
      case 'tool-post' || 'tool-post-failed':
        final status = event == 'tool-post' ? 'completed' : 'failed';
        // A question settles here too, and on a cell with a terminal this is the only way it
        // can: the operator answers or presses Esc at the keyboard, and the runner writes the
        // outcome to its own file.
        final asked = _openQuestion(turn, e.toolCallId);
        if (asked != null) {
          turn.parts[turn.parts.indexOf(asked)] = QuestionPart(
            id: asked.id, ts: asked.ts, seq: asked.seq, provenance: asked.provenance,
            questions: asked.questions, toolCallId: asked.toolCallId,
            answered: status == 'failed' ? null : (e.answers ?? const {}),
            cancelled: status == 'failed',
          );
          break;
        }
        final pending = _openCall(turn, e.title, e.toolCallId);
        if (pending == null) {
          turn.parts.add(_toolCall(id, seq, e, status));
        } else {
          final title = pending.title == '' && e.toolTarget != '' ? e.toolTarget : pending.title;
          turn.parts[turn.parts.indexOf(pending)] = ToolCallPart(
            id: pending.id, ts: pending.ts, seq: pending.seq, provenance: pending.provenance,
            toolCallId: pending.toolCallId, toolName: pending.toolName, title: title,
            kind: pending.kind, status: status, locations: pending.locations,
            files: _files(e, title) ?? pending.files,
          );
        }
      case 'error':
        turn.parts.add(ErrorPart(
          id: id, ts: e.timestamp, seq: seq, provenance: provenance,
          message: e.body != '' ? e.body : e.toolTarget, recoverable: false,
        ));
        if (e.title == 'Interrupted') {
          turn.endedAt = e.timestamp;
          turn.stopReason = 'cancelled';
          _turnEnded = true;
        }
      case 'notification' || 'needs-input':
        turn.parts.add(StatusPart(
          id: id, ts: e.timestamp, seq: seq, provenance: provenance,
          state: 'requires_action', detail: e.body != '' ? e.body : null,
        ));
      case 'session-start' || 'before-agent':
        turn.parts.add(StatusPart(id: id, ts: e.timestamp, seq: seq, provenance: provenance, state: 'running'));
      case 'session-end':
        turn.parts.add(StatusPart(id: id, ts: e.timestamp, seq: seq, provenance: provenance, state: 'ended'));
      default:
        final summary = e.toolTarget != '' ? e.toolTarget : e.body;
        if (summary == '' && e.title == '') break;
        if (e.title != '') {
          turn.parts.add(_toolCall(id, seq, e, 'completed'));
          break;
        }
        turn.parts.add(UnknownPart(id: id, ts: e.timestamp, seq: seq, provenance: provenance, rawType: e.event, summary: summary));
    }
  }

  ToolCallPart _toolCall(String id, int seq, TranscriptEntry e, String status) {
    final title = e.toolTarget != '' ? e.toolTarget : e.body;
    final kind = toolKindOf(e.title);
    return ToolCallPart(
      id: id, ts: e.timestamp, seq: seq, provenance: provenance,
      // The runner's own id when it reported one — that is what a result pairs against. The
      // part's id is the fallback for a hook drop, which carries none.
      toolCallId: e.toolCallId ?? id, toolName: e.title, title: title, kind: kind, status: status,
      locations: _kindNamesAFile(kind) && title != '' ? [title] : const [],
      files: _files(e, title) ?? const [],
    );
  }

  /// The call this result answers — **by id when there is one**, by tool name otherwise.
  ///
  /// The name is a fallback, not the rule: a hook drop carries no id, and two concurrent
  /// `Bash` calls are indistinguishable by name, so a result could settle the wrong one.
  static ToolCallPart? _openCall(_Turn turn, String toolName, String? toolCallId) {
    for (var i = turn.parts.length - 1; i >= 0; i--) {
      final p = turn.parts[i];
      if (p is! ToolCallPart || p.status != 'in_progress') continue;
      if (toolCallId != null) {
        if (p.toolCallId == toolCallId) return p;
        continue;
      }
      if (toolName == '' || toolName == 'Tool' || p.toolName == toolName) return p;
    }
    return null;
  }

  /// The question this result settles. Only ever by id: a question has no tool name.
  static QuestionPart? _openQuestion(_Turn turn, String? toolCallId) {
    if (toolCallId == null) return null;
    for (var i = turn.parts.length - 1; i >= 0; i--) {
      final p = turn.parts[i];
      if (p is! QuestionPart || p.toolCallId != toolCallId) continue;
      return p.isOpen ? p : null;
    }
    return null;
  }

  /// Null — not an empty list — when the entry carried neither count.
  static List<FileDiff>? _files(TranscriptEntry e, String path) {
    if (e.linesAdded == null && e.linesRemoved == null) return null;
    return [FileDiff(path: path, op: 'modify', additions: e.linesAdded, deletions: e.linesRemoved)];
  }
}

class _Turn {
  _Turn(this.turnId, this.startedAt);
  final String turnId;
  final DateTime startedAt;
  DateTime? endedAt;
  String? stopReason;
  final List<Part> parts = [];

  Turn freeze() => Turn(
        turnId: turnId, startedAt: startedAt, endedAt: endedAt, stopReason: stopReason,
        parts: List.unmodifiable(parts),
      );
}
