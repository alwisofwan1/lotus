import 'package:flutter/material.dart';

import 'palettes/classic.dart';
import 'tokens/app_type.dart';
import 'tokens/color_role.dart';

/// The smallest a control may be, in logical pixels: 44, what the send button and mic use.
const double kMinHitTarget = 44;

/// Colours and base fonts as one [ThemeExtension], read as `context.tokens`.
///
/// A facade: storage is [AppColors] and [AppType], so ==, hashCode and lerp cannot miss a
/// role. The getter names are the ones widgets already use. Rationale: `docs/theme.md`.
@immutable
class AppTokens extends ThemeExtension<AppTokens> {
  const AppTokens({required this.colors, required this.fonts});

  final AppColors colors;
  /// Not `type`: that name is ThemeExtension's lookup key, and shadowing it unregisters us.
  final AppType fonts;

  /// The classic dark variant: what `buildAppTheme()` builds with no argument.
  static AppTokens get dark => classic.dark.tokens;

  Color get bg => colors[ColorRole.ground];
  Color get raise => colors[ColorRole.raised];
  Color get raise2 => colors[ColorRole.track];
  Color get termBg => colors[ColorRole.termGround];
  Color get key => colors[ColorRole.key];
  Color get keyHi => colors[ColorRole.keyActive];
  Color get text => colors[ColorRole.text];
  Color get dim => colors[ColorRole.text2];
  Color get muted => colors[ColorRole.text3];
  Color get faint => colors[ColorRole.ornament];
  Color get line => colors[ColorRole.hairline];
  Color get lineStrong => colors[ColorRole.hairlineStrong];
  Color get waiting => colors[ColorRole.waiting];
  Color get onWaiting => colors[ColorRole.onWaiting];
  Color get live => colors[ColorRole.live];
  Color get error => colors[ColorRole.error];
  Color get onError => colors[ColorRole.onError];
  Color get scrim => colors[ColorRole.scrim];
  Color get shadow => colors[ColorRole.shadow];
  Color get camera => colors[ColorRole.camera];
  Color get onCamera => colors[ColorRole.onCamera];
  Color get onCamera2 => colors[ColorRole.onCamera2];
  Color get onCamera3 => colors[ColorRole.onCamera3];

  TextStyle get mono => fonts[TypeRole.mono];
  TextStyle get ui => fonts[TypeRole.ui];
  TextStyle get serif => fonts[TypeRole.serif];

  @override
  AppTokens copyWith({AppColors? colors, AppType? fonts}) =>
      AppTokens(colors: colors ?? this.colors, fonts: fonts ?? this.fonts);

  @override
  AppTokens lerp(ThemeExtension<AppTokens>? other, double t) {
    // Null when the other ThemeData has no AppTokens at all.
    if (other is! AppTokens) return this;
    return AppTokens(colors: colors.lerp(other.colors, t), fonts: fonts.lerp(other.fonts, t));
  }

  @override
  bool operator ==(Object other) =>
      other is AppTokens && other.colors == colors && other.fonts == fonts;

  @override
  int get hashCode => Object.hash(colors, fonts);
}

/// `context.tokens`: one seam, so a theme built without tokens fails here with a reason.
extension AppTokensContext on BuildContext {
  AppTokens get tokens {
    final found = Theme.of(this).extension<AppTokens>();
    assert(
      found != null,
      'AppTokens missing from Theme — build it with buildAppTheme(), not ThemeData() directly.',
    );
    return found!;
  }

  AppColors get colors => tokens.colors;
}
