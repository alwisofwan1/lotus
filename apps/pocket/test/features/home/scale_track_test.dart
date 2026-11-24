import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/app/theme/app_theme.dart';
import 'package:lotus_pocket/features/home/widgets/scale_track.dart';

/// Knob thinking: bisa digeser, bukan hanya diketuk.
///
/// Bentuknya sudah menjanjikan gerakan itu sejak awal — knob di atas track adalah satu
/// kontrol yang setiap pengguna HP sudah belajar untuk *menggeser*. Yang dijaga di sini
/// adalah janji itu ditepati: nilainya berubah saat jempol melewati stop, knob-nya
/// mengikuti jari alih-alih menyentak ke stop terdekat, dan ketukan lama tetap bekerja.
void main() {
  const stops = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];

  late List<int> chosen;
  late List<MethodCall> haptics;

  setUp(() {
    chosen = [];
    haptics = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
      if (call.method == 'HapticFeedback.vibrate') haptics.add(call);
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, null);
  });

  Widget host({int selected = 0}) => MaterialApp(
        theme: buildAppTheme(),
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 342,
              child: _Host(stops: stops, initial: selected, onSelect: chosen.add),
            ),
          ),
        ),
      );

  Rect track(WidgetTester tester) => tester.getRect(find.byType(ScaleTrack));

  /// Titik tengah kolom stop [i] — di mana jempol akan mendarat untuknya.
  Offset at(WidgetTester tester, int i) {
    final box = track(tester);
    final column = box.width / stops.length;
    return Offset(box.left + column * (i + 0.5), box.center.dy);
  }

  testWidgets('menggeser melewati stop mengubah nilainya, satu per stop', (tester) async {
    await tester.pumpWidget(host());

    final gesture = await tester.startGesture(at(tester, 0));
    for (var i = 1; i <= 4; i++) {
      await gesture.moveTo(at(tester, i));
      await tester.pump();
    }
    await gesture.up();
    await tester.pumpAndSettle();

    expect(chosen, [1, 2, 3, 4], reason: 'tidak melompat dan tidak mengulang');
  });

  testWidgets('setiap stop yang dilewati terasa di tangan', (tester) async {
    await tester.pumpWidget(host());

    final gesture = await tester.startGesture(at(tester, 0));
    await gesture.moveTo(at(tester, 1));
    await tester.pump();
    await gesture.moveTo(at(tester, 2));
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();

    // Nilainya bisa dirasakan sementara mata ada di label di atas track, bukan di knob.
    expect(haptics, hasLength(2));
  });

  testWidgets('knob mengikuti jari, tidak menyentak ke stop terdekat', (tester) async {
    await tester.pumpWidget(host());
    final resting = tester.getCenter(find.byType(AnimatedContainer).last);

    final gesture = await tester.startGesture(at(tester, 0));
    // Berhenti di antara dua stop: knob harus ada di antaranya juga.
    final between = Offset(
      (at(tester, 1).dx + at(tester, 2).dx) / 2,
      at(tester, 1).dy,
    );
    await gesture.moveTo(between);
    await tester.pump();

    final held = tester.getCenter(find.byType(AnimatedContainer).last);
    expect(held.dx, greaterThan(at(tester, 1).dx - 1));
    expect(held.dx, lessThan(at(tester, 2).dx + 1));
    expect(held.dx, greaterThan(resting.dx));

    await gesture.up();
    await tester.pumpAndSettle();

    // Dilepas: ia mendarat di stop yang dipilih, bukan tetap menggantung di antara.
    final settled = tester.getCenter(find.byType(AnimatedContainer).last);
    expect((settled.dx - at(tester, chosen.last).dx).abs(), lessThan(1.5));
  });

  testWidgets('digeser melewati ujung menahan nilai ekstrem, bukan diam', (tester) async {
    await tester.pumpWidget(host(selected: 4));

    final box = track(tester);
    final gesture = await tester.startGesture(at(tester, 4));
    await gesture.moveTo(Offset(box.right + 200, box.center.dy));
    await tester.pump();
    await gesture.up();
    await tester.pumpAndSettle();

    expect(chosen.last, stops.length - 1);
  });

  testWidgets('ketukan lama tetap bekerja — gestur baru menambah, tidak menggantikan',
      (tester) async {
    await tester.pumpWidget(host());

    await tester.tapAt(at(tester, 3));
    await tester.pumpAndSettle();

    expect(chosen, [3]);
  });

  testWidgets('bagi pembaca layar ia satu slider, dengan nilai tetangganya', (tester) async {
    await tester.pumpWidget(host(selected: 2));
    final handle = tester.ensureSemantics();

    final node = tester.getSemantics(find.byType(ScaleTrack));
    expect(node.value, 'medium');
    expect(node.increasedValue, 'high');
    expect(node.decreasedValue, 'low');

    handle.dispose();
  });

  testWidgets('nilainya bisa dipindahkan tanpa gestur sama sekali', (tester) async {
    await tester.pumpWidget(host(selected: 2));
    final handle = tester.ensureSemantics();

    tester.semantics.performAction(
      find.semantics.byLabel('Thinking'),
      SemanticsAction.increase,
    );
    await tester.pumpAndSettle();
    expect(chosen, [3]);

    handle.dispose();
  });
}

/// Pemilik nilainya, seperti `SummonStep` di aplikasi: knob-nya tidak menyimpan pilihan.
class _Host extends StatefulWidget {
  const _Host({required this.stops, required this.initial, required this.onSelect});

  final List<String> stops;
  final int initial;
  final ValueChanged<int> onSelect;

  @override
  State<_Host> createState() => _HostState();
}

class _HostState extends State<_Host> {
  late int selected = widget.initial;

  @override
  Widget build(BuildContext context) => ScaleTrack(
        label: 'Thinking',
        stops: widget.stops,
        selected: selected,
        onSelect: (i) {
          widget.onSelect(i);
          setState(() => selected = i);
        },
      );
}
