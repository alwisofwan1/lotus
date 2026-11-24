import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/mutation_outcome.dart';
import 'package:lotus_pocket/features/shared/mutation_notice.dart';
import 'package:lotus_pocket/hosts/host_failure.dart';

String? notice(MutationOutcome outcome) => noticeFor(outcome, agent: 'Atlas');

void main() {
  test('the window not being on a board names the fix, not a refusal', () {
    final notice = noticeFor(
      const MutationHostNotReady('HTTP 503: no active Lotus workspace UI'),
      agent: 'codex',
    );
    expect(notice, contains('no project is open'));
    expect(notice, isNot(contains('503')));
    expect(notice, isNot(contains('refused')));
  });

  test('a landed dispatch says nothing — the reply is the confirmation', () {
    expect(notice(const MutationSent()), isNull);
  });

  test('a refused gate is not worded as an error', () {
    final text = notice(const MutationRefused())!;

    // The gate doing its job is not a fault, and copy that implies otherwise teaches the
    // operator to distrust it.
    expect(text, contains('Not sent'));
    expect(text.toLowerCase(), isNot(contains('error')));
    expect(text.toLowerCase(), isNot(contains('failed')));
  });

  group('expired and revoked end in the same place, but are not the same sentence', () {
    test('revoked names the desktop, because a person did it', () {
      expect(
        notice(const MutationNeedsPairing(cause: CredentialRevoked()))!,
        contains('revoked from the desktop'),
      );
    });

    test('expired names the clock, so nobody hunts for a mistake they did not make', () {
      final text = notice(const MutationNeedsPairing(cause: CredentialExpired()))!;

      expect(text, contains('expired'));
      expect(text, isNot(contains('revoked')));
    });

    test('both point at pairing again, which is the only way back in either way', () {
      for (final cause in [const CredentialRevoked(), const CredentialExpired(), null]) {
        expect(notice(MutationNeedsPairing(cause: cause))!, contains('Pair again'));
      }
    });
  });

  test('a dead pane names the agent and the move that fixes the list', () {
    final text = notice(const MutationNoLiveSession('p-1'))!;

    expect(text, contains('Atlas'));
    expect(text, contains('refresh'));
  });

  test('a 400 carries the host\'s own words, unsoftened', () {
    // It is our bug. Friendlier copy would hide the bug along with the wording.
    expect(notice(const MutationRejected('text is required'))!, contains('text is required'));
  });

  group('unreachable names the machine-side action, since none can be fixed from the phone',
      () {
    test('asleep', () {
      expect(notice(const MutationUnreachable(HostAsleep()))!, contains('asleep'));
    });

    test('asleep names what the operator does, and promises nothing on the phone\'s behalf',
        () {
      final text = notice(const MutationUnreachable(HostAsleep()))!;

      // A regression guard, not a style preference. Until 2026-08-09 this read "It will
      // pick this up when it wakes" — an outbox that has never existed anywhere in
      // `data/`. Retry is a tap on the pending line, that line is dropped when the
      // operator swipes to another cell, and on Home the composer has already cleared
      // the text by the time this sentence is shown. Measured against a real sleeping
      // MacBook: the message sat unsent while the notice said otherwise.
      expect(text, contains('send again'));
      expect(
        text,
        isNot(matches(RegExp(r'will\s+\S{0,12}\s*\b(pick|send|deliver|retry)\b',
            caseSensitive: false))),
        reason: 'the snackbar names the cause; the pending line carries the retry',
      );
    });

    test('Lotus not running is told apart from asleep', () {
      final text = notice(const MutationUnreachable(LotusNotRunning()))!;

      expect(text, contains('not running'));
      expect(text, isNot(contains('asleep')));
    });

    test('no route names Tailscale by name', () {
      expect(notice(const MutationUnreachable(TailnetDown()))!, contains('Tailscale'));
    });

    test('an unclassified failure stays vague rather than guessing', () {
      final text = notice(const MutationUnreachable(HostUnknownFailure()))!;

      // A wrong diagnosis sends the operator to fix something that was never broken.
      expect(text, contains('Could not reach'));
      expect(text, isNot(contains('asleep')));
      expect(text, isNot(contains('Tailscale')));
    });
  });

  test('an unpaired host says so plainly', () {
    expect(notice(const MutationUnknownHost())!, contains('no longer paired'));
  });

  test('every outcome except a landed one has something to say', () {
    // The switch is exhaustive by the sealed type; this pins that none of the branches
    // returns an empty string, which would render as a blank snackbar.
    final all = <MutationOutcome>[
      const MutationRefused(),
      const MutationNeedsPairing(),
      const MutationNoLiveSession('p-1'),
      const MutationRejected('why'),
      const MutationUnreachable(HostAsleep()),
      const MutationUnknownHost(),
    ];

    for (final outcome in all) {
      expect(notice(outcome), isNotNull, reason: outcome.code);
      expect(notice(outcome), isNotEmpty, reason: outcome.code);
    }
  });
}
