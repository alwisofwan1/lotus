import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/agent/page_mode.dart';

void main() {
  test('Chat is the default, and nothing exists for Terminal until it is shown', () {
    const mode = PageMode();
    expect(mode.surface, AgentSurface.chat);
    expect(mode.everOpened, isFalse);
    expect(mode.back, isNull, reason: 'plain Chat lets the page pop');
  });

  test('back undoes the narrowest thing first: keys, immersive, Terminal, page', () {
    final deepest = const PageMode().showTerminal.toggleImmersive.toggleLive;
    expect(deepest.live && deepest.immersive && deepest.onTerminal, isTrue);

    final keysOff = deepest.back!;
    expect((keysOff.live, keysOff.immersive, keysOff.onTerminal), (false, true, true));

    final shown = keysOff.back!;
    expect((shown.live, shown.immersive, shown.onTerminal), (false, false, true));

    final chat = shown.back!;
    expect(chat.surface, AgentSurface.chat);
    expect(chat.everOpened, isTrue, reason: 'the emulator outlives the visit');

    expect(chat.back, isNull);
  });

  test('leaving Terminal takes keys and immersive with it', () {
    final chat = const PageMode().showTerminal.toggleImmersive.toggleLive.showChat;
    expect((chat.live, chat.immersive), (false, false));
    expect(chat.showTerminal.immersive, isFalse, reason: 'every visit starts the same way');
  });

  test('keys and immersive are no-ops on Chat', () {
    const chat = PageMode();
    expect(chat.toggleLive, chat);
    expect(chat.toggleImmersive, chat);
  });

  test('immersed sets rather than flips, and only on Terminal (v4 tiket 10)', () {
    final terminal = const PageMode().showTerminal;
    expect(terminal.immersed(true).immersive, isTrue);
    expect(terminal.immersed(true).immersed(true).immersive, isTrue, reason: 'a second rotation event');
    expect(terminal.immersed(true).immersed(false), terminal);
    expect(const PageMode().immersed(true), const PageMode());
  });
}
