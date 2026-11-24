import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/agent/key_outbox.dart';

void main() {
  /// v4 tiket 05: the first test this class has. Fast typing over a slow link is the case
  /// it exists for — `ls -la` must never reach the PTY as `ls -al`.
  test('keeps the order of fast typing, one request at a time', () async {
    final sent = <String>[];
    var inFlight = 0;
    var mostAtOnce = 0;
    final outbox = KeyOutbox((data) async {
      inFlight++;
      mostAtOnce = inFlight > mostAtOnce ? inFlight : mostAtOnce;
      // A slow link: every write waits a turn of the event loop, so typing piles up.
      await Future<void>.delayed(const Duration(milliseconds: 1));
      sent.add(data);
      inFlight--;
    });

    const typed = 'ls -la && git status --short\r';
    for (final char in typed.split('')) {
      outbox.add(char);
    }
    while (!outbox.isIdle) {
      await Future<void>.delayed(const Duration(milliseconds: 1));
    }

    expect(sent.join(), typed);
    expect(mostAtOnce, 1);
    // Batched, not one request per key: what piles up during a send leaves together.
    expect(sent.length, lessThan(typed.length));
  });

  test('an overflow goes before what was typed after it', () async {
    final sent = <String>[];
    final gate = Completer<void>();
    final outbox = KeyOutbox((data) async {
      sent.add(data);
      if (sent.length == 1) await gate.future;
    }, maxBatch: 4);

    outbox.add('abcdef');
    outbox.add('gh');
    gate.complete();
    while (!outbox.isIdle) {
      await Future<void>.delayed(Duration.zero);
    }

    expect(sent.join(), 'abcdefgh');
    expect(sent.every((s) => s.length <= 4), isTrue);
  });
}
