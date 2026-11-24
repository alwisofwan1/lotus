export class SessionNotFoundError extends Error {
  constructor(id: string) {
    super(`Session not found: ${id}`);
    this.name = "SessionNotFoundError";
  }
}

export class SessionNotAdoptableError extends Error {
  constructor(id: string) {
    super(`Host cannot adopt sessions: ${id}`);
    this.name = "SessionNotAdoptableError";
  }
}
