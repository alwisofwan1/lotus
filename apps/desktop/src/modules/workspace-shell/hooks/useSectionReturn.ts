import { useState } from "react";

/**
 * True once a section that took the rail's place has closed again, so the list it replaced can
 * slide back in from the side it left by. False on the first paint: an app that opens on the
 * list must not animate it. Adjusted during render, React's pattern for state that follows an input.
 */
export function useSectionReturn(sectionOpen: boolean): boolean {
  const [was, setWas] = useState(sectionOpen);
  const [returned, setReturned] = useState(false);
  if (was !== sectionOpen) {
    setWas(sectionOpen);
    setReturned(!sectionOpen);
  }
  return returned;
}
