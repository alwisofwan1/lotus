#!/usr/bin/env node
// Refuses a release build that would ship without Lotus's Google OAuth client.
//
// `automation_google.rs` bakes the client in with `option_env!` at compile time. Without it the
// release app falls back to `~/.lotus/google-oauth-client.json`, which no user has — so Connectors
// shows "Not available in this build" for everyone. That shipped once (2026-09-29) because nothing
// failed. This check runs first in every release build, before the slow steps.
//
// LOTUS_ALLOW_NO_GOOGLE=1 builds anyway (a contributor without the client), loudly.

import { fileURLToPath } from "node:url";

const CLIENT_ID_SUFFIX = ".apps.googleusercontent.com";

/** @returns {{ ok: boolean, problems: string[], allowed: boolean }} */
export function checkGoogleClientEnv(env = process.env) {
  const problems = [];
  const id = (env.LOTUS_GOOGLE_CLIENT_ID ?? "").trim();
  const secret = (env.LOTUS_GOOGLE_CLIENT_SECRET ?? "").trim();
  if (!id) problems.push("LOTUS_GOOGLE_CLIENT_ID is not set");
  else if (!id.endsWith(CLIENT_ID_SUFFIX)) problems.push(`LOTUS_GOOGLE_CLIENT_ID does not end with ${CLIENT_ID_SUFFIX}`);
  if (!secret) problems.push("LOTUS_GOOGLE_CLIENT_SECRET is not set");
  return { ok: problems.length === 0, problems, allowed: env.LOTUS_ALLOW_NO_GOOGLE === "1" };
}

const HOW_TO = `Set both from the Desktop client JSON (Google Cloud → Credentials), e.g.:

  export LOTUS_GOOGLE_CLIENT_ID=$(jq -r .installed.client_id ~/.lotus-dev/google-oauth-client.json)
  export LOTUS_GOOGLE_CLIENT_SECRET=$(jq -r .installed.client_secret ~/.lotus-dev/google-oauth-client.json)

To build without Google on purpose: LOTUS_ALLOW_NO_GOOGLE=1`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { ok, problems, allowed } = checkGoogleClientEnv();
  if (!ok && allowed) {
    console.warn(`[release-env] WARNING: building WITHOUT the Google client (${problems.join("; ")}).`);
    console.warn("[release-env] Connectors → Google will say \"Not available in this build\" for every user.");
  } else if (!ok) {
    console.error(`[release-env] ERROR: release build refused — ${problems.join("; ")}.`);
    console.error("[release-env] Without it, Connectors → Google is unavailable for every user.\n");
    console.error(HOW_TO);
    process.exit(1);
  }
}
