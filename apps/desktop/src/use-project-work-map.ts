import { useEffect, useRef, useState } from "preact/hooks";
import { operatorRead } from "../../../docs/js/operator";
import {
  appStream,
  type LiveRead,
  pageReads,
  readOperatorRoute,
  startLiveRead,
} from "../../../docs/js/use-stream";
import { projectWorkMapSchema } from "../../../scripts/projects/project-work-map-protocol";
import type { ProjectWorkMap } from "../../../types/project-work-map";

const events = [
  "bead.transitioned",
  "operator.action",
  "prompt.submitted",
  "session.started",
  "session.ended",
] as const;
const initialRead = { data: null, error: null, loading: true };

export function useProjectWorkMap(enabled: boolean) {
  const [state, setState] = useState<{
    data: ProjectWorkMap | null;
    error: string | null;
    loading: boolean;
  }>(initialRead);
  const live = useRef<LiveRead | null>(null);

  useEffect(() => {
    setState(initialRead);
    if (!enabled) return;
    const read = startLiveRead<ProjectWorkMap>({
      load: async () => {
        const value = await readOperatorRoute<unknown>("/projects/work-map", {
          ...pageReads(),
          fetch: operatorRead,
        });
        const parsed = projectWorkMapSchema.safeParse(value);
        if (!parsed.success)
          throw Error("The Work Map read could not be verified.");
        return parsed.data;
      },
      client: appStream(),
      kinds: events,
      reportRefreshError: true,
      onChange: setState,
    });
    live.current = read;
    return () => {
      read();
      if (live.current === read) live.current = null;
    };
  }, [enabled]);

  return { ...state, reload: () => live.current?.reload() };
}
