import { useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import type { ProjectWorkMap } from "../../../types/project-work-map";
import type { PortfolioGraph } from "./portfolio-work-map-model";

type Node = PortfolioGraph["nodes"][number];
type Edge = PortfolioGraph["edges"][number];
type MotionNode = Node & { opacity: number; exiting: boolean };
type MotionEdge = Edge & { opacity: number };
export interface GraphFrame {
  nodes: MotionNode[];
  edges: MotionEdge[];
  width: number;
  height: number;
}

const mix = (from: number, to: number, progress: number) =>
  from + (to - from) * progress;

function animate(duration: number, present: (progress: number) => void) {
  const started = performance.now();
  let frame = 0;
  const tick = (now: number) => {
    const time = Math.min(1, Math.max(0, now - started) / duration);
    present(1 - (1 - time) ** 3);
    if (time < 1) frame = requestAnimationFrame(tick);
  };
  tick(started);
  return () => cancelAnimationFrame(frame);
}

export function useReducedMotion() {
  const query = useMemo(
    () => window.matchMedia("(prefers-reduced-motion: reduce)"),
    [],
  );
  const [reduced, setReduced] = useState(query.matches);
  useLayoutEffect(() => {
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    update();
    return () => query.removeEventListener("change", update);
  }, [query]);
  return reduced;
}

function settled(graph: PortfolioGraph): GraphFrame {
  return {
    ...graph,
    nodes: graph.nodes.map((node) => ({ ...node, opacity: 1, exiting: false })),
    edges: graph.edges.map((edge) => ({ ...edge, opacity: 1 })),
  };
}

function ancestorPosition(
  child: MotionNode,
  hierarchy: Map<string, MotionNode>,
  visible: Map<string, MotionNode>,
) {
  let parent = child.node.parentKey;
  while (parent) {
    const anchor = visible.get(parent);
    if (anchor) return anchor;
    parent = hierarchy.get(parent)?.node.parentKey ?? null;
  }
  return child;
}

const edgeKey = ({ type, from, to }: Edge) => JSON.stringify([type, from, to]);

/** Keep exits until they reach the ancestor that represents them in the new map. */
function transition(source: GraphFrame, target: GraphFrame) {
  const before = new Map(source.nodes.map((item) => [item.node.key, item]));
  const after = new Map(target.nodes.map((item) => [item.node.key, item]));
  const nodes = target.nodes.map((end) => {
    const current = before.get(end.node.key);
    if (current) return { start: current, end };
    const anchor = ancestorPosition(end, after, before);
    return { start: { ...end, x: anchor.x, y: anchor.y, opacity: 0 }, end };
  });
  for (const start of source.nodes) {
    if (after.has(start.node.key)) continue;
    const anchor = ancestorPosition(start, before, after);
    nodes.push({
      start,
      end: { ...start, x: anchor.x, y: anchor.y, opacity: 0, exiting: true },
    });
  }
  const previousEdges = new Map(
    source.edges.map((edge) => [edgeKey(edge), edge]),
  );
  const edges = target.edges.map((edge) => {
    const key = edgeKey(edge);
    const start = previousEdges.get(key)?.opacity ?? 0;
    previousEdges.delete(key);
    return { edge, start, end: 1 };
  });
  for (const edge of previousEdges.values())
    edges.push({ edge, start: edge.opacity, end: 0 });

  if (
    source.width === target.width &&
    source.height === target.height &&
    nodes.every(
      ({ start, end }) =>
        start.x === end.x && start.y === end.y && start.opacity === end.opacity,
    ) &&
    edges.every(({ start, end }) => start === end)
  )
    return null;

  return (progress: number): GraphFrame => ({
    width: mix(source.width, target.width, progress),
    height: mix(source.height, target.height, progress),
    nodes: nodes.map(({ start, end }) => ({
      ...end,
      x: mix(start.x, end.x, progress),
      y: mix(start.y, end.y, progress),
      opacity: mix(start.opacity, end.opacity, progress),
    })),
    edges: edges.map(({ edge, start, end }) => ({
      ...edge,
      opacity: mix(start, end, progress),
    })),
  });
}

export function useGraphMotion(
  graph: PortfolioGraph,
  snapshot: ProjectWorkMap,
  reduced: boolean,
) {
  const target = useMemo(() => settled(graph), [graph]);
  const [frame, setFrame] = useState(target);
  const current = useRef(target);
  const previousSnapshot = useRef(snapshot);
  const refreshed = previousSnapshot.current !== snapshot;
  useLayoutEffect(() => {
    previousSnapshot.current = snapshot;
    if (current.current === target) return;
    const present = (next: GraphFrame) => {
      current.current = next;
      setFrame(next);
    };
    const sample =
      !reduced && !refreshed && transition(current.current, target);
    if (!sample) {
      present(target);
      return;
    }
    return animate(240, (progress) =>
      present(progress === 1 ? target : sample(progress)),
    );
  }, [target, reduced, refreshed, snapshot]);
  // A refresh may remove a project or its data. Drop its old contents in this render.
  return refreshed || reduced ? target : frame;
}

interface Camera {
  zoom: number;
  // Fractions of the graph remain meaningful while its bounds change.
  x: number;
  y: number;
}

export function useCameraMotion(reduced: boolean) {
  const [camera, setCamera] = useState<Camera>({ zoom: 1, x: 0.5, y: 0.5 });
  const current = useRef(camera);
  const [requestedZoom, setRequestedZoom] = useState(1);
  const flight = useRef<{ cancel(): void; target: Camera } | null>(null);
  const interrupt = () => {
    if (!flight.current) return;
    flight.current.cancel();
    flight.current = null;
    setRequestedZoom(current.current.zoom);
  };
  const fly = (start: Camera, target: Camera) => {
    interrupt();
    setRequestedZoom(target.zoom);
    const present = (next: Camera) => {
      current.current = next;
      setCamera(next);
    };
    if (
      reduced ||
      (start.zoom === target.zoom &&
        start.x === target.x &&
        start.y === target.y)
    ) {
      present(target);
      return;
    }
    const cancel = animate(220, (progress) => {
      if (progress === 1) {
        flight.current = null;
        present(target);
      } else {
        present({
          zoom: mix(start.zoom, target.zoom, progress),
          x: mix(start.x, target.x, progress),
          y: mix(start.y, target.y, progress),
        });
      }
    });
    flight.current = { cancel, target };
  };
  useLayoutEffect(() => {
    if (reduced && flight.current) {
      const { cancel, target } = flight.current;
      cancel();
      flight.current = null;
      current.current = target;
      setCamera(target);
    }
  }, [reduced]);
  useLayoutEffect(() => () => flight.current?.cancel(), []);
  return { camera, requestedZoom, fly, interrupt };
}
