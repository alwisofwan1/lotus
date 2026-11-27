import 'dart:convert';

import '../core/clock.dart';

/// Keep instrumentation bounded, non-notifying, and non-throwing on render paths (`plans/session-history-hardening/issues/01`, ADR-3).
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

  /// Metric names remain strings for the instrumentation format (`issues/01`).
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
