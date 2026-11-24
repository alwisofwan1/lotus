import 'package:flutter/material.dart';

import '../../data/fleet_store.dart';
import '../../models/host_id.dart';
import '../shared/agent_mutations.dart';
import 'project_presentation.dart';
import 'spawn_choice.dart';
import 'widgets/starting_screen.dart';

/// Membuat satu agen, lalu menunggunya benar-benar ada.
///
/// Sebuah file sendiri karena `home_screen.dart` melewati batas 300 baris saat langkah
/// menunggu ini ditambahkan — dan batas itu sedang menunjuk hal yang benar: “memulai agen
/// lalu menonton ia lahir” adalah satu urutan utuh dengan awal, jeda, dan akhir, sementara
/// `HomeScreen` mengurus proyek mana yang di layar. Yang tertinggal di sana kini satu
/// panggilan.
///
/// Permintaannya tetap lewat [AgentMutations], jalur yang menjalankan gerbang biometrik dan
/// pemeriksaan kesegaran kredensial (ADR-8, ADR-12 no. 2) — file ini merakit argumennya, dan
/// tidak pernah menjadi jalan kedua yang melewatinya. [guard] adalah bendera satu-gestur-
/// sekali milik layarnya, diserahkan supaya ia tetap tinggal di sana.
Future<bool> startAgentAndWatch(
  BuildContext context, {
  required FleetStore fleet,
  required ProjectRef project,
  required ProjectPresentation shown,
  required SpawnChoice choice,
  required String? brief,
  required AgentMutations mutations,
  required Future<bool> Function(Future<bool> Function()) guard,
}) async {
  // Dicatat *sebelum* permintaannya, supaya “cell yang belum ada sebelumnya” punya arti.
  final before = fleet.inProject(project).map((c) => c.ref).toSet();

  final runner = choice.runner;
  final started = await guard(
    () => mutations.start(
      context,
      host: project.host,
      workspaceId: project.workspaceId,
      provider: runner.id,
      // Only for a runner the operator defined; a native id needs no override.
      runnerId: runner.isCustom ? runner.id : null,
      label: runner.label,
      initialPrompt: brief,
      permissionMode: choice.posture,
      // Named in the OS prompt only when it was moved off where this runner rests.
      permissionLabel: choice.postureIsResting ? null : choice.postureLabel,
      model: choice.model,
      effort: choice.effort,
      profileId: choice.profile,
      tui: choice.tui,
    ),
  );
  if (!started || !context.mounted) return started;

  await _showStarting(
    context,
    fleet: fleet,
    project: project,
    before: before,
    runner: runner.label,
    tuning: choice.tuningSummary,
    path: shown.path,
    machine: shown.host,
  );
  return started;
}

/// Menampilkan [StartingScreen] sampai cell-nya ada, lalu menutupnya sendiri.
///
/// **Yang ditunggu adalah cell yang belum ada sebelumnya**, bukan `paneId` dari respons
/// spawn. `SpawnedCell.paneId` boleh kosong — dokumennya sendiri menyebut alasannya, bahwa
/// 200 berarti mesinnya menerimanya dan itu keseluruhan jawaban yang HP bertindak atasnya —
/// jadi menunggu `paneId` akan menggantung selamanya di host yang menjawab `{}`. Selisih
/// terhadap ref yang sudah dikenal tidak punya masalah itu.
Future<void> _showStarting(
  BuildContext context, {
  required FleetStore fleet,
  required ProjectRef project,
  required Set<CellRef> before,
  required String runner,
  required String? tuning,
  required String path,
  required String machine,
}) async {
  final navigator = Navigator.of(context);
  var closed = false;

  void watch() {
    if (closed) return;
    if (!fleet.inProject(project).any((c) => !before.contains(c.ref))) return;
    closed = true;
    // Barisnya sekarang ada di Home, dan composer sudah mengarah ke sana. Membuka agennya
    // otomatis akan memutuskan sesuatu yang belum diputuskan — lihat `HomeComposer`.
    if (navigator.canPop()) navigator.pop();
  }

  fleet.addListener(watch);
  try {
    await navigator.push(
      MaterialPageRoute<void>(
        builder: (context) => StartingScreen(
          runner: runner,
          tuning: tuning,
          path: path,
          machine: machine,
          // Berhenti menunggu. Agennya tetap lahir — lihat doc [StartingScreen].
          onDismiss: () => Navigator.of(context).pop(),
        ),
      ),
    );
  } finally {
    closed = true;
    fleet.removeListener(watch);
  }
}
