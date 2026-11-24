import type { StatusVocabulary } from "@/modules/tasks/services/task-vocabulary";

/**
 * The words an Obsidian vault's tickets speak.
 *
 * Its own file, not a second entry in `task-vocabulary.ts`, because the tasks module should not
 * grow a vault dependency in the file every row reads. The type is shared; the words are not.
 */
export const VAULT_VOCABULARY: StatusVocabulary = {
  /*
    Work in flight first, shipped work last — the same principle Lotus's own order follows, and
    NOT the vault's workflow order (`backlog → todo → … → released`). A list is opened to answer
    "what is happening", and 37 of 78 tickets are `released`: put them where the flow puts them
    and the answer is four screens down.
  */
  order: [
    "in-progress",
    "in-review",
    "qa-revision",
    "ready-to-prod",
    "todo",
    "backlog",
    "released",
  ],
  labels: {
    "in-progress": "In Progress",
    "in-review": "In Review",
    "qa-revision": "QA Revision",
    "ready-to-prod": "Ready to Prod",
    todo: "Todo",
    backlog: "Backlog",
    released: "Released",
  },
  tones: {
    "in-progress": "progress",
    "in-review": "review",
    // The one hue that asks for action: a ticket bounced back by QA is the vault's equivalent of
    // a failed review, and it wears the same rose as Lotus's `blocked`.
    "qa-revision": "blocked",
    // Waiting on somebody else, like `in-review` — not finished, and not asking anything of you.
    "ready-to-prod": "review",
    todo: "open",
    // Greyer than `todo`: both are unstarted, but one has been picked up for this cycle and the
    // other has not, and a list where they look identical loses that.
    backlog: "dropped",
    released: "done",
  },
  /*
    Everything but `released`. `ready-to-prod` especially: the work is done but the ticket is not,
    and Notion still needs moving — treating it as finished is how three tickets go quiet.
  */
  open: [
    "in-progress",
    "in-review",
    "qa-revision",
    "ready-to-prod",
    "todo",
    "backlog",
  ],
};
