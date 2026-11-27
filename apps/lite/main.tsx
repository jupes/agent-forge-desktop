import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import "../../docs/js/ds/ds.css";
import { Button } from "../../docs/js/ds/Button";
import { projectWorkMapSchema } from "../../scripts/projects/project-work-map-protocol";
import {
  ForgeRunPhases,
  ForgeThroughputChart,
} from "../desktop/src/ForgeDataViews";
import { PortfolioWorkMap } from "../desktop/src/PortfolioWorkMap";
import { projectTrendsSchema } from "./protocol";
import "./style.css";

type Invoke = (
  command: string,
  args?: Record<string, string>,
) => Promise<unknown>;

// Tauri exposes only the two application commands granted to the local Lite window.
function invoke(command: string, args?: Record<string, string>) {
  const native = (
    window as Window & { __TAURI_INTERNALS__?: { invoke: Invoke } }
  ).__TAURI_INTERNALS__;
  if (!native)
    throw Error("Open Agent Forge Lite to read the selected checkout.");
  return native.invoke(command, args);
}

async function readMap() {
  return projectWorkMapSchema.parse(await invoke("read_work_map"));
}

async function readTrends(projectId: string) {
  const trends = projectTrendsSchema.parse(
    await invoke("read_project_trends", { projectId }),
  );
  if (trends.projectId !== projectId)
    throw Error("Project observation unavailable.");
  return trends;
}

function useObservation<T>(
  read: () => Promise<T>,
  identity: string,
  failure: string,
  active = true,
) {
  const [state, setState] = useState<{
    data: T | null;
    loading: boolean;
    error: string | null;
  }>({ data: null, loading: true, error: null });
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    let pending = false;
    let timer: number;
    async function refresh() {
      if (stopped || pending || document.hidden) return;
      clearTimeout(timer);
      pending = true;
      setState((previous) => ({ ...previous, loading: true }));
      try {
        const data = await read();
        if (!stopped) setState({ data, loading: false, error: null });
      } catch {
        if (!stopped)
          setState((previous) => ({
            ...previous,
            loading: false,
            error: failure,
          }));
      } finally {
        pending = false;
        if (!stopped) timer = window.setTimeout(refresh, 30000);
      }
    }
    void refresh();
    document.addEventListener("visibilitychange", refresh);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [identity, revision, active]);
  return { ...state, refresh: () => setRevision((current) => current + 1) };
}

function WorkMap({
  active,
  showProject,
}: {
  active: boolean;
  showProject(id: string, name: string): void;
}) {
  const map = useObservation(
    readMap,
    "work-map",
    "Could not read this checkout. Check its saved catalog and tracker, then refresh.",
    active,
  );
  return (
    <PortfolioWorkMap
      edition="lite"
      {...map}
      onRefresh={map.refresh}
      onOpenProject={(id) => {
        const item = map.data?.projects.find((project) => project.id === id);
        if (item) showProject(id, item.name);
      }}
    />
  );
}

function Trends({ id, name }: { id: string; name: string | undefined }) {
  const info = useObservation(
    () => readTrends(id),
    id,
    "Project history is unavailable. Start the Hearth for this checkout, then refresh.",
  );
  const data = info.data;
  return (
    <section class="af-lite-trends">
      <a href="#/work-map">← Work Map</a>
      <header>
        <h1>{name ? name + " trends" : "Project trends"}</h1>
        <Button onClick={info.refresh} disabled={info.loading}>
          Refresh
        </Button>
      </header>
      {info.error && (
        <p role="status">
          {info.error}
          {data && " Showing the last observation."}
        </p>
      )}
      {data ? (
        <>
          <section aria-label="Project throughput">
            <h2>Closure throughput</h2>
            {data.throughput.data ? (
              <ForgeThroughputChart days={data.throughput.data} />
            ) : (
              <p>Throughput unavailable.</p>
            )}
            <p>
              {data.throughput.source} ·{" "}
              <time dateTime={data.throughput.asOf}>
                {new Date(data.throughput.asOf).toLocaleString()}
              </time>
            </p>
            {data.throughput.reason && <p>{data.throughput.reason}</p>}
          </section>
          <section aria-label="Project runs">
            <h2>Recorded Forge runs</h2>
            {data.runs.length ? (
              data.runs.map((run) => (
                <article key={run.slug}>
                  <h3>{run.slug}</h3>
                  <ForgeRunPhases
                    run={{
                      ...run,
                      reviewPending: run.reviewPending ?? null,
                      revising: run.revising ?? false,
                    }}
                  />
                </article>
              ))
            ) : (
              <p>No runs recorded for this project in this checkout.</p>
            )}
          </section>
        </>
      ) : (
        info.loading && <p role="status">Reading project history…</p>
      )}
    </section>
  );
}

function projectFromHash() {
  return (
    /^#\/projects\/(project-[0-9a-f-]{36})$/.exec(window.location.hash)?.[1] ??
    null
  );
}

export function LiteApp() {
  const [project, setProject] = useState(projectFromHash);
  const [selected, setSelected] = useState<{ id: string; name: string } | null>(
    null,
  );
  useEffect(() => {
    const navigate = () => setProject(projectFromHash());
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, []);
  return (
    <div class="af-lite">
      <header class="af-lite-bar">
        <a href="#/work-map" aria-label="Agent Forge Lite Work Map">
          <img
            src={new URL("./forge-lite.svg", import.meta.url).href}
            alt=""
            width="32"
            height="32"
          />
          <span>
            Agent Forge <strong>Lite</strong>
          </span>
        </a>
      </header>
      <main>
        <div hidden={Boolean(project)}>
          <WorkMap
            active={!project}
            showProject={(id, name) => {
              setSelected({ id, name });
              window.location.hash = "/projects/" + encodeURIComponent(id);
            }}
          />
        </div>
        {project && (
          <Trends
            key={project}
            id={project}
            name={selected?.id === project ? selected.name : undefined}
          />
        )}
      </main>
    </div>
  );
}
const root = document.getElementById("app");
if (root) render(<LiteApp />, root);
