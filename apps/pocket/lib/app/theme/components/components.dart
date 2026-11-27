import 'package:flutter/material.dart';

import '../app_tokens.dart';
import '../tokens/app_shape.dart';

/// A modal bottom sheet's look, derived from semantic tokens and never authored per theme.
@immutable
class SheetTokens {
  const SheetTokens({required this.fill, required this.shape, required this.barrier});

  final Color fill;
  final ShapeBorder shape;
  final Color barrier;
}

/// The amber banner on a permission or question card.
@immutable
class AskCardTokens {
  const AskCardTokens({required this.banner, required this.label});

  final Color banner;
  final Color label;
}

/// Component tokens: pure functions of the semantic tiers, so a new theme gets them free.
@immutable
class ComponentTokens {
  ComponentTokens(AppTokens t, AppShape s)
      : sheet = SheetTokens(
          fill: Color.alphaBlend(t.raise, t.bg),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(s[ShapeRole.sheet])),
          ),
          barrier: t.scrim,
        ),
        askCard = AskCardTokens(banner: t.waiting, label: t.onWaiting);

  final SheetTokens sheet;
  final AskCardTokens askCard;
}

extension ComponentTokensContext on BuildContext {
  ComponentTokens get components => ComponentTokens(tokens, shape);
}
