import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/core/transport.dart';
import 'package:lotus_pocket/hosts/host_failure.dart';

/// `issues/06`: "gagal terhubung" is not enough, because each cause has a different
/// next move. These tests pin the one distinction that is easy to get wrong.
void main() {
  test('no route means the tailnet, not the host', () {
    final failure = HostFailure.fromTransport(routable: false, refused: false, timedOut: true);

    expect(failure, isA<TailnetDown>());
  });

  /// The distinction the whole taxonomy rests on: a sleeping machine never answers,
  /// while an awake machine with no Lotus **refuses**. Collapsing these two sends
  /// the operator to wake a laptop that was never asleep.
  test('refused means Lotus is not running; silence means the host is asleep', () {
    final refused = HostFailure.fromTransport(routable: true, refused: true, timedOut: false);
    final silent = HostFailure.fromTransport(routable: true, refused: false, timedOut: true);

    expect(refused, isA<LotusNotRunning>());
    expect(silent, isA<HostAsleep>());
    expect(refused.code, isNot(silent.code));
  });

  test('an unclassified failure stays unclassified rather than guessing', () {
    final failure = HostFailure.fromTransport(routable: true, refused: false, timedOut: false);

    expect(failure, isA<HostUnknownFailure>());
    expect(failure.retryable, isTrue);
  });

  test('expired and revoked are different answers to the same 401', () {
    const expired = CredentialExpired();
    const revoked = CredentialRevoked();

    expect(expired.code, isNot(revoked.code));
    // Neither is retryable on its own, but only one of them means "pair again" —
    // the UI decides from the type, never from the status code alone.
    expect(expired.retryable, isFalse);
    expect(revoked.retryable, isFalse);
  });

  test('only causes the operator cannot fix are worth retrying by themselves', () {
    expect(const TailnetDown().retryable, isTrue);
    expect(const HostAsleep().retryable, isTrue);
    expect(const LotusNotRunning().retryable, isFalse);
  });

  test('a refused upgrade is its own state, and not retryable', () {
    // Not CredentialExpired: Dart drops the status code, so calling it auth would be a
    // guess dressed as a fact. Not LotusNotRunning either — something answered. What is
    // known is that the host refused, and that no amount of retrying changes it.
    final failure = HostFailure.fromCause(TransportCause.rejected);
    expect(failure, isA<HostRefused>());
    expect(failure.retryable, isFalse);
  });
}