export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`HTTP ${status}: ${message}`);
    this.name = "ApiError";
  }
}
