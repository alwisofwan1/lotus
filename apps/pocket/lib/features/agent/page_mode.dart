import 'package:flutter/foundation.dart';

/// The two equal views of one agent (ADR-6 addendum 2026-10-04).
enum AgentSurface { chat, terminal }

/// Which view is shown, what Terminal is doing, and whether it was ever opened.
///
/// Was `TerminalMode`, built around a sheet that rose over Chat. The sheet is gone (v4
/// tiket 03): Chat and Terminal are siblings, one tap apart on the header's switch, and
/// the one left behind keeps its state. The rules that made this worth a class survived
/// the change — keys and immersion only mean something on Terminal, and leaving Terminal
/// must take both away — so they still live in three lines here instead of at call sites.
@immutable
class PageMode {
  const PageMode({
    this.surface = AgentSurface.chat,
    this.live = false,
    this.immersive = false,
    this.everOpened = false,
  });

  /// Chat is the default: it is the view that does not depend on the pane's geometry, so
  /// a page opening straight into raw output would be unreadable on most cells.
  final AgentSurface surface;

  /// Whether keys reach the pane. Off whenever Terminal is not shown — a pane left live
  /// behind Chat would be taking keystrokes nobody can see.
  final bool live;

  /// Whether Terminal has taken the whole glass: no status bar, no header, floating
  /// controls instead of the dock. The landscape mode (v4 tiket 10) — turning the phone
  /// on Terminal enters it, turning it back or `⤡` leaves it.
  final bool immersive;

  /// Whether Terminal was ever shown, and so whether an emulator exists. Sticky: the
  /// emulator lives as long as the page, so its scroll and zoom are where the operator
  /// left them (tiket 02). Before the first visit there is nothing to lay out, and laying
  /// one out anyway is a cost paid by every page swiped past.
  final bool everOpened;

  bool get onTerminal => surface == AgentSurface.terminal;

  PageMode get showTerminal =>
      PageMode(surface: AgentSurface.terminal, live: live, immersive: immersive, everOpened: true);

  /// Forgets keys and immersion on purpose: every visit to Terminal starts the same way,
  /// and one tap gets the operator back to either.
  PageMode get showChat => PageMode(everOpened: everOpened);

  PageMode show(AgentSurface to) => to == AgentSurface.terminal ? showTerminal : showChat;

  /// Turning keys on is deliberate; turning them off is never wrong. A no-op on Chat.
  PageMode get toggleLive => onTerminal
      ? PageMode(surface: surface, live: !live, immersive: immersive, everOpened: true)
      : this;

  /// A no-op on Chat, so a stray call cannot hide the header over a view that needs it.
  PageMode get toggleImmersive => onTerminal
      ? PageMode(surface: surface, live: live, immersive: !immersive, everOpened: true)
      : this;

  /// Immersion set rather than flipped, for a rotation: it says which way the phone is.
  /// A no-op on Chat, for the reason [toggleImmersive] is.
  PageMode immersed(bool on) => onTerminal && on != immersive ? toggleImmersive : this;

  /// The narrowest thing system back undoes: keys, then immersion, then Terminal itself.
  /// Null on plain Chat, where back leaves the page.
  PageMode? get back {
    if (live) return toggleLive;
    if (immersive) return toggleImmersive;
    if (onTerminal) return showChat;
    return null;
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is PageMode &&
          other.surface == surface &&
          other.live == live &&
          other.immersive == immersive &&
          other.everOpened == everOpened;

  @override
  int get hashCode => Object.hash(surface, live, immersive, everOpened);
}
