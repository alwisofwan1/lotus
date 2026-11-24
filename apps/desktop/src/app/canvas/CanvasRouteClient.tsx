"use client";

import { CanvasPage } from "@/modules/codecanvas";

// CodeCanvas is a standalone ADE. It once received an optional workflow launch/save integration
// supplied by Swarm (ADR-0026 A.5b); Swarm is gone and workflow-on-canvas retired with it, so the
// canvas now runs with no integration at all.
export function CanvasRouteClient() {
  return <CanvasPage />;
}
