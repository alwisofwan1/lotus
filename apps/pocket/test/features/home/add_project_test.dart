import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/home/add_project.dart';
import 'package:lotus_pocket/models/host_id.dart';

const HostId mac = HostId('mac');
const HostId vps = HostId('vps');

/// Satu pintu per (mesin × jalan), dan mesinnya disebut hanya ketika ia membedakan
/// sesuatu — aturan `hostQualifier` yang sudah dipatuhi empat layar lain.
void main() {
  test('satu host dengan dua jalan: dua pilihan, tanpa nama mesin', () {
    final choices = addProjectChoices(
      const [AddProjectTarget(host: vps, canClone: true, canBrowse: true)],
      (_) => '',
    );

    expect(choices.map((c) => c.door), [AddProjectDoor.clone, AddProjectDoor.browse]);
    expect(choices.every((c) => c.host.isEmpty), isTrue);
  });

  test('jalan yang host-nya tidak tawarkan tidak digambar', () {
    final choices = addProjectChoices(
      const [AddProjectTarget(host: vps, canClone: true, canBrowse: false)],
      (_) => '',
    );

    expect(choices.map((c) => c.door), [AddProjectDoor.clone]);
  });

  test('dua mesin: setiap pilihan menyebut mesinnya', () {
    final choices = addProjectChoices(
      const [
        AddProjectTarget(host: mac, canClone: true, canBrowse: false),
        AddProjectTarget(host: vps, canClone: true, canBrowse: false),
      ],
      (h) => h.value,
    );

    expect(choices.length, 2);
    expect(choices.map((c) => c.host), ['mac', 'vps']);
  });
}
