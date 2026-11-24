import 'package:flutter_test/flutter_test.dart';
import 'package:lotus_pocket/features/home/project_presentation.dart';
import 'package:lotus_pocket/features/home/project_search.dart';
import 'package:lotus_pocket/models/host_id.dart';

const HostId mac = HostId('mac');
const HostId vps = HostId('vps');

ProjectPresentation row(
  String label, {
  String host = '',
  String path = '',
  HostId on = mac,
}) =>
    ProjectPresentation(
      project: ProjectRef(on, label),
      label: label,
      host: host,
      path: path,
      waiting: '',
      activity: '',
    );

/// Mencocokkan project dengan apa yang diketik operator — `design/revamp-modern.html` M1,
/// field `Search projects` di dasar indeks.
///
/// Fungsi murni, bukan state di dalam widget, karena tiga pertanyaan di bawah ini
/// (apa yang dicocokkan, bagaimana spasi diperlakukan, apa arti query kosong) adalah
/// keputusan yang harus bisa diuji tanpa membangun satu layar pun.
void main() {
  test('query kosong berarti seluruh daftar, bukan daftar kosong', () {
    final rows = [row('CNVS'), row('Lotus')];

    expect(matchProjects(rows, ''), rows);
    // Spasi saja juga: keyboard HP menyisipkan spasi dengan mudah, dan sebuah layar yang
    // mengosongkan dirinya karena satu spasi terbaca sebagai app yang kehilangan datanya.
    expect(matchProjects(rows, '   '), rows);
  });

  test('mencocokkan nama, tanpa peduli besar-kecil huruf', () {
    final rows = [row('CNVS'), row('Lotus'), row('muse')];

    expect(matchProjects(rows, 'lot').map((r) => r.label), ['Lotus']);
    expect(matchProjects(rows, 'CN').map((r) => r.label), ['CNVS']);
  });

  test('mencocokkan mesinnya juga', () {
    // Delapan project di dua mesin adalah alasan field ini ada; menyaring "yang di VPS"
    // adalah pertanyaan yang sama seringnya dengan menyaring nama.
    final rows = [row('CNVS'), row('Lotus', host: 'vps', on: vps)];

    expect(matchProjects(rows, 'vps').map((r) => r.label), ['Lotus']);
  });

  test('mencocokkan path, dalam bentuk apa adanya', () {
    // Dua project bernama sama dibedakan direktorinya (`ProjectPresentation.disambiguate`),
    // jadi direktori itulah yang diketik operator untuk memilih di antara keduanya. Yang
    // dicocokkan path asli, bukan bentuk `~` yang cuma tampilan.
    final rows = [
      row('pocket', path: '/Users/op/srv/pocket'),
      row('pocket', path: '/Users/op/experiments/pocket'),
    ];

    expect(matchProjects(rows, 'experiments'), hasLength(1));
    expect(matchProjects(rows, 'experiments').single.path,
        '/Users/op/experiments/pocket');
  });

  test('tidak ada yang cocok berarti kosong, dan itu keadaan yang sah', () {
    expect(matchProjects([row('CNVS')], 'zzz'), isEmpty);
  });

  test('urutannya tidak pernah diubah', () {
    // Urutan datang dari `FleetStore` (menunggu-dulu, ADR-12 no. 1). Menyaring adalah
    // membuang baris, bukan mengurutkan ulang — sebuah query yang memindahkan baris
    // teratas akan memindahkan project paling mendesak.
    final rows = [row('busy-two'), row('busy-one'), row('quiet-two')];

    expect(matchProjects(rows, 'busy').map((r) => r.label),
        ['busy-two', 'busy-one']);
  });
}
