import 'dart:convert';

import '../core/clock.dart';

/// Fase 0 instrumentation (`plans/session-history-hardening/issues/01`) — counting,
/// not fixing.
///
/// ADR-3 of that plan requires a measured number before any of the ring sizes on this
/// phone (`OutputBuffer.maxBytes`, `LiveTranscript.maxEntries`) or the rebuild the
/// terminal does (`TerminalFeed._build`) may change. This is the seam that counts,
/// so the questions in `issues/01` have an answer instead of a guess.
///
/// **Deliberately not a `ChangeNotifier`.** `TerminalFeed._settle` already documents
/// what notifying per chunk costs — jank that reads as input lag — and a busy pane can
/// call [record] on every chunk it drops. Adding a listener to that path would recreate
/// exactly the problem this app already paid down once.
///
/// **Never throws.** [record] is called from inside the render and stream paths
/// (`OutputBuffer._trim`, `LiveTranscript._sortAndTrim`, `TerminalFeed._build`), so a
/// bug in this class must not be able to break any of them — CLAUDE.md's instrumentation
/// rule, applied literally.
///
/// **In memory only, capped, and read by copying it off the screen.** Unlike the
/// desktop side of the same ticket, a phone has no `state dir` of its own to spill a
/// JSONL into, and `issues/01` says a share/copy action is enough. [capacity] exists
/// so a session long enough to matter (the ticket asks for one over 30 minutes) cannot
/// grow this without bound; [droppedLines] says when that ceiling was actually hit, so
/// a summary built from [copyText] is never silently short without saying so.
class MeasurementLog {
  MeasurementLog({this.now = systemClock, this.capacity = 5000});

  final Clock now;
  final int capacity;

  final List<String> _lines = [];
  int _dropped = 0;

  /// How many lines fell off the front to stay inside [capacity]. Zero on every
  /// session this is actually sized for.
  int get droppedLines => _dropped;

  /// How many lines are held right now.
  int get length => _lines.length;

  /// Appends one line in the fixed record format from `issues/01`:
  /// `{"at": epochMs, "layer": "pocket", "metric": ..., "value": ..., "labels": {...}}`.
  ///
  /// [metric] is one of the five names that ticket fixes — `terminal.rebuild`,
  /// `output.evicted`, `output.missing`, `transcript.dropped`, `buffer.cleared` — kept
  /// as a plain string rather than an enum because this is throwaway instrumentation,
  /// not a contract another layer parses.
  void record(String metric, num value, {Map<String, String> labels = const {}}) {
    try {
      final line = jsonEncode({
        'at': now().millisecondsSinceEpoch,
        'layer': 'pocket',
        'metric': metric,
        'value': value,
        'labels': labels,
      });
      _lines.add(line);
      if (_lines.length > capacity) {
        _lines.removeAt(0);
        _dropped++;
      }
    } catch (_) {
      // See the class doc: a measurement that could crash the path it is watching
      // would cost more than the number it was trying to produce.
    }
  }

  /// Every line held, oldest first, newline-joined — what a copy/share action on the
  /// diagnostics screen hands to the clipboard. [droppedLines] is reported alongside
  /// this by the caller rather than folded in here, so the text stays strict JSONL —
  /// one JSON object per line, exactly as `issues/01` fixes the format.
  String copyText() => _lines.join('\n');
}
