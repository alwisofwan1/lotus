import 'package:flutter/material.dart';

import '../../../app/theme/theme.dart';
import '../../shared/field_glyphs.dart';
import '../../shared/tactile.dart';
import '../terminal_search.dart';

/// The one row a search needs: what is being looked for, how many there are, the two
/// directions, and `Done`.
///
/// **It takes the page header's place** while it is open (v4 tiket 07, B4): the page
/// hears it through `RawTerminal.onFinding` and steps its top bar aside, so a search costs
/// no extra row of output. It never covers the output — a bar over the text is a bar that
/// hides the answer it just found.
class FindBar extends StatefulWidget {
  const FindBar({required this.search, required this.onClose, super.key});

  final TerminalSearch search;
  final VoidCallback onClose;

  @override
  State<FindBar> createState() => _FindBarState();
}

class _FindBarState extends State<FindBar> {
  late final TextEditingController _field = TextEditingController(
    text: widget.search.query,
  );

  @override
  void dispose() {
    _field.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;

    return ListenableBuilder(
      listenable: widget.search,
      builder: (context, _) {
        final search = widget.search;
        final none = search.query.trim().isNotEmpty && search.hits.isEmpty;

        return Container(
          color: t.termBg,
          padding: const EdgeInsets.fromLTRB(12, 6, 4, 6),
          child: Row(
            children: [
              Expanded(
                child: Container(
                  key: const ValueKey('find-field'),
                  height: 40,
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  decoration: BoxDecoration(
                    color: t.raise,
                    borderRadius: context.shape.radius(ShapeRole.chip),
                    border: Border.all(color: t.lineStrong),
                  ),
                  child: Row(
                    children: [
                      // Dilukis, bukan `⌕` — lihat `SearchGlyph`: codepoint itu ada di HP ini
                      // tetapi bernama `TELEPHONE RECORDER`, jadi yang salah bentuknya.
                      SearchGlyph(color: t.dim, size: 14),
                      const SizedBox(width: 8),
                      Expanded(
                        child: TextField(
                          controller: _field,
                          autofocus: true,
                          // A search is not prose: the platform's helpfulness would
                          // capitalise the first letter of a flag and correct a filename
                          // into a word.
                          autocorrect: false,
                          enableSuggestions: false,
                          textCapitalization: TextCapitalization.none,
                          textInputAction: TextInputAction.search,
                          style: t.mono.copyWith(fontSize: 12.5, color: t.text),
                          cursorColor: t.text,
                          decoration: InputDecoration(
                            isDense: true,
                            border: InputBorder.none,
                            contentPadding: EdgeInsets.zero,
                            hintText: 'Find in output',
                            hintStyle: t.ui.copyWith(fontSize: 12.5, color: t.muted),
                          ),
                          onChanged: search.search,
                          onSubmitted: (_) => _go(search.next),
                        ),
                      ),
                      Text(
                        // Counted rather than merely marked: "2 / 5" says whether it is
                        // worth walking the rest, and `NONE` is an answer, not a blank.
                        none ? 'NONE' : '${search.position} / ${search.hits.length}',
                        style: t.mono.copyWith(
                          fontSize: 11,
                          color: none ? t.muted : t.dim,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(width: 4),
              _step(t, '▲', 'Previous match', () => _go(search.previous),
                  enabled: search.hits.isNotEmpty),
              _step(t, '▼', 'Next match', () => _go(search.next),
                  enabled: search.hits.isNotEmpty),
              Semantics(
                button: true,
                label: 'Done',
                excludeSemantics: true,
                child: InkWell(
                  onTap: widget.onClose,
                  borderRadius: context.shape.radius(ShapeRole.key),
                  child: Container(
                    height: kMinHitTarget,
                    alignment: Alignment.center,
                    padding: const EdgeInsets.symmetric(horizontal: 10),
                    child: Text(
                      'Done',
                      style: t.ui.copyWith(
                        fontSize: 13.5,
                        fontWeight: FontWeight.w600,
                        color: t.text,
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }

  void _go(VoidCallback move) {
    Tactile.chose();
    move();
  }

  /// 36 by 40: two of them and `Done` must fit beside a field still wide enough to type
  /// into on a 360dp screen.
  Widget _step(
    AppTokens t,
    String glyph,
    String label,
    VoidCallback onTap, {
    required bool enabled,
  }) => Semantics(
    button: true,
    enabled: enabled,
    label: label,
    excludeSemantics: true,
    child: InkWell(
      onTap: enabled ? onTap : null,
      borderRadius: context.shape.radius(ShapeRole.key),
      child: SizedBox(
        width: 36,
        height: 40,
        child: Center(
          child: Text(
            glyph,
            style: t.ui.copyWith(fontSize: 11, color: enabled ? t.dim : t.faint),
          ),
        ),
      ),
    ),
  );
}
