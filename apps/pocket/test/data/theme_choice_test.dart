import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/data/theme_choice.dart';

import '../support/fake_security.dart';

void main() {
  late InMemorySecureStore store;

  setUp(() => store = InMemorySecureStore());

  test('a fresh install has no stored choice', () async {
    final choice = ThemeChoice(store);
    await choice.load();
    expect(choice.themeId, isNull);
    expect(choice.appearance, isNull);
  });

  test('a choice survives a relaunch', () async {
    await ThemeChoice(store).save(themeId: 'classic', appearance: Appearance.dark);

    final next = ThemeChoice(store);
    await next.load();
    expect(next.themeId, 'classic');
    expect(next.appearance, Appearance.dark);
  });

  test('saving the same choice twice writes nothing the second time', () async {
    final choice = ThemeChoice(store);
    await choice.save(themeId: 'graphite', appearance: Appearance.system);
    final writes = store.writes;
    await choice.save(themeId: 'graphite', appearance: Appearance.system);
    expect(store.writes, writes);
  });

  test('an unreadable appearance reads as no choice', () async {
    await store.write(ThemeChoice.appearanceKey, 'sepia');
    final choice = ThemeChoice(store);
    await choice.load();
    expect(choice.appearance, isNull);
  });
}
