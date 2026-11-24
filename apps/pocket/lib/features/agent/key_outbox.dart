import 'dart:async';

/// Keystrokes leaving the phone: **in order, and as few requests as the typing allows.**
///
/// Without this, every character was its own `POST` and nothing sequenced them. Two
/// consequences, and the second is the worse one:
///
/// * **Latency stacked.** Typing five characters opened five requests over a tailnet,
///   and the pane could not draw any of them until the host's next read.
/// * **Order was not guaranteed.** Concurrent requests arrive when they arrive, so
///   `ls -la` could reach the PTY as `ls -al`. A terminal that transposes what you typed
///   is worse than a slow one: slow is visible, transposed is a command you did not write.
///
/// So bytes go into a buffer and one sender drains it. Whatever accumulates while a
/// request is in flight leaves as a single write when it returns — a burst of typing
/// collapses into one request, and a slow link makes the batches larger rather than the
/// queue longer. That is the same shape a terminal's own line discipline has, for the
/// same reason.
class KeyOutbox {
  KeyOutbox(this.send, {this.maxBatch = 4096});

  /// Sends one write and completes when the host has answered. Its `Future` is what
  /// serialises this queue, so a caller that returns before the write lands would give
  /// the ordering guarantee away.
  final Future<void> Function(String data) send;

  /// Matches `MAX_INPUT_CHARS` on the host. A batch past it would be refused whole, so
  /// it is split here rather than lost there.
  final int maxBatch;

  final StringBuffer _pending = StringBuffer();
  bool _draining = false;
  bool _disposed = false;

  /// Whether anything is waiting or in flight — read by tests, and by nothing else.
  bool get isIdle => !_draining && _pending.isEmpty;

  void add(String data) {
    if (_disposed || data.isEmpty) return;
    _pending.write(data);
    unawaited(_drain());
  }

  Future<void> _drain() async {
    if (_draining) return;
    _draining = true;
    try {
      while (_pending.isNotEmpty && !_disposed) {
        final held = _pending.toString();
        _pending.clear();
        final batch = held.length <= maxBatch ? held : held.substring(0, maxBatch);
        // Put the overflow back at the *front*: it was typed before anything that
        // arrives during this send, and a queue that reorders on overflow would be the
        // bug this class exists to remove.
        if (batch.length < held.length) {
          final rest = held.substring(batch.length);
          final queued = _pending.toString();
          _pending
            ..clear()
            ..write(rest)
            ..write(queued);
        }
        await send(batch);
      }
    } finally {
      _draining = false;
    }
  }

  /// Drops whatever has not left yet. Called when the pane stops taking keys — sending
  /// the tail of a sentence into a terminal the operator has closed is not a courtesy.
  void dispose() {
    _disposed = true;
    _pending.clear();
  }
}
