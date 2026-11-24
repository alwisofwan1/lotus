import { z } from "zod";

// Zod 4 probes `Function("")` once to decide whether it may compile fast object parsers. The
// production CSP has no 'unsafe-eval', so the probe is refused — harmless (Zod falls back to
// its normal parser) but logged as a CSP violation on every start. Skip the probe.
z.config({ jitless: true });
