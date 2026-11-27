import 'package:flutter/widgets.dart';

/// Shared timings. Not themed, so plain constants rather than a ThemeExtension.
abstract final class AppMotion {
  static const Duration swap = Duration(milliseconds: 180);
  static const Duration settle = Duration(milliseconds: 220);
  static const Curve curve = Curves.easeOutQuart;

  /// [d], or zero when the phone asks for no animation.
  static Duration of(BuildContext context, Duration d) =>
      MediaQuery.disableAnimationsOf(context) ? Duration.zero : d;
}
