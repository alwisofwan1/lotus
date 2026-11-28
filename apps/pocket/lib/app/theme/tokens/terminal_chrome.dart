import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// The theme for everything drawn on the terminal ground, when it differs from the app's
/// (a light theme keeps a dark terminal). Absent means the app theme already reads there.
@immutable
class TerminalChrome extends ThemeExtension<TerminalChrome> {
  const TerminalChrome(this.theme);

  final ThemeData theme;

  @override
  TerminalChrome copyWith({ThemeData? theme}) => TerminalChrome(theme ?? this.theme);

  @override
  TerminalChrome lerp(ThemeExtension<TerminalChrome>? other, double t) =>
      other is TerminalChrome && t >= 0.5 ? other : this;
}

extension TerminalChromeContext on BuildContext {
  /// The theme to draw chrome over `termGround` with.
  ThemeData get terminalChrome => Theme.of(this).extension<TerminalChrome>()?.theme ?? Theme.of(this);
}

/// Status and navigation bar icons that read on [ground].
SystemUiOverlayStyle overlayFor(Color ground) {
  final dark = ground.computeLuminance() < 0.5;
  final icons = dark ? Brightness.light : Brightness.dark;
  return SystemUiOverlayStyle(
    statusBarColor: Colors.transparent,
    statusBarIconBrightness: icons,
    statusBarBrightness: dark ? Brightness.dark : Brightness.light, // iOS names the ground
    systemNavigationBarIconBrightness: icons,
  );
}
