import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/app/theme/app_tokens.dart';
import 'package:lotus_pocket/features/home/widgets/starting_screen.dart';
import 'package:lotus_pocket/features/shared/runner_mark.dart';

/// Layar yang mengisi jeda antara “mesin menerima permintaannya” dan “cell-nya muncul di
/// Home”. Spesifikasinya `plans/lotus-pocket/design/revamp-modern.html` M5, dengan satu
/// koreksi yang dijelaskan di [StartingScreen] sendiri: mockup-nya menggambar `Cancel`, dan
/// tidak ada yang bisa dibatalkan.
void main() {
  Widget host({
    String runner = 'claude',
    String path = '~/code/cnvs',
    String machine = 'air',
    VoidCallback? onDismiss,
  }) =>
      MaterialApp(
        theme: buildAppTheme(),
        home: StartingScreen(
          runner: runner,
          path: path,
          machine: machine,
          onDismiss: onDismiss ?? () {},
        ),
      );

  testWidgets('menyebut runner-nya, dan di mana ia dibuat', (tester) async {
    await tester.pumpWidget(host());

    expect(find.text('claude'), findsOneWidget);
    expect(find.text('STARTING'), findsOneWidget);
    // Satu-satunya fakta berisiko di layar ini: *repo mana*. Path dan mesinnya dalam satu
    // baris, karena keduanya baru berarti bersama (R-10).
    expect(find.text('~/code/cnvs on air'), findsOneWidget);
  });

  testWidgets('mark-nya milik runner itu, dan bukan amber', (tester) async {
    await tester.pumpWidget(host(runner: 'codex'));

    final mark = tester.widget<RunnerMarkGlyph>(find.byType(RunnerMarkGlyph));
    expect(mark.agentType, 'codex');
    // Amber berarti seorang agen menunggu operator, dan “starting” bukan itu. Memakainya di
    // sini akan membuat satu-satunya warna bermakna di app ini kehilangan artinya, di layar
    // yang justru paling sering dilihat sambil menunggu.
    expect(mark.color, AppTokens.dark.dim);
    expect(mark.color, isNot(AppTokens.dark.waiting));
  });

  testWidgets('dengan satu mesin ter-pair, mesinnya tidak dicetak', (tester) async {
    // Aturan `hostQualifier` yang sudah berlaku di tiga layar lain: nama mesin hanya muncul
    // ketika ia membedakan sesuatu.
    await tester.pumpWidget(host(machine: ''));

    expect(find.text('~/code/cnvs'), findsOneWidget);
    expect(find.textContaining(' on '), findsNothing);
  });

  testWidgets('jalan keluarnya mengaku hanya berhenti menunggu', (tester) async {
    var left = 0;
    await tester.pumpWidget(host(onDismiss: () => left++));

    // **Bukan `Cancel`.** Mesinnya sudah menerima permintaannya, jadi agennya tetap lahir
    // apa pun yang ditekan di sini; menamainya “cancel” akan menjanjikan pembatalan yang
    // tidak terjadi. `BACK` sudah dipakai app ini untuk arti yang sama persis
    // (`agent_screen.dart`), jadi tidak ada kata baru yang perlu dipelajari.
    expect(find.text('Cancel'), findsNothing);
    await tester.tap(find.text('BACK'));
    await tester.pumpAndSettle();

    expect(left, 1);
  });
}
