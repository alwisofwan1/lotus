import 'package:flutter/material.dart';
import 'package:gpt_markdown/custom_widgets/markdown_config.dart';
import 'package:gpt_markdown/gpt_markdown.dart';

import '../../../app/theme/theme.dart';

/// A markdown table, drawn the way this screen draws everything else.
///
/// **What it replaces was not a style disagreement, it was a different design.**
/// Measured 2026-09-16 by rendering a three-column table through `AgentProse` in a
/// widget test and reading the widget back: `gpt_markdown` builds a Material [Table]
/// with `TableBorder.all` in `onSurface` — which this app maps to `tokens.text`, so
/// every cell came out boxed in near-white `#F7F2EA` lines — over a header filled with
/// `surfaceContainerHighest`. A grid of bright boxes on a screen whose own rule is
/// *no cards, no fences, structure carried by typeface and space*.
///
/// Tables are 4% of real assistant messages (the count `pubspec.yaml` records), so this
/// is a small surface. It is also the one markdown construct that cannot be re-flowed:
/// a table narrower than its content is not a smaller table, it is an unreadable one.
///
/// So this keeps the two decisions the code block already made and the package did not:
///
/// * **Hairlines under rows, never around cells.** `line` is the same rule [DayMark]
///   spends on a day boundary — it separates without enclosing. Vertical rules are
///   dropped entirely; the column gap does that job.
/// * **It scrolls sideways rather than squeezing.** Same argument as `_CodeBlock` in
///   `agent_prose.dart`, from the same measurement: 93 columns of real agent output
///   against a 390px phone. A `Table` distributes its width across columns, so a wide
///   one compresses every cell until each word breaks; this gives each column its own
///   measured width and moves the whole thing under the finger.
class ProseTable extends StatelessWidget {
  const ProseTable({required this.rows, required this.config, super.key});

  final List<CustomTableRow> rows;

  /// Passed through so each cell renders as markdown rather than as raw text — a cell
  /// carrying `**bold**` or `` `code` `` is common enough that dropping to [Text] here
  /// would reintroduce, inside tables, exactly the defect `AgentProse` exists to fix.
  final GptMarkdownConfig config;

  /// Wide enough that a timestamp or a `1920×1080@30` cell stays on one line, narrow
  /// enough that three of them fit a 390px phone with the page's own 36px of gutter.
  static const double _columnWidth = 118;

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    final body = rows.where((row) => !row.isHeader).toList();
    final header = rows.where((row) => row.isHeader).toList();
    final columns = rows.fold<int>(0, (max, row) => row.fields.length > max ? row.fields.length : max);
    if (columns == 0) return const SizedBox.shrink();

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 10),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            for (final row in header) _headerRow(t, row, columns),
            if (header.isNotEmpty) _rule(t, columns),
            for (final row in body) ...[
              _bodyRow(context, t, row, columns),
              _rule(t, columns),
            ],
          ],
        ),
      ),
    );
  }

  Widget _rule(AppTokens t, int columns) => SizedBox(
        width: _columnWidth * columns,
        child: Container(height: 1, color: t.line),
      );

  /// Column labels are the app talking, not the agent — mono, small, spaced, and in
  /// `faint`, which WCAG 1.4.11 covers because they label rather than carry the answer.
  Widget _headerRow(AppTokens t, CustomTableRow row, int columns) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: List.generate(columns, (i) {
          final field = i < row.fields.length ? row.fields[i] : null;
          return SizedBox(
            width: _columnWidth,
            child: Padding(
              padding: const EdgeInsets.only(right: 14, bottom: 8),
              child: Text(
                (field?.data ?? '').trim().toUpperCase(),
                textAlign: field?.alignment,
                style: t.mono.copyWith(
                  fontSize: 10.5,
                  letterSpacing: 0.12 * 10.5,
                  color: t.faint,
                ),
              ),
            ),
          );
        }),
      );

  Widget _bodyRow(BuildContext context, AppTokens t, CustomTableRow row, int columns) => Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: List.generate(columns, (i) {
          final field = i < row.fields.length ? row.fields[i] : null;
          final data = (field?.data ?? '').trim();
          return SizedBox(
            width: _columnWidth,
            child: Padding(
              padding: const EdgeInsets.only(right: 14, top: 9, bottom: 9),
              child: data.isEmpty
                  ? const SizedBox.shrink()
                  : MdWidget(
                      context,
                      data,
                      false,
                      config: config.copyWith(
                        // First column reads as the row's label, the rest as its value —
                        // the same two weights a step line already uses.
                        style: t.mono.copyWith(
                          fontSize: 12,
                          height: 1.45,
                          color: i == 0 ? t.dim : t.text,
                        ),
                      ),
                    ),
            ),
          );
        }),
      );
}

/// The width one column is drawn at, exported for the widget test that asserts a wide
/// table scrolls rather than compresses.
const double kProseTableColumnWidth = ProseTable._columnWidth;
