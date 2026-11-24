import 'dart:async';

import '../../data/output_buffer.dart';
import '../../models/host_id.dart';

/// How long typing takes to come back (v4 tiket 12) — counting, not fixing.
///
/// Two numbers go to [OutputBuffer.measurements], the log Settings copies out:
///
/// * `input.post` — one `POST /m/cell/:id/input`, send to answer. What HTTP costs.
/// * `input.echo` — the first key not yet answered, to the first bytes this pane prints
///   after it. What the operator feels. Taken when the bytes reach the buffer; the
///   emulator draws them on the next frame, so the screen is at most one frame later.
///
/// **Read it on a quiet pane.** Output that was coming anyway (an agent mid-turn) arrives
/// "after" a key without being its echo, and makes the number look better than it is.
///
/// Replies the emulator sends by itself (cursor reports, focus, colour answers) leave by
/// the same door as keys. They are not a person typing, so they start no clock.
class InputLatencyProbe {
  InputLatencyProbe(this.buffer, this.cell) {
    _chunks = buffer.writes.listen((_) => _echoed());
  }

  final OutputBuffer buffer;
  final CellRef cell;

  final Stopwatch _clock = Stopwatch()..start();
  late final StreamSubscription<String> _chunks;

  /// When the oldest key without an echo was pressed. Null when nothing is waiting.
  int? _pressedAt;

  static final RegExp _report = RegExp(r'^\x1b(\[[\d;?>$]*[RcyIO]|[\]P])');

  /// A key left for the pane. Answers [data] so it reads inline at the call site.
  String pressed(String data) {
    if (_pressedAt == null && !_report.hasMatch(data)) {
      _pressedAt = _clock.elapsedMilliseconds;
    }
    return data;
  }

  /// [send], timed.
  Future<void> Function(String) timed(Future<void> Function(String) send) =>
      (data) async {
        final start = _clock.elapsedMilliseconds;
        await send(data);
        _record('input.post', _clock.elapsedMilliseconds - start, data.length);
      };

  void _echoed() {
    final at = _pressedAt;
    if (at == null || buffer.watching != cell) return;
    _pressedAt = null;
    _record('input.echo', _clock.elapsedMilliseconds - at, null);
  }

  void _record(String metric, int ms, int? bytes) => buffer.measurements.record(
    metric,
    ms,
    labels: {'paneId': cell.paneId, 'bytes': ?bytes?.toString()},
  );

  void dispose() => _chunks.cancel();
}
