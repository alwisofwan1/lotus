"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame } from "@react-three/fiber";
import { Billboard, Html, Line } from "@react-three/drei";
import * as THREE from "three";
import type { CodeCanvasProjectMeta } from "@/lib/tauri/codecanvas";

const ACCENT = "#67e8f9";
const TEXT = "#f7f2ea";
const MUTED = "rgba(247, 242, 234, 0.42)";
const SPHERE_RADIUS = 2.2;
const AUTO_ROTATE_SPEED = 0.12; // rad/s

export function projectLabel(project: CodeCanvasProjectMeta): string {
  return project.alias || project.rootDir.split(/[\\/]/).filter(Boolean).at(-1) || project.rootDir;
}

interface SpherePoint {
  project: CodeCanvasProjectMeta;
  position: THREE.Vector3;
  count: number;
}

/**
 * Fibonacci-sphere distribution: places N points roughly evenly across the
 * surface of a sphere using the golden-angle spiral. Returns unit vectors
 * scaled to the sphere radius.
 */
function fibonacciSphere(count: number, radius: number): THREE.Vector3[] {
  const points: THREE.Vector3[] = [];
  if (count <= 0) return points;
  if (count === 1) {
    points.push(new THREE.Vector3(0, 0, radius));
    return points;
  }
  const golden = Math.PI * (3 - Math.sqrt(5)); // ~2.39996 rad
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (i / (count - 1)) * 2; // 1 → -1
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    const x = Math.cos(theta) * r;
    const z = Math.sin(theta) * r;
    points.push(new THREE.Vector3(x * radius, y * radius, z * radius));
  }
  return points;
}

interface SceneProps {
  points: SpherePoint[];
  activeProjectId: string | null;
  hoveredId: string | null;
  openingId: string | null;
  reducedMotion: boolean;
  dragging: boolean;
  rotationRef: React.MutableRefObject<{ x: number; y: number }>;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}

function CanvasGlobe({
  points,
  activeProjectId,
  hoveredId,
  openingId,
  reducedMotion,
  dragging,
  rotationRef,
  onHover,
  onSelect,
}: SceneProps) {
  const groupRef = useRef<THREE.Group>(null);

  useFrame((state, delta) => {
    const group = groupRef.current;
    if (!group) return;

    // Idle auto-rotation (skipped when reduced-motion, dragging, or opening).
    if (!reducedMotion && !dragging && !openingId) {
      rotationRef.current.y += AUTO_ROTATE_SPEED * delta;
    }
    group.rotation.x = rotationRef.current.x;
    group.rotation.y = rotationRef.current.y;

    // "Open up" transition: dolly the camera toward the sphere.
    if (openingId && !reducedMotion) {
      const camera = state.camera;
      const target = 2.0;
      const nextZ = camera.position.z + (target - camera.position.z) * Math.min(1, delta * 6);
      camera.position.setZ(nextZ);
      camera.updateProjectionMatrix();
    }
  });

  return (
    <group ref={groupRef}>
      {/* Wireframe shell — ultra-minimal latitude/longitude feel. */}
      <mesh>
        <sphereGeometry args={[SPHERE_RADIUS, 24, 16]} />
        <meshBasicMaterial color={ACCENT} wireframe transparent opacity={0.06} />
      </mesh>
      <mesh>
        <sphereGeometry args={[SPHERE_RADIUS * 0.998, 32, 32]} />
        <meshBasicMaterial color="#0b0a0f" transparent opacity={0.55} side={THREE.BackSide} />
      </mesh>

      {points.map(({ project, position, count }) => {
        const active = project.id === activeProjectId;
        const hovered = project.id === hoveredId;
        const opening = project.id === openingId;
        const highlighted = active || hovered || opening;
        const dotColor = active || opening ? ACCENT : highlighted ? TEXT : "#9a958d";
        const dotScale = opening ? 0.16 : highlighted ? 0.1 : 0.06;
        return (
          <group key={project.id} position={position}>
            <mesh
              onPointerOver={(e) => {
                e.stopPropagation();
                onHover(project.id);
                document.body.style.cursor = "pointer";
              }}
              onPointerOut={(e) => {
                e.stopPropagation();
                onHover(null);
                document.body.style.cursor = "";
              }}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(project.id);
              }}
            >
              <sphereGeometry args={[dotScale, 16, 16]} />
              <meshBasicMaterial color={dotColor} transparent opacity={highlighted ? 1 : 0.7} />
            </mesh>

            {/* Faint ring on the active / hovered point. */}
            {highlighted ? (
              <Billboard>
                <mesh>
                  <ringGeometry args={[dotScale + 0.05, dotScale + 0.07, 32]} />
                  <meshBasicMaterial
                    color={active || opening ? ACCENT : TEXT}
                    transparent
                    opacity={0.7}
                    side={THREE.DoubleSide}
                  />
                </mesh>
              </Billboard>
            ) : null}

            {/* Connector line from surface point slightly outward to the label. */}
            {highlighted ? (
              <Line
                points={[
                  [0, 0, 0],
                  [0, 0.16, 0],
                ]}
                color={active || opening ? ACCENT : MUTED}
                lineWidth={1}
                transparent
                opacity={0.5}
              />
            ) : null}

            <Billboard position={[0, highlighted ? 0.3 : 0.14, 0]}>
              <Html center distanceFactor={6} zIndexRange={[10, 0]} pointerEvents="none">
                <div className={`canvas-sphere-label${highlighted ? " is-active" : ""}`} aria-hidden>
                  <span className="canvas-sphere-label-name">{projectLabel(project)}</span>
                  {active ? <span className="canvas-sphere-label-current">current</span> : null}
                  {count > 0 ? <span className="canvas-sphere-label-count">{count}</span> : null}
                </div>
              </Html>
            </Billboard>
          </group>
        );
      })}
    </group>
  );
}

interface Props {
  projects: CodeCanvasProjectMeta[];
  activeProjectId: string | null;
  nodeCountsByProject: Map<string, number>;
  onOpen: (projectId: string) => void;
}

export function CanvasSphere({ projects, activeProjectId, nodeCountsByProject, onOpen }: Props) {
  const [mounted, setMounted] = useState(false);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);

  const rotationRef = useRef({ x: 0.18, y: 0 });
  const pointerRef = useRef<{ x: number; y: number } | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const raf = requestAnimationFrame(() => {
      setMounted(true);
      setReducedMotion(mq.matches);
    });
    const onChange = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener("change", onChange);
    return () => {
      cancelAnimationFrame(raf);
      mq.removeEventListener("change", onChange);
      if (openTimerRef.current) clearTimeout(openTimerRef.current);
    };
  }, []);

  const points = useMemo<SpherePoint[]>(() => {
    const ordered = [...projects].sort((a, b) => b.updatedAt - a.updatedAt);
    const positions = fibonacciSphere(ordered.length, SPHERE_RADIUS);
    return ordered.map((project, i) => ({
      project,
      position: positions[i] ?? new THREE.Vector3(0, 0, SPHERE_RADIUS),
      count: nodeCountsByProject.get(project.id) ?? 0,
    }));
  }, [projects, nodeCountsByProject]);

  const handleSelect = (id: string) => {
    if (openingId) return;
    setOpeningId(id);
    document.body.style.cursor = "";
    const delay = reducedMotion ? 0 : 520;
    openTimerRef.current = setTimeout(() => onOpen(id), delay);
  };

  // Drag-to-rotate handlers (pointer events on the wrapper, not the canvas mesh).
  const onPointerDown = (e: React.PointerEvent) => {
    if (openingId) return;
    pointerRef.current = { x: e.clientX, y: e.clientY };
    setDragging(true);
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointerRef.current) return;
    const dx = e.clientX - pointerRef.current.x;
    const dy = e.clientY - pointerRef.current.y;
    pointerRef.current = { x: e.clientX, y: e.clientY };
    rotationRef.current.y += dx * 0.006;
    rotationRef.current.x += dy * 0.006;
    // Clamp vertical tilt so the sphere never flips fully over.
    rotationRef.current.x = Math.max(-1.1, Math.min(1.1, rotationRef.current.x));
  };
  const endDrag = () => {
    pointerRef.current = null;
    setDragging(false);
  };

  if (!mounted) {
    return <div className="canvas-sphere-stage" aria-hidden />;
  }

  return (
    <div
      className={`canvas-sphere-stage${dragging ? " is-dragging" : ""}${openingId ? " is-opening" : ""}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerLeave={endDrag}
    >
      <Canvas
        dpr={[1, 2]}
        camera={{ position: [0, 0, 6], fov: 45 }}
        gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
        style={{ touchAction: "none" }}
      >
        <CanvasGlobe
          points={points}
          activeProjectId={activeProjectId}
          hoveredId={hoveredId}
          openingId={openingId}
          reducedMotion={reducedMotion}
          dragging={dragging}
          rotationRef={rotationRef}
          onHover={setHoveredId}
          onSelect={handleSelect}
        />
      </Canvas>

      {points.length === 0 ? (
        <p className="canvas-sphere-empty">No canvases yet — create your first one.</p>
      ) : (
        <p className="canvas-sphere-hint" aria-hidden>
          drag to rotate · click a point to open
        </p>
      )}
    </div>
  );
}
