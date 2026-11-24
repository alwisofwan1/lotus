import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/home/widgets/start_button.dart';
import 'package:lotus_pocket/features/projects/clone_form.dart';

/// Layar 07 di `plans/pocket-vps-project-checkout/design/add-project.html`.
void main() {
  Future<CloneAsk?> open(WidgetTester tester, {String machine = 'vps'}) async {
    CloneAsk? asked;
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: Builder(
        builder: (context) => TextButton(
          onPressed: () async => asked = await showCloneForm(context, machine: machine),
          child: const Text('open'),
        ),
      ),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();
    return asked;
  }

  testWidgets('nama folder diturunkan dari URL, dan boleh ditimpa', (tester) async {
    await open(tester);

    await tester.enterText(
      find.byKey(const Key('clone-url')),
      'https://github.com/alwi/tkt-worker.git',
    );
    await tester.pump();

    expect(find.text('tkt-worker'), findsOneWidget);
  });

  testWidgets('Clone menutup layar dan mengembalikan apa yang diisi', (tester) async {
    CloneAsk? asked;
    await tester.pumpWidget(MaterialApp(
      theme: buildAppTheme(),
      home: Builder(
        builder: (context) => TextButton(
          onPressed: () async => asked = await showCloneForm(context, machine: 'vps'),
          child: const Text('open'),
        ),
      ),
    ));
    await tester.tap(find.text('open'));
    await tester.pumpAndSettle();

    await tester.enterText(find.byKey(const Key('clone-url')), 'git@host:alwi/x.git');
    await tester.enterText(find.byKey(const Key('clone-branch')), 'feat/payments');
    await tester.pump();
    await tester.tap(find.byType(StartButton));
    await tester.pumpAndSettle();

    expect(asked!.url, 'git@host:alwi/x.git');
    expect(asked!.branch, 'feat/payments');
    expect(asked!.name, 'x');
  });

  testWidgets('tanpa URL tidak ada yang bisa dikirim', (tester) async {
    await open(tester);

    await tester.tap(find.byType(StartButton));
    await tester.pumpAndSettle();

    // Masih di layar yang sama: tidak ada yang ditutup, tidak ada yang dikirim.
    expect(find.byKey(const Key('clone-url')), findsOneWidget);
  });
}
