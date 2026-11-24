import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { atomicWriteSync } from "../atomic-write.js";
import type { Account } from "./types.js";

export class UnknownAccountError extends Error {}

type Chosen = { default?: { claude?: string } };

/** Which Claude account this host's own spawns run as, kept in `<stateDir>/accounts.json`. */
export class DefaultAccountStore {
  constructor(
    private readonly file: string,
    private readonly accounts: () => Account[],
  ) {}

  /** The chosen id, or undefined when none is chosen or it is no longer discovered. */
  get(): string | undefined {
    const id = this.read().default?.claude;
    return id !== undefined && this.accounts().some((a) => a.id === id) ? id : undefined;
  }

  /** null clears the choice; an id that is not a live account is refused. */
  set(id: string | null): void {
    if (id !== null && !this.accounts().some((a) => a.id === id)) {
      throw new UnknownAccountError(`no Claude account named ${id}`);
    }
    const all = this.read();
    const { claude: _dropped, ...rest } = all.default ?? {};
    mkdirSync(dirname(this.file), { recursive: true });
    atomicWriteSync(this.file, { ...all, default: id === null ? rest : { ...rest, claude: id } });
  }

  private read(): Chosen {
    try {
      return JSON.parse(readFileSync(this.file, "utf8")) as Chosen;
    } catch {
      return {};
    }
  }
}
