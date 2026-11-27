/** Embed the build ID at compile time so the runtime environment cannot override it. */
declare const LOTUS_BUILD_ID: string | undefined;

export const BUILD_ID: string =
  typeof LOTUS_BUILD_ID === "string" && LOTUS_BUILD_ID.length > 0 ? LOTUS_BUILD_ID : "dev";
