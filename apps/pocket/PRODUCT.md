# Product: Lotus Pocket

## Register

product

## Users

Software engineers who run AI coding agents (Claude Code, Codex, Cursor Agent and others) on their own Mac
through Lotus, and who step away from the desk while those agents keep working. They open Pocket on an Android
phone in short bursts: on a train, in a queue, between meetings, on the sofa. Often one hand, often bright light,
often a weak or changing network. They are experts at the work but not at the moment: they glance, decide, and
put the phone away.

The scene that sets every default: *an engineer on a crowded train at 9am, one hand on a strap, checks whether the
three agents they left running need anything, approves one command, and pockets the phone within 20 seconds.*

## Product purpose

Pocket is the remote control for agents that run on the user's own machine. It does not run agents itself and it
does not replace the desktop. It lets the user:

1. See at a glance which agents need them, which are working and which are done, across every project.
2. Answer what an agent is waiting for: allow or deny a command or file edit, answer a question.
3. Start a new agent in a project folder with the right agent, model and permission.
4. Follow one agent in Chat (its words and results) or in Terminal (a shell in the same folder, or the agent's TUI
   for a desktop pane).
5. Stop an agent, or close it when the task is finished, with an undo.

Success means a decision takes seconds, nothing the user typed is ever lost, and the user never has to wonder
whether an agent is waiting on them.

## Relationship to Lotus Desktop

Pocket is a second surface of the same product, with its own constraints. It shares the desktop's facts (runner
registry, model lists, vendor logos in `apps/desktop/public/assets/ai-logo/`) and never invents its own copies.
It does not share the desktop's layout or density: the desktop is a dense workbench, Pocket is a calm list.

## Brand personality

Calm, exact, trustworthy. Pocket should feel like a well-made instrument you carry: quiet until something needs
you, then clear about what and why. The voice is plain and short. It reports what agents did from ground truth
(files changed, tests passed, exit code), not what agents claim.

## Anti-references

- A chat app. No message-alert sounds, no typing bubbles, no avatars that pretend agents are people.
- A monitoring dashboard. No charts, no hero metrics, no grid of identical cards.
- A shrunk desktop. No split panes, no tiny controls, no settings that only make sense with a keyboard.
- "AI startup" decoration: aurora gradients, glass on content, neon terminals, sparkle icons.
- A fragile prototype: ambiguous agent state, buttons that do nothing offline, actions that silently fail.

## Design principles

1. **Needs you first.** The first screen answers "does anything need me?" before anything else. Amber means that,
   and only that.
2. **One decision per glance.** Every card states what the agent wants in plain words and shows the exact command
   or files. Allow and Deny get equal visual weight, so Allow is never the easy one; an answer that runs something
   asks for a fingerprint.
3. **Never lose what the user typed, never fake an answer.** Messages wait and send in order when the link is back.
   Approvals are never queued or guessed.
4. **The Mac is the source of truth.** Agents, models, logos and permissions come from the host. Nothing that can
   change on the Mac is hardcoded in the phone.
5. **Quiet by default.** Motion, sound and haptics confirm what happened; they never announce themselves.

## Accessibility and inclusion

- WCAG 2.1 AA contrast for all text in both themes; every foreground role declares the grounds it may sit on.
- Touch targets at least 48 dp; primary actions in the bottom half of the screen.
- State is never carried by colour alone: amber always comes with a word ("Needs your OK"), live with a dot plus
  a word.
- Respects the system text size up to 200% and the "remove animations" setting.
- Sound follows the phone's silent mode by default and has its own off switch.
