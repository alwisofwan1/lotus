/**
 * Which edge fades a scroll container should show, given its scroll metrics. A fade appears only
 * when there is content past that edge, so the Inspector's hidden-scrollbar list signals "more
 * above/below" without a visible scrollbar. Pure (1px slack absorbs sub-pixel rounding).
 */
export function scrollEdges(m: { scrollTop: number; scrollHeight: number; clientHeight: number }): { up: boolean; down: boolean } {
  return {
    up: m.scrollTop > 1,
    down: m.scrollTop + m.clientHeight < m.scrollHeight - 1,
  };
}
