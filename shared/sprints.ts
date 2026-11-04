import { z } from "zod";
import type { Resource } from "./model.js";
export const capacityEntrySchema = z
  .object({
    userId: z.string().uuid(),
    days: z.number().min(0).max(366),
    hoursPerDay: z.number().min(0).max(24),
    focusPercent: z.number().min(0).max(100),
    points: z.number().min(0).max(10000).nullable(),
  })
  .strict();
export const capacityPlanSchema = z.array(capacityEntrySchema).max(300);
export type CapacityEntry = z.infer<typeof capacityEntrySchema>;
export const ceremonySchema = z
  .object({
    review: z
      .object({
        outcome: z.enum(["pending", "achieved", "partial", "missed"]),
        delivered: z.string().max(20000),
        feedback: z.string().max(20000),
      })
      .strict(),
    retrospective: z
      .object({
        wentWell: z.string().max(20000),
        improve: z.string().max(20000),
        actionIds: z.array(z.string().uuid()).max(100),
      })
      .strict(),
  })
  .strict();
export type Ceremony = z.infer<typeof ceremonySchema>;
export const emptyCeremony = (): Ceremony => ({
  review: { outcome: "pending", delivered: "", feedback: "" },
  retrospective: { wentWell: "", improve: "", actionIds: [] },
});
export const pokerDeck = [
  "0",
  "0.5",
  "1",
  "2",
  "3",
  "5",
  "8",
  "13",
  "20",
  "40",
  "100",
  "?",
  "coffee",
] as const;
export function capacityHours(entry: CapacityEntry) {
  return (
    Math.round(
      ((entry.days * entry.hoursPerDay * entry.focusPercent) / 100) * 100,
    ) / 100
  );
}
export function completionWarnings(sprint: Resource, tasks: Resource[]) {
  return {
    sprintCriteria: (sprint.data.checklist || []).filter(
      (item: any) => !item.done,
    ).length,
    taskChecklists: tasks.filter(
      (task) =>
        task.data.status === "done" &&
        (task.data.checklist || []).some((item: any) => !item.done),
    ).length,
  };
}
function totals(tasks: Resource[]) {
  const scope = tasks.filter(
      (t) => !t.deleted_at && t.data.status !== "cancelled",
    ),
    done = scope.filter((t) => t.data.status === "done");
  return {
    tasks: scope.length,
    doneTasks: done.length,
    scope: scope.reduce((sum, t) => sum + (t.data.estimate || 0), 0),
    done: done.reduce((sum, t) => sum + (t.data.estimate || 0), 0),
    unestimated: scope.filter((t) => !t.data.estimate).length,
  };
}
export interface TaskVersion {
  snapshot: Resource;
  created_at: string;
  version: number;
}
export function sprintMetrics(
  sprintId: string,
  baseline: Resource[],
  startedAt: string,
  versions: TaskVersion[],
  endAt: string,
  closedSnapshot?: Resource[],
) {
  const start = Date.parse(startedAt),
    end = Math.max(start, Date.parse(endAt)),
    state = new Map(baseline.map((t) => [t.id, t]));
  const points: any[] = [{ at: startedAt, ...totals([...state.values()]) }],
    changes: any[] = [];
  const closedVersions = new Map(
    (closedSnapshot || [])
      .filter((t) => !["done", "cancelled"].includes(t.data.status))
      .map((t) => [t.id, t.version + 1]),
  );
  const history = [...versions].sort(
    (a, b) =>
      Date.parse(a.created_at) - Date.parse(b.created_at) ||
      a.snapshot.id.localeCompare(b.snapshot.id) ||
      a.version - b.version,
  );
  for (const version of history) {
    const at = Date.parse(version.created_at),
      task = version.snapshot;
    if (
      at < start ||
      at > end ||
      closedVersions.get(task.id) === version.version
    )
      continue;
    const previous = state.get(task.id),
      was = !!previous,
      is = task.data.sprintId === sprintId && !task.deleted_at;
    if (is) state.set(task.id, task);
    else state.delete(task.id);
    if (was !== is)
      changes.push({
        at: version.created_at,
        taskId: task.id,
        title: task.title,
        type: is ? "added" : "removed",
        points: task.data.estimate || previous?.data.estimate || 0,
      });
    else if (
      is &&
      previous &&
      (previous.data.estimate || 0) !== (task.data.estimate || 0)
    )
      changes.push({
        at: version.created_at,
        taskId: task.id,
        title: task.title,
        type: "estimate",
        before: previous.data.estimate || 0,
        after: task.data.estimate || 0,
      });
    if (was || is)
      points.push({ at: version.created_at, ...totals([...state.values()]) });
  }
  const final = closedSnapshot || [...state.values()];
  points.push({ at: new Date(end).toISOString(), ...totals(final) });
  const days = Math.max(1, Math.ceil((end - start) / 86400000)),
    step = Math.max(1, Math.ceil(days / 199)),
    series: any[] = [];
  let cursor = 0;
  for (let day = 0; day <= days; day += step) {
    const at = Math.min(end, start + day * 86400000);
    while (
      cursor + 1 < points.length &&
      Date.parse(points[cursor + 1].at) <= at
    )
      cursor++;
    const point = points[cursor];
    series.push({
      ...point,
      at: new Date(at).toISOString(),
      remaining: Math.max(0, point.scope - point.done),
    });
  }
  const last = points[points.length - 1];
  if (series[series.length - 1]?.at !== last.at)
    series.push({ ...last, remaining: Math.max(0, last.scope - last.done) });
  const lead: number[] = [],
    cycle: number[] = [];
  for (const task of final.filter((t) => t.data.status === "done")) {
    const taskHistory = history.filter(
        (v) => v.snapshot.id === task.id && Date.parse(v.created_at) <= end,
      ),
      done = taskHistory.find((v) => v.snapshot.data.status === "done"),
      active = taskHistory.find(
        (v) => v.snapshot.data.status === "in_progress",
      );
    if (done) {
      lead.push(
        Math.max(
          0,
          (Date.parse(done.created_at) - Date.parse(task.created_at)) / 3600000,
        ),
      );
      if (
        active &&
        Date.parse(active.created_at) <= Date.parse(done.created_at)
      )
        cycle.push(
          (Date.parse(done.created_at) - Date.parse(active.created_at)) /
            3600000,
        );
    }
  }
  const average = (values: number[]) =>
    values.length
      ? Math.round(
          (values.reduce((sum, n) => sum + n, 0) / values.length) * 1000000,
        ) / 1000000
      : null;
  const meaningful = points.filter(
    (point, index) =>
      index === 0 ||
      index === points.length - 1 ||
      ["scope", "done", "tasks", "doneTasks", "unestimated"].some(
        (key) => point[key] !== points[index - 1][key],
      ),
  );
  const graphSeries =
    meaningful.length <= 200
      ? meaningful.map((point) => ({
          ...point,
          remaining: Math.max(0, point.scope - point.done),
        }))
      : series;
  return {
    baseline: totals(baseline),
    final: totals(final),
    series: graphSeries,
    changes,
    leadHours: average(lead),
    cycleHours: average(cycle),
    leadSamples: lead.length,
    cycleSamples: cycle.length,
    sampled: meaningful.length > 200,
  };
}
