import '../models/conversation.dart';
import '../models/host_id.dart';
import '../models/transcript.dart';
import 'conversation_builder.dart';

/// Support entry-based hosts without a minimum host version; share the history bound (`contract/README.md`).
class EntryLane {
  final Map<CellRef, List<TranscriptEntry>> _entries = {};

  /// Whether this cell's history is being kept as entries. False for a cell fed by the delta
  /// lane, which holds turns the host derived and that nothing here may re-derive.
  bool holds(CellRef ref) => _entries[ref]?.isNotEmpty ?? false;

  /// This cell's entries, for the one reader outside this file: the prompts a pending
  /// dispatch settles against.
  List<TranscriptEntry> entriesOf(CellRef ref) => _entries[ref] ?? const [];

  void forget(CellRef ref) => _entries.remove(ref);

  void clear() => _entries.clear();

  /// Merges a REST page in and returns the turns it derives to.
  ///
  /// A merge rather than a replacement, because the store is already collecting before a page
  /// arrives and a turn can produce a dozen hook events during one round trip.
  List<Turn> seed(CellRef ref, List<TranscriptEntry> page, int cap) {
    final held = _entries[ref] ?? [];
    final known = held.map(stableId).toSet();
    final merged = [...page.where((e) => !known.contains(stableId(e))), ...held];
    if (merged.length > cap) merged.removeRange(0, merged.length - cap);
    _entries[ref] = merged;
    return turnsFromEntries(merged, Provenance.hook);
  }

  /// Puts a page of older entries in front, or `null` when it brought nothing new.
  List<Turn>? prepend(CellRef ref, List<TranscriptEntry> older) {
    final held = _entries[ref] ?? [];
    final known = held.map(stableId).toSet();
    final fresh = older.where((e) => !known.contains(stableId(e))).toList();
    if (fresh.isEmpty) return null;
    _entries[ref] = [...fresh, ...held];
    return turnsFromEntries(_entries[ref]!, Provenance.hook);
  }

  /// Feeds one entry and returns the turns it derives to, or `null` for a cell this lane is
  /// not keeping and must not start keeping.
  List<Turn>? push(CellRef ref, TranscriptEntry entry, int cap, {required bool follows}) {
    final entries = _entries[ref];
    if (entries == null) {
      if (!follows) return null;
      _entries[ref] = [entry];
      return turnsFromEntries([entry], Provenance.hook);
    }
    entries.add(entry);
    if (entries.length > cap) entries.removeRange(0, entries.length - cap);
    return turnsFromEntries(entries, Provenance.hook);
  }
}
