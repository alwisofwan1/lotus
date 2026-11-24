import 'host_id.dart';
import 'server_event.dart';

/// One frame plus the host it came from.
///
/// A frame alone is ambiguous once more than one host is paired, and merging is a
/// client-side job by ADR-3 — so the pair travels together from the socket upward.
typedef HostEvent = (HostId host, ServerEvent event);
