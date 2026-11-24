import { Suspense } from "react";
import { CanvasRouteClient } from "./CanvasRouteClient";

export default function Page() {
  return (
    <Suspense fallback={null}>
      <CanvasRouteClient />
    </Suspense>
  );
}
