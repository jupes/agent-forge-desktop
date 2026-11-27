import { z } from "zod";

const phase = z.enum(["research", "plan", "implement", "ship"]);
const timestamp = z.iso.datetime();
const throughput = z.object({
  data: z
    .array(z.object({ date: z.iso.date(), count: z.int().nonnegative() }))
    .max(366)
    .nullable(),
  source: z.string().max(1024),
  asOf: timestamp,
  complete: z.boolean(),
  reason: z.string().max(4096).nullable(),
});
const run = z.object({
  slug: z.string().min(1).max(256),
  phase,
  completed: z.array(phase).max(4),
  halted: z.object({ phase, reason: z.string().max(4096) }).nullable(),
  reviewPending: phase.nullable().optional(),
  revising: z.boolean().optional(),
  complete: z.boolean(),
});

// The native bridge returns only the observations used by the visualizations.
export const projectTrendsSchema = z.object({
  projectId: z.string().min(1).max(100),
  asOf: timestamp,
  throughput,
  runs: z.array(run).max(1000),
});
export type ProjectTrends = z.infer<typeof projectTrendsSchema>;
