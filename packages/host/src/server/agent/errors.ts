export class ProviderUnavailableError extends Error {
  constructor(provider: string, reason: string) {
    super(`Provider "${provider}" unavailable: ${reason}`);
    this.name = "ProviderUnavailableError";
  }
}

export class UnknownProviderError extends Error {
  constructor(provider: string) {
    super(`Unknown provider: ${provider}`);
    this.name = "UnknownProviderError";
  }
}
