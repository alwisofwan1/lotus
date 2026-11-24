/// `/Users/op/code/lotus` sebagai `~/code/lotus`.
///
/// Dulu private di `project_switcher_rows.dart`, dan alasannya masih kalimatnya sendiri: HP
/// ini tidak punya urusan mengetahui direktori home milik siapa. Dipindah ke sini pada
/// 2026-08-11 ketika layar Starting membutuhkan aturan yang sama — dua salinan dari satu
/// aturan adalah dua tempat untuk menyimpang, dan yang satu akan diperbaiki tanpa yang lain.
String tildePath(String path) {
  final match = RegExp(r'^/(Users|home)/[^/]+(/.*)?$').firstMatch(path);
  return match == null ? path : '~${match.group(2) ?? ''}';
}
