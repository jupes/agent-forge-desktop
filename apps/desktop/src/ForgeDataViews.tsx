import { useState } from "preact/hooks";
import { FORGE_PHASES } from "../../../scripts/forge/phases";
import type { RunSummary } from "../../../scripts/forge/runs";
import type { ProjectOverview } from "../../../types/project-overview";
import "./forge-data-views.css";

type ClosureDay = NonNullable<ProjectOverview["throughput"]["data"]>[number];

const dayLabel = new Intl.DateTimeFormat(undefined, {
  timeZone: "UTC",
  month: "short",
  day: "numeric",
});

function shortDate(date: string) {
  return dayLabel.format(new Date(`${date}T00:00:00Z`));
}

function closureCount(count: number) {
  return `${count.toLocaleString()} ${count === 1 ? "closure" : "closures"}`;
}

/** The source supplies a contiguous series of UTC days, including verified zeroes. */
export function ForgeThroughputChart({
  days,
}: {
  days: readonly ClosureDay[];
}) {
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const last = days.at(-1);
  if (!last) return <p>No closure dates were returned.</p>;
  const matchedIndex = days.findIndex((day) => day.date === selectedDate);
  const index = matchedIndex < 0 ? days.length - 1 : matchedIndex;
  const selected = days[index]!;
  const peak = Math.max(...days.map((day) => day.count));
  const total = days.reduce((sum, day) => sum + day.count, 0);
  const valueText = `${selected.date} UTC, ${closureCount(selected.count)}`;
  return (
    <figure
      class="af-forge-throughput"
      aria-label="Recorded closures by UTC day"
    >
      <figcaption>
        <div>
          <strong>{total.toLocaleString()}</strong> recorded{" "}
          {total === 1 ? "closure" : "closures"}
        </div>
        <span>
          <time dateTime={selected.date}>{shortDate(selected.date)}</time> ·{" "}
          {closureCount(selected.count)}
        </span>
      </figcaption>
      <div class="af-forge-series">
        <div class="af-forge-y-axis" aria-hidden="true">
          <span>{peak > 0 ? peak.toLocaleString() : ""}</span>
          <span>0</span>
        </div>
        <div class="af-forge-plot">
          <div class="af-forge-bins" aria-hidden="true">
            <span
              class="af-forge-day-cursor"
              style={{
                width: `${100 / days.length}%`,
                transform: `translateX(${index * 100}%)`,
              }}
            />
            {days.map((day, offset) => (
              <span
                key={day.date}
                data-selected={offset === index}
                class="af-forge-bin"
              >
                <i
                  style={{
                    transform: `scaleY(${peak ? day.count / peak : 0})`,
                  }}
                />
              </span>
            ))}
          </div>
          <input
            type="range"
            min={0}
            max={days.length - 1}
            step={1}
            value={index}
            disabled={days.length === 1}
            aria-label="Inspect daily closures"
            aria-valuetext={valueText}
            title={valueText}
            onPointerMove={(event) => {
              if (event.pointerType !== "mouse" || event.buttons !== 0) return;
              const bounds = event.currentTarget.getBoundingClientRect();
              const position = (event.clientX - bounds.left) / bounds.width;
              const hovered = Math.min(
                days.length - 1,
                Math.max(0, Math.floor(position * days.length)),
              );
              setSelectedDate(days[hovered]!.date);
            }}
            onInput={(event) =>
              setSelectedDate(days[event.currentTarget.valueAsNumber]!.date)
            }
          />
        </div>
        <div class="af-forge-x-axis" aria-hidden="true">
          <span>{shortDate(days[0]!.date)}</span>
          <span>{shortDate(last.date)} UTC</span>
        </div>
      </div>
      <details>
        <summary>Daily counts</summary>
        <table aria-label="Daily closure counts">
          <thead>
            <tr>
              <th scope="col">UTC date</th>
              <th scope="col">Recorded closures</th>
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.date} data-selected={day.date === selected.date}>
                <th scope="row">
                  <time dateTime={day.date}>{day.date}</time>
                </th>
                <td>{day.count.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  );
}

type PhaseObservation = Pick<
  RunSummary,
  "phase" | "completed" | "halted" | "complete"
> & {
  reviewPending?: RunSummary["reviewPending"] | undefined;
  revising?: boolean | undefined;
};

export function ForgeRunPhases({ run }: { run: PhaseObservation }) {
  return (
    <ol class="af-forge-phases" aria-label="Recorded run phases">
      {FORGE_PHASES.map((phase) => {
        let state = "Upcoming";
        if (run.halted?.phase === phase) state = "Halted";
        else if (run.reviewPending === phase)
          state = run.revising ? "Revision" : "Review";
        else if (run.completed.includes(phase)) state = "Complete";
        else if (run.phase === phase && !run.complete) state = "Current";
        return (
          <li
            key={phase}
            data-state={state}
            aria-current={state === "Current" ? "step" : undefined}
          >
            <i aria-hidden="true" />
            <strong>{phase}</strong>
            <small>{state}</small>
          </li>
        );
      })}
    </ol>
  );
}
