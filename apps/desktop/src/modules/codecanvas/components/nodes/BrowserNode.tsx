"use client";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import type { NodeProps } from "@xyflow/react";
import type { BrowserNodePatch, CanvasBrowserNodeData } from "../../types/canvas";
import { useCanvasBrowserNode } from "../../hooks/useCanvasBrowserNode";
import { useCanvasBrowserAnnotation } from "../../hooks/useCanvasBrowserAnnotation";
import { useCanvasBrowserTitleChanged } from "../../hooks/useCanvasBrowserTitleChanged";
import { useCanvasBrowserNavigationBlocked } from "../../hooks/useCanvasBrowserNavigationBlocked";
import { useCanvasLodTier } from "../../hooks/useCanvasLodTier";
import { CanvasNodeFrame } from "./CanvasNodeFrame";
import { CanvasNodeGlyph } from "./CanvasNodeGlyph";
import { BrowserNodeCard } from "./BrowserNodeCard";
import { resolveCanvasBrowserPairIdentity } from "../../services/canvas-browser-pair";
import { useCanvasBrowserActivity } from "../../hooks/useCanvasBrowserActivity";
import { browserDisplayName } from "../../services/browser-node-identity";
import { resolveBrowserViewportProfile } from "../../services/browser-node-responsive";
import { shouldSuspendCanvasNativeOverlay, shouldReturnFocusToMainWebview } from "../../services/viewport/canvas-viewport-policy";
import { useCanvasOcclusionBlocked } from "../../services/canvas-occlusion-store";
import { focusCanvasMainWebview } from "@/lib/tauri/canvas-browser";
import {
  routeCanvasBrowserAnnotationToTerminal,
  type CanvasBrowserAnnotationDeliveryState,
} from "../../services/canvas-browser-annotation-routing";
import { routeCanvasBrowserAnnotationToAgent } from "../../services/canvas-browser-annotation-agent-routing";
import { augmentAnnotationPayloadWithScreenshot } from "../../services/canvas-browser-annotation-screenshot-merge";
import { extractAnnotationTraceId } from "../../services/canvas-browser-annotation-trace";
import { agentReplyRegistry } from "../../services/agent-reply-registry";
import type { CanvasBrowserAnnotationEntry } from "../../services/canvas-browser-annotation";

export const BrowserNode = memo(function BrowserNode({ id, data, selected, dragging, width, height }: NodeProps) {
  const {
    browserNumber,
    url,
    state,
    label,
    pageTitle,
    parentTerminalId,
    parentRuntimePaneId,
    viewportMode,
    viewportOrientation,
    viewportWidth,
    viewportHeight,
    viewportScaleMode,
    viewportZoom,
    dispatchCommand,
    onClose,
    onNavigate,
    onConnect,
  } = data as CanvasBrowserNodeData;

  const lodTier = useCanvasLodTier();
  const [resizing, setResizing] = useState(false);
  const [annotationDeliveryState, setAnnotationDeliveryState] = useState<CanvasBrowserAnnotationDeliveryState | null>(null);
  const [annotationDeliveryReason, setAnnotationDeliveryReason] = useState<string | null>(null);
  // The overlay can fire two events for one submission (a base send, then a second with
  // harvested images) sharing the SAME annotation id — this guards against re-augmenting
  // and re-routing what the user experienced as a single action into two agent turns.
  const processedAnnotationIdsRef = useRef<Set<string>>(new Set());
  const overlayBlocked = useCanvasOcclusionBlocked();
  const suspendNativeView = shouldSuspendCanvasNativeOverlay({ dragging, resizing, lodTier, overlayBlocked });
  const { nativeBrowserId } = resolveCanvasBrowserPairIdentity(id, parentTerminalId);
  const agentDriving = useCanvasBrowserActivity(parentTerminalId);
  const handlePageTitleChanged = useCallback(
    (title: string) => {
      dispatchCommand?.({
        kind: "patch-browser",
        nodeId: id,
        patch: { pageTitle: title },
      });
    },
    [dispatchCommand, id],
  );
  useCanvasBrowserTitleChanged({
    nativeBrowserId,
    onTitleChanged: handlePageTitleChanged,
  });

  const handleAnnotationCaptured = useCallback(
    async (entry: CanvasBrowserAnnotationEntry) => {
      // The overlay can fire two events for one submission (a base send, then a second with
      // harvested images) sharing the SAME annotation id. Each routing call is a full agent
      // turn (sendReply/PTY write), so a second event for an id already routed must be
      // ignored — otherwise one user action reads as two unrelated agent responses. The
      // native screenshot below supersedes the old harvested-`<img>` attachment anyway, so
      // skipping the second event loses nothing.
      const annotationId = extractAnnotationTraceId(entry.payload);
      if (annotationId !== "-") {
        if (processedAnnotationIdsRef.current.has(annotationId)) return;
        processedAnnotationIdsRef.current.add(annotationId);
      }

      // Capture the native region screenshot and merge it into the SAME payload BEFORE
      // routing, so the agent gets one combined submission (text + screenshot) instead of a
      // slower text-then-image pair of turns. Best-effort: on failure this returns the
      // original payload unchanged — text delivery is never blocked by a bad capture.
      const augmentedPayload = await augmentAnnotationPayloadWithScreenshot(entry.payload, nativeBrowserId);

      // A Browser Node spawned from a live-agent (LiveAgentNode/HeadlessAgentNode) has no PTY
      // session in terminal-session-registry — its PTY lives in pty-session-pool instead, which
      // routeCanvasBrowserAnnotationToTerminal has no way to reach, so it would queue forever and
      // time out. Detect a registered agent reply handle first and, if present, deliver via the
      // SAME resume mechanism the team composer/NL bar already use for that agent.
      const agentHandle = parentTerminalId ? agentReplyRegistry.get(parentTerminalId) : undefined;

      const result = agentHandle
        ? routeCanvasBrowserAnnotationToAgent({
            agentNodeId: parentTerminalId,
            payload: augmentedPayload,
          })
        : routeCanvasBrowserAnnotationToTerminal({
            terminalId: parentRuntimePaneId ?? parentTerminalId,
            canvasTerminalId: parentTerminalId,
            payload: augmentedPayload,
            onDelivery: (event) => {
              setAnnotationDeliveryState(event.state);
              setAnnotationDeliveryReason(event.reason ?? null);
            },
          });

      // Agent routing is synchronous (sendReply resolves the outcome immediately, with no later
      // onDelivery-style transition to await), so reflect its result directly.
      if (result.ok && agentHandle) {
        setAnnotationDeliveryState(result.delivery);
        setAnnotationDeliveryReason(null);
        return;
      }

      // A metadata-only follow-up belongs to a pick already sent; nothing to show for it.
      if (!result.ok && result.reason !== "attachment-metadata-only") {
        setAnnotationDeliveryState("failed");
        setAnnotationDeliveryReason(result.reason);
      }
    },
    [parentRuntimePaneId, parentTerminalId, nativeBrowserId],
  );

  const { annotationActive, toggleAnnotation } = useCanvasBrowserAnnotation({
    nativeBrowserId,
    onAnnotationCaptured: handleAnnotationCaptured,
  });

  // Surface origin-policy blocks. A silent block is indistinguishable from a
  // broken browser — show which URL was rejected, then let the chip fade.
  const [blockedNavigationUrl, setBlockedNavigationUrl] = useState<string | null>(null);
  useCanvasBrowserNavigationBlocked({
    nativeBrowserId,
    onBlocked: setBlockedNavigationUrl,
  });
  useEffect(() => {
    if (!blockedNavigationUrl) return;
    const timeout = window.setTimeout(() => setBlockedNavigationUrl(null), 5000);
    return () => window.clearTimeout(timeout);
  }, [blockedNavigationUrl]);

  const viewportProfile = resolveBrowserViewportProfile({
    mode: viewportMode,
    orientation: viewportOrientation,
    scaleMode: viewportScaleMode,
    viewportWidth,
    viewportHeight,
    viewportZoom,
    nodeWidth: width,
    nodeHeight: height,
  });

  const {
    containerRef,
    browserState,
    currentUrl,
    openBrowser,
    closeBrowser,
    navigateBrowser,
    reloadBrowser,
    backBrowser,
    forwardBrowser,
    syncBounds,
    nativeViewSuspended,
    nativeErrorReason,
  } = useCanvasBrowserNode({
    nodeId: id,
    nativeBrowserId,
    initialUrl: url,
    initialState: state,
    suspendNativeView,
    zoomFactor: viewportProfile.zoomFactor,
    // Persist self-initiated navigations (link clicks, redirects) so the address
    // bar and node record stay correct across reloads.
    onUrlCommitted: useCallback(
      (next: string) => {
        if (dispatchCommand) dispatchCommand({ kind: "patch-browser", nodeId: id, patch: { url: next } });
        else onNavigate?.(id, next);
      },
      [dispatchCommand, id, onNavigate],
    ),
  });

  // Keep native WebView aligned with the DOM shell after ReactFlow renders. The
  // hook dedupes bounds, so this is cheap and covers controlled node drags.
  useEffect(() => { syncBounds(); });

  const browserActive = browserState === "active";
  const displayName = browserDisplayName({ browserNumber, label, pageTitle, url: currentUrl });

  // When an overlay parks this browser, focus may be stuck in the parked child WebView; return it
  // to the main WebView so the overlay's Escape/shortcuts work without a click. Gesture parks skip.
  useEffect(() => {
    if (shouldReturnFocusToMainWebview({ overlayBlocked, browserActive })) {
      void focusCanvasMainWebview().catch(() => {});
    }
  }, [overlayBlocked, browserActive]);

  useEffect(() => {
    if (!annotationDeliveryState || annotationDeliveryState === "queued") return;
    const timeout = window.setTimeout(() => {
      setAnnotationDeliveryState(null);
      setAnnotationDeliveryReason(null);
    }, 2600);
    return () => window.clearTimeout(timeout);
  }, [annotationDeliveryState]);

  // Notify parent of state changes so the node record stays in sync.
  useEffect(() => {
    if (!browserActive) return;
    if (state === "active") return;
    if (dispatchCommand) dispatchCommand({ kind: "patch-browser", nodeId: id, patch: { state: "active" } });
    else onConnect?.(id);
  }, [browserActive, dispatchCommand, id, onConnect, state]);

  // And back the other way: a node record stuck on "active" while the runtime
  // is disconnected is exactly the stale claim that rendered black panes —
  // keep the record honest so a later remount starts from the truth.
  useEffect(() => {
    if (browserState !== "disconnected") return;
    if (state === "disconnected") return;
    dispatchCommand?.({ kind: "patch-browser", nodeId: id, patch: { state: "disconnected" } });
  }, [browserState, dispatchCommand, id, state]);

  function handleClose() {
    void closeBrowser();
    if (dispatchCommand) dispatchCommand({ kind: "close-node", nodeId: id });
    else onClose?.(id);
  }

  function handleNavigate(next: string) {
    if (browserState === "disconnected") {
      void openBrowser(next);
    } else {
      void navigateBrowser(next);
    }
    if (dispatchCommand) dispatchCommand({ kind: "patch-browser", nodeId: id, patch: { url: next } });
    else onNavigate?.(id, next);
  }

  function handleRename(next: string) {
    dispatchCommand?.({ kind: "patch-browser", nodeId: id, patch: { label: next } });
  }

  const handleViewportChange = useCallback(
    (patch: BrowserNodePatch) => {
      dispatchCommand?.({ kind: "patch-browser", nodeId: id, patch });
    },
    [dispatchCommand, id],
  );

  return (
    <CanvasNodeFrame
      kind="browser"
      selected={selected}
      minWidth={420}
      minHeight={320}
      lodTier={lodTier}
      glyph={<CanvasNodeGlyph label={displayName} tone="idle" />}
      header={<></>}
      onResizeChange={setResizing}
    >
      <BrowserNodeCard
        browserNumber={browserNumber}
        label={label}
        pageTitle={pageTitle}
        url={currentUrl}
        browserState={browserState}
        containerRef={containerRef}
        onOpen={() => void openBrowser()}
        onClose={handleClose}
        onFocus={dispatchCommand ? () => dispatchCommand({ kind: "focus-node", nodeId: id }) : undefined}
        onReload={() => void reloadBrowser()}
        onBack={() => void backBrowser()}
        onForward={() => void forwardBrowser()}
        onNavigate={handleNavigate}
        onRename={handleRename}
        onAnnotate={toggleAnnotation}
        annotationActive={annotationActive}
        annotationDeliveryState={annotationDeliveryState}
        annotationDeliveryReason={annotationDeliveryReason}
        blockedNavigationUrl={blockedNavigationUrl}
        nativeViewSuspended={nativeViewSuspended}
        suspendReason={overlayBlocked ? "overlay" : "gesture"}
        nativeErrorReason={nativeErrorReason}
        viewportProfile={viewportProfile}
        onViewportChange={handleViewportChange}
        agentDriving={agentDriving}
      />
    </CanvasNodeFrame>
  );
});
