import 'project_presentation.dart';

/// Menyaring indeks dengan apa yang diketik operator.
///
/// Fungsi, bukan kelas dan bukan state di dalam widget: ia tidak menyimpan apa pun, dan
/// tiga keputusan di dalamnya — apa yang dicocokkan, bagaimana query kosong diperlakukan,
/// dan bahwa urutan tidak boleh berubah — adalah hal yang harus bisa dibantah tanpa
/// membangun satu layar pun. Sama seperti `HomeSummary` dan `ProjectPresentation`, yang
/// juga memutuskan sebelum ada widget yang menggambar.
///
/// **Yang dicocokkan tiga hal, dan ketiganya punya alasan sendiri:**
///
/// - **nama**, karena itu yang operator ingat;
/// - **mesin**, karena delapan project di dua mesin adalah sebab field ini ada, dan
///   "yang di VPS" sesering ditanyakan seperti nama;
/// - **path**, karena dua project bernama sama hanya dibedakan direktorinya
///   ([ProjectPresentation.disambiguate]), jadi direktori itulah yang diketik untuk
///   memilih di antara keduanya.
///
/// Substring, bukan subsequence: `lot` menemukan `Lotus`, tetapi `lts` tidak. Pencocokan
/// yang lebih pintar terdengar membantu sampai ia mulai menampilkan baris yang operator
/// tidak bisa jelaskan kenapa ada di situ — dan pada delapan project, substring sudah
/// menyelesaikan seluruh pekerjaan.
List<ProjectPresentation> matchProjects(
  List<ProjectPresentation> rows,
  String query,
) {
  final needle = query.trim().toLowerCase();
  // Query kosong adalah seluruh daftar, bukan daftar kosong — dan daftar yang sama
  // persis, bukan salinannya, supaya `identical` tetap benar bagi pemanggil yang
  // membandingkan.
  if (needle.isEmpty) return rows;

  return rows
      .where(
        (r) =>
            r.label.toLowerCase().contains(needle) ||
            r.host.toLowerCase().contains(needle) ||
            r.path.toLowerCase().contains(needle),
      )
      .toList(growable: false);
}
