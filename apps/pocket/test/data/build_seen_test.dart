import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/build_seen.dart';
import 'package:lotus_pocket/models/app_build.dart';

import '../support/fake_security.dart';

AppBuild build(int n) => AppBuild(version: '1.0.0', buildNumber: n);

void main() {
  late InMemorySecureStore store;

  setUp(() => store = InMemorySecureStore());

  test('a fresh install is not an update', () async {
    final seen = BuildSeen(store, current: build(100));
    await seen.load(returning: false);

    expect(seen.justUpdated, isFalse);
    expect(store.entries[BuildSeen.key], '100');
  });

  test('a phone that predates the stored build, but has used Pocket, was updated', () async {
    final seen = BuildSeen(store, current: build(100));
    await seen.load(returning: true);

    expect(seen.justUpdated, isTrue);
  });

  test('a newer build announces once, then stays quiet on relaunch', () async {
    store.entries[BuildSeen.key] = '100';

    final first = BuildSeen(store, current: build(200));
    await first.load(returning: true);
    expect(first.justUpdated, isTrue);

    final relaunch = BuildSeen(store, current: build(200));
    await relaunch.load(returning: true);
    expect(relaunch.justUpdated, isFalse);
  });

  test('reinstalling the same build writes nothing and says nothing', () async {
    store.entries[BuildSeen.key] = '200';
    final seen = BuildSeen(store, current: build(200));
    await seen.load(returning: true);

    expect(seen.justUpdated, isFalse);
    expect(store.writes, 0);
  });

  test('an older build is recorded but not called an update', () async {
    store.entries[BuildSeen.key] = '300';
    final seen = BuildSeen(store, current: build(200));
    await seen.load(returning: true);

    expect(seen.justUpdated, isFalse);
    expect(store.entries[BuildSeen.key], '200');
  });
}
