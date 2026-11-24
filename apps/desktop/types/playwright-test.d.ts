declare module "@playwright/test" {
  export type Locator = {
    click(): Promise<void>;
  };

  export type Page = {
    goto(url: string, options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit" }): Promise<void>;
    getByRole(role: string, options?: { name?: string | RegExp }): Locator;
    evaluate<T>(pageFunction: () => T | Promise<T>): Promise<Awaited<T>>;
    waitForTimeout(timeout: number): Promise<void>;
  };

  export type TestArgs = { page: Page };

  export const test: (name: string, fn: (args: TestArgs) => Promise<void> | void) => void;
  export const expect: (actual: unknown) => {
    toBeVisible(): Promise<void>;
    toBeGreaterThan(expected: number): void;
  };
}
