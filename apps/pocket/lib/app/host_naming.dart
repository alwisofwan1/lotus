import '../features/shared/host_label.dart';
import '../hosts/credentials.dart';
import '../hosts/host_registry.dart';
import '../models/host_id.dart';

/// The operator-facing name of a host, or **empty when naming it says nothing**.
///
/// The label exists to keep two same-named projects apart (R-10). With one paired
/// machine there is nothing to keep apart: every row would carry the same word, and
/// a real hostname is long — `Alwis-MacBook-Air` was measured beside a project name
/// it dwarfed. That is the argument `shortHostLabel` already makes for `.local`,
/// applied one step further (`issues/11`).
///
/// Decided here, once, rather than in each widget: three screens print this, and
/// three copies of the rule is how they start to disagree.
String hostLabelFor(
  HostId host, {
  required Credentials credentials,
  required HostRegistry registry,
}) => hostQualifier(
  // The operator's name for the machine wins over the machine's name for itself.
  // A nickname is only ever set deliberately, so the moment one exists it is the
  // more useful of the two — and it is the short one (`issues/11`).
  credentials.deviceFor(host)?.nickname ??
      registry.statusOf(host)?.host.label ??
      host.value,
  pairedHosts: registry.hosts.length,
);
