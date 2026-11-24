import '../../data/conversation_builder.dart';
import '../../models/conversation.dart';
import '../../models/transcript.dart';

/// Which of the three kinds of line an item is — and the whole point is that they are
/// told apart by **typeface**, not by decoration (`MVP.md`).
///
/// That is why there is no `stripe` or `icon` field here: the letterforms already carry
/// the distinction, and a stripe beside serif prose would restate what the reader can
/// already see.
enum ChatLine {
  /// What you asked. Rendered sans, inside the only bubble in the app.
  prompt,

  /// What it is asking **you** — a question with options, drawn as its own card. Never a
  /// permission: a permission takes a yes or a no, this takes a choice.
  question,

  /// What it did. Rendered mono: `Read src/legacy/shim.ts`, `Edit … +0 −34`.
  step,

  /// What it said. Rendered serif — the agent's own last message.
  prose,

  /// What went wrong. Rendered mono like a step, in [AppTokens.error].
  ///
  /// Was folded into [step] until 2026-09-08, which made an interruption or a failed
  /// tool look exactly like a file being read. Three meanings, one appearance.
  problem,

  /// Something worth knowing that did not go wrong.
  ///
  /// Rendered mono like a [step] and in [AppTokens.muted] — **never red**, which this screen
  /// spends on failure alone (`MVP.md`).
  ///
  /// The wire has carried this distinction since the Claude bridge landed: a plan-window
  /// change arrives as `{type: "error", recoverable: true}`
  /// (`bridges/claude/conversation.ts`), and `ErrorPart.recoverable` was parsed here and then
  /// thrown away. So `five_hour plan limit: allowed_warning` — a heads-up on a turn that
  /// answered perfectly — drew exactly like an interrupted one. Seen on a real VPS cell on
  /// 2026-09-10, over an answer the agent had just given.
  ///
  /// The cost of getting it wrong runs both ways, which is why it earns its own kind: a
  /// warning read as a failure sends the operator hunting for a fault that is not there, and
  /// a failure read as a warning is worse.
  notice,

  /// What it was working out before it said anything.
  ///
  /// The runners send this (`reasoning`) and the app **threw it away** until
  /// 2026-09-08 — `_lineFor` mapped five kinds and closed with `_ => null`. It is the
  /// one material a "thinking" state is made of, and it was arriving every turn.
  ///
  /// Rendered serif *italic*: it is the agent's own voice, but not addressed to the
  /// operator, and the typeface carries that difference the way it already carries
  /// said-versus-did.
  thinking,
}

/// One line of Chat, already decided.
class ChatItem {
  const ChatItem({
    required this.kind,
    required this.text,
    required this.timestamp,
    this.label,
    this.diff,
    this.truncated = false,
    this.open = false,
    this.status,
    this.questions,
    this.turnId,
    this.stopReason,
  });

  final ChatLine kind;

  /// The questions, when this is a [ChatLine.question]. Null for every other kind — a card
  /// draws from these, never from [text], because an option's own words have nowhere else to go.
  final List<UserQuestion>? questions;

  /// The prompt, the step's target, or the prose — whichever this line is.
  final String text;

  /// Tool name for a [ChatLine.step] (`Read`, `Edit`), null otherwise.
  final String? label;

  /// `+0 −34`, or null when no diff applies.
  ///
  /// Null and `+0 −0` are different claims: a `Read` step changed nothing *because it
  /// cannot*, while an `Edit` that reports zeros genuinely touched nothing. The host
  /// omits the counts for the former, so this stays null and the badge is not drawn —
  /// `contract/README.md` calls this out, and `rest-transcript.json` carries one entry
  /// of each kind so a client cannot get it right by accident.
  final String? diff;

  /// Whether [text] stops short of what the agent said — only ever true on
  /// [ChatLine.prose].
  final bool truncated;

  /// A [ChatLine.step] whose result has not arrived — the tool is still running, or the
  /// ring evicted its `tool-post`. Carried so a line can say "still" without a spinner.
  final bool open;

  /// The runner's own word for how the step ended: `completed`, `failed`, `cancelled`,
  /// `in_progress`, `pending`. Kept as the wire string, so a newer status a host invents
  /// still draws as a step rather than vanishing.
  ///
  /// Added 2026-09-08. Until then a step drew the same whether it had succeeded or
  /// failed — the transcript could tell the operator a command ran and not whether it
  /// worked, which is the one thing they were reading it for.
  final String? status;

  final DateTime timestamp;

  /// Which turn this line belongs to, as the host grouped it — null for a line that has
  /// no turn yet (a pending dispatch, the live tail).
  ///
  /// **Carried rather than re-derived.** The host already decides where a turn opens and
  /// closes, once, for every client (`conversation/parts-from-entries.ts`); [ChatTranscript]
  /// used to walk `turn.parts` and append into one flat list, throwing the boundary away one
  /// line before it was drawn. `ChatLayout` groups on this, so a turn can read as one block
  /// instead of six kinds of line in a single column. Issue 01 of
  /// `plans/pocket-chat-turn-presentation`.
  final String? turnId;

  /// How the turn this line belongs to ended — `end_turn`, `cancelled`, `error`,
  /// `max_turns` — kept as the wire string. Null while the turn is still open, and null
  /// for a line that has no turn.
  ///
  /// **On every line of the turn, not only its last.** [ChatLayout] groups on [turnId] and
  /// then asks the group how it ended; "the last item" is not a thing that survives
  /// filtering, and [ChatTranscript._lineFor] already drops redacted reasoning and empty
  /// prose. A turn whose only droppable line was last would otherwise lose the reason it
  /// stopped.
  final String? stopReason;

  /// The same line, tagged with the turn it came from.
  ///
  /// A method rather than `turnId:` on every arm of [ChatTranscript._lineFor]: that switch
  /// decides *which typeface a part is drawn in*, and the turn is not its question.
  ChatItem inTurn(String id, String? reason) => ChatItem(
        kind: kind,
        text: text,
        timestamp: timestamp,
        label: label,
        diff: diff,
        truncated: truncated,
        open: open,
        status: status,
        questions: questions,
        turnId: id,
        stopReason: reason,
      );
}

/// Chat's content, derived from the conversation's turns.
///
/// **Reads parts, not hook events** (Fase 3 of `plans/pocket-chat-conversation-model`).
/// The three rules that used to live here — when a turn opens, what `body` means per
/// `event`, how a tool's call and result pair — moved to the host's converter and its
/// twin `turnsFromEntries`, which this calls. What stays is the one decision this layer
/// owns: which **typeface** a part is drawn in.
///
/// - `user_message` → [ChatLine.prompt]
/// - `assistant_text` → [ChatLine.prose]
/// - `tool_call` → [ChatLine.step]; a call and its result are **one** line now, where a
///   Claude cell used to draw every tool twice (`tool-pre`, then `tool-post` with the
///   same target).
/// - `error` → a step labelled by what went wrong (`Interrupted`), because it is a thing
///   that happened, not a thing that was said.
/// - `unknown` → a step, labelled by its raw type — the rule Chat has always followed for
///   an event it cannot name: draw it, never drop it.
/// - `reasoning` → nothing, in this version (§7 no. 2 of the plan). `status` → nothing:
///   the permission card and the fleet's `turn` already carry that state.
class ChatTranscript {
  const ChatTranscript(this.items);

  final List<ChatItem> items;

  bool get isEmpty => items.isEmpty;

  /// Hook entries, as the live stream and an older host still deliver them.
  factory ChatTranscript.of(List<TranscriptEntry> entries) =>
      ChatTranscript.ofTurns(turnsFromEntries(entries, Provenance.hook));

  factory ChatTranscript.ofTurns(List<Turn> turns) {
    final items = <ChatItem>[];
    for (final turn in turns) {
      for (final part in turn.parts) {
        final item = _lineFor(part);
        if (item != null) items.add(item.inTurn(turn.turnId, turn.stopReason));
      }
    }
    return ChatTranscript(items);
  }

  /// `UserPromptSubmit`, as its own entry — kept as a name other code refers to.
  static const String userSaid = 'prompt-submit';

  static ChatItem? _lineFor(Part part) => switch (part) {
        UserMessagePart(:final text) when text.isNotEmpty =>
          ChatItem(kind: ChatLine.prompt, text: text, timestamp: part.ts),
        AssistantTextPart(:final text, :final truncated) when text.isNotEmpty => ChatItem(
            kind: ChatLine.prose, text: text, truncated: truncated, timestamp: part.ts),
        // Redacted reasoning is dropped rather than drawn as an empty block: the host
        // says the runner withheld it, and an empty rule would read as a rendering bug.
        ReasoningPart(:final text, :final redacted) when text.isNotEmpty && !redacted =>
          ChatItem(kind: ChatLine.thinking, text: text, timestamp: part.ts),
        ToolCallPart() when part.title.isNotEmpty || part.toolName.isNotEmpty => ChatItem(
            kind: ChatLine.step,
            text: part.title,
            label: part.toolName,
            diff: _diffFor(part),
            open: part.isOpen,
            status: part.status,
            timestamp: part.ts,
          ),
        // **A card only while it is a question.** Once it is over the options are no longer
        // anything to choose between — a list of roads not taken, above the agent's reply,
        // taking half the screen. `bb` does not keep them either: its form is a *pending*
        // interaction, and a resolved one leaves the thread with the ordinary event.
        QuestionPart(:final questions) when questions.isNotEmpty && !part.isOpen => ChatItem(
            kind: ChatLine.step,
            label: 'question',
            text: _settled(part),
            status: part.cancelled ? 'cancelled' : 'completed',
            timestamp: part.ts,
          ),
        QuestionPart(:final questions) when questions.isNotEmpty => ChatItem(
            kind: ChatLine.question,
            text: questions.first.question,
            questions: questions,
            timestamp: part.ts,
          ),
        // `recoverable` is the host's own word for "this did not go wrong", and it decides
        // which of the two kinds this is. Red is not a synonym for "the runner spoke up".
        ErrorPart(:final message, :final recoverable) => ChatItem(
            kind: recoverable ? ChatLine.notice : ChatLine.problem,
            text: message,
            label: recoverable ? 'notice' : 'error',
            timestamp: part.ts),
        UnknownPart(:final rawType, :final summary) =>
          ChatItem(kind: ChatLine.step, text: summary, label: rawType, timestamp: part.ts),
        _ => null,
      };

  /// The one line a settled question leaves behind: what was chosen, or — when the answer
  /// named nothing, and when the operator refused it — what was asked.
  static String _settled(QuestionPart part) {
    final chosen = (part.answered ?? const {}).values.expand((a) => a).toList(growable: false);
    return chosen.isEmpty ? part.questions.first.question : chosen.join(', ');
  }

  /// `+0 −34`. Null when the host sent neither count.
  ///
  /// Uses U+2212 MINUS, not a hyphen — it aligns with `+` at the same optical weight,
  /// which matters in a mono column of these.
  static String? _diffFor(ToolCallPart part) {
    if (!part.hasDiff) return null;
    return '+${part.additions ?? 0} −${part.deletions ?? 0}';
  }
}
