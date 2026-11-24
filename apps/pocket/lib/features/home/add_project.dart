import '../../models/host_id.dart';

/// The two ways a project arrives on a machine.
///
/// Separate capabilities rather than one, because they ship in separate phases and a
/// host advertises each only once it can honour it — the discipline `host-features.ts`
/// spells out and this app already follows for Chat, dictation and spawn.
enum AddProjectDoor { clone, browse }

/// A paired host that will take a new project, and which ways it offers.
class AddProjectTarget {
  const AddProjectTarget({
    required this.host,
    required this.canClone,
    required this.canBrowse,
  });

  final HostId host;

  /// `projects-create` — clone a repository into this host's workspace root.
  final bool canClone;

  /// `projects-browse` — pick a folder that is already on the machine.
  final bool canBrowse;

  bool get offersAnything => canClone || canBrowse;
}

/// One row the operator can choose: a machine, and a way in.
class AddProjectChoice {
  const AddProjectChoice({
    required this.target,
    required this.door,
    required this.host,
  });

  final AddProjectTarget target;
  final AddProjectDoor door;

  /// The machine, **already qualified** — empty when naming it distinguishes nothing.
  final String host;

  String get label => switch (door) {
        AddProjectDoor.clone => 'Clone a repository',
        AddProjectDoor.browse => 'Pick a folder',
      };

  String get blurb => switch (door) {
        AddProjectDoor.clone => 'from a git url',
        AddProjectDoor.browse => 'already on this machine',
      };
}

/// Every way in, across every host that offers one.
///
/// **One row per machine × door, on one page** — not a machine step followed by a door
/// step. With a single host it collapses to exactly the two rows the mockup draws, and
/// with two it says which machine on each row instead of asking twice. [hostLabel] is
/// the same function four other surfaces take, so nothing here decides a second time
/// whether a machine is worth naming.
List<AddProjectChoice> addProjectChoices(
  List<AddProjectTarget> targets,
  String Function(HostId host) hostLabel,
) {
  final choices = <AddProjectChoice>[];
  for (final target in targets) {
    for (final door in AddProjectDoor.values) {
      final offered = switch (door) {
        AddProjectDoor.clone => target.canClone,
        AddProjectDoor.browse => target.canBrowse,
      };
      if (!offered) continue;
      choices.add(AddProjectChoice(
        target: target,
        door: door,
        host: hostLabel(target.host),
      ));
    }
  }
  return choices;
}
