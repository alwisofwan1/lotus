import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/agent/sticky_keys.dart';
import 'package:xterm/xterm.dart';

void main() {
  late DateTime now;
  late StickyKeys sticky;

  setUp(() {
    now = DateTime(2026, 10, 4, 12);
    sticky = StickyKeys(clock: () => now);
  });

  void later(int ms) => now = now.add(Duration(milliseconds: ms));

  group('ctrl', () {
    test('one tap holds it for the next key, then lets go', () {
      sticky.tap(Modifier.ctrl);
      expect(sticky.ctrl, StickyState.once);

      sticky.spend();
      expect(sticky.ctrl, StickyState.off);
    });

    test('a second tap close behind the first locks it', () {
      sticky.tap(Modifier.ctrl);
      later(200);
      sticky.tap(Modifier.ctrl);
      expect(sticky.ctrl, StickyState.locked);

      sticky
        ..spend()
        ..spend();
      expect(sticky.ctrl, StickyState.locked);
    });

    test('a second tap long after the first only lets go', () {
      sticky.tap(Modifier.ctrl);
      later(900);
      sticky.tap(Modifier.ctrl);
      expect(sticky.ctrl, StickyState.off);
    });

    test('a tap on a locked ctrl unlocks it', () {
      sticky
        ..tap(Modifier.ctrl)
        ..tap(Modifier.ctrl);
      later(900);
      sticky.tap(Modifier.ctrl);
      expect(sticky.ctrl, StickyState.off);
    });
  });

  test('alt sticks the same way, on its own', () {
    sticky.tap(Modifier.alt);
    expect(sticky.alt, StickyState.once);
    expect(sticky.ctrl, StickyState.off);
  });

  /// The point of the ticket: a letter from the phone's keyboard reaches the emulator as a
  /// key event, and the held ctrl has to ride on it.
  group('the emulator input handler', () {
    final terminal = Terminal();
    TerminalKeyboardEvent key(TerminalKey k) => TerminalKeyboardEvent(
          key: k,
          shift: false,
          ctrl: false,
          alt: false,
          state: terminal,
          altBuffer: false,
          platform: TerminalTargetPlatform.android,
        );

    test('adds a held ctrl to a plain letter', () {
      final handler = sticky.wrap(defaultInputHandler);
      expect(handler(key(TerminalKey.keyC)), isNull, reason: 'a plain c is text, not a key');

      sticky.tap(Modifier.ctrl);
      expect(handler(key(TerminalKey.keyC)), '\x03');
    });

    test('leaves a key alone when nothing is held', () {
      final handler = sticky.wrap(defaultInputHandler);
      expect(handler(key(TerminalKey.escape)), '\x1b');
    });
  });

  test('says so when it changes, so the bar can relight', () {
    var heard = 0;
    sticky.addListener(() => heard++);

    sticky
      ..tap(Modifier.ctrl)
      ..spend()
      ..spend();

    expect(heard, 2, reason: 'spending nothing is not a change');
  });
}
