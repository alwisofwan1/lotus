import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/intro_seen.dart';

import '../support/fake_security.dart';

void main() {
  late InMemorySecureStore store;

  setUp(() => store = InMemorySecureStore());

  test('a phone that has never run the app has not seen the intro', () async {
    final seen = IntroSeen(store);
    await seen.load();

    expect(seen.isSeen, isFalse);
  });

  test('finishing the intro survives a relaunch', () async {
    await IntroSeen(store).markSeen();

    // A second instance, the way a cold start builds one: nothing carried over
    // except what actually reached storage.
    final next = IntroSeen(store);
    await next.load();

    expect(next.isSeen, isTrue);
    expect(store.writes, 1);
  });

  test('marking twice writes once', () async {
    final seen = IntroSeen(store);
    await seen.load();
    await seen.markSeen();
    await seen.markSeen();

    // Not an optimisation. `markSeen` is called from a Skip tap and from the last
    // pane's Continue, and both can land — a Keystore write per tap would be a
    // write the operator did not ask for.
    expect(store.writes, 1);
  });

  test('an unreadable value is not a seen intro', () async {
    store.entries[IntroSeen.key] = 'perhaps';
    final seen = IntroSeen(store);
    await seen.load();

    // Erring towards showing it again: the intro costs three taps, and the state
    // it guards is "this operator has never used Pocket".
    expect(seen.isSeen, isFalse);
  });
}
