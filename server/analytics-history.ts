import type { Resource, Role } from "../shared/model.js";
import type { DashboardConfig } from "../shared/analytics.js";
import { reportRange } from "../shared/analytics.js";
import { zonedClock } from "../shared/time.js";
import { canRead } from "./permissions.js";
export interface HistoricalEntry {
  snapshot: Resource;
  created_at: string | Date;
  version: number;
}
export function historicalAnalytics(
  all: Resource[],
  tasks: Resource[],
  entries: HistoricalEntry[],
  userId: string,
  role: Role,
  config: DashboardConfig,
  now = new Date(),
) {
  const range = reportRange(config, now),
    currentMemo = new WeakMap<Resource, boolean>(),
    current = new Map(all.map((r) => [r.id, r])),
    cohort = new Set(tasks.map((t) => t.id)),
    graph = new Map<string, Resource>(),
    days = new Map<
      string,
      { day: string; completed: number; reopened: number }
    >();
  for (
    let day = range.from;
    day <= range.to;
    day = new Date(Date.parse(day + "T12:00:00Z") + 86400000)
      .toISOString()
      .slice(0, 10)
  )
    days.set(day, { day, completed: 0, reopened: 0 });
  const timestamp = (value: string | Date) => {
    const text = value instanceof Date ? value.toISOString() : value;
    const match = /^(.*T\d{2}:\d{2}:\d{2})\.(\d+)Z$/.exec(text);
    return match
      ? match[1] + "." + match[2].padEnd(6, "0") + "Z"
      : new Date(text).toISOString().replace(/\.(\d{3})Z$/, ".$1000Z");
  };
  const events = entries.map((e) => ({
    kind: "version" as const,
    time: timestamp(e.created_at),
    entry: e,
  }));
  const closures = all
    .filter(
      (r) =>
        r.kind === "sprint" &&
        !r.deleted_at &&
        r.data.status === "completed" &&
        r.data.closedAt &&
        canRead(r, userId, role, all, new Set(), currentMemo),
    )
    .map((sprint) => ({
      kind: "closure" as const,
      time: timestamp(sprint.data.closedAt),
      sprint,
    }));
  const ordered: Array<(typeof events)[number] | (typeof closures)[number]> = [
    ...events,
    ...closures,
  ].sort(
    (a, b) =>
      a.time.localeCompare(b.time) ||
      Number(a.kind === "closure") - Number(b.kind === "closure"),
  );
  const progress = new Map<
      string,
      {
        last: Resource;
        allowed: boolean;
        completePrefix: boolean;
        created: string;
        started: string | null;
        cycleAllowed: boolean;
      }
    >(),
    lead: number[] = [],
    cycle: number[] = [],
    delivered = new Set<string>(),
    sprints: Array<{
      id: string;
      title: string;
      closedAt: string;
      total: number;
      done: number;
      points: number;
      completedPoints: number;
    }> = [];
  let completionEvents = 0,
    reopenedEvents = 0;
  let historicalMemo = new WeakMap<Resource, boolean>();
  const accessKey = (r: Resource) =>
    JSON.stringify([
      r.kind,
      r.created_by,
      Boolean(r.deleted_at),
      r.data.ownerId || null,
      r.data.projectId || null,
      r.data.parentId || null,
      r.data.targetId || null,
      Boolean(r.data.private),
      r.data.members || [],
      r.data.assigneeId || null,
    ]);
  const authorized = (resource: Resource, old: Resource[]) => {
    if (!canRead(resource, userId, role, old, new Set(), historicalMemo))
      return false;
    const pending = [resource],
      seen = new Set<string>();
    while (pending.length) {
      const r = pending.pop()!;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      if (seen.size > 512) return false;
      const latest = current.get(r.id);
      if (
        !latest ||
        latest.deleted_at ||
        !canRead(latest, userId, role, all, new Set(), currentMemo)
      )
        return false;
      for (const id of [
        r.data.projectId,
        r.data.parentId,
        r.data.targetId,
      ].filter(Boolean)) {
        const parent = graph.get(id);
        if (!parent) return false;
        pending.push(parent);
      }
    }
    return true;
  };
  for (let index = 0; index < ordered.length;) {
    let end = index + 1;
    while (end < ordered.length && ordered[end].time === ordered[index].time)
      end++;
    const group = ordered.slice(index, end);
    // A transaction can create an ancestor and its task with the same timestamp.
    for (const e of group)
      if (e.kind === "version") {
        const previous = graph.get(e.entry.snapshot.id);
        if (!previous || accessKey(previous) !== accessKey(e.entry.snapshot))
          historicalMemo = new WeakMap();
        graph.set(e.entry.snapshot.id, e.entry.snapshot);
      }
    const old = [...graph.values()];
    for (const event of group) {
      const day = zonedClock(new Date(event.time), config.timeZone).day,
        bucket = days.get(day);
      if (event.kind === "version") {
        const task = event.entry.snapshot;
        if (task.kind !== "task" || !cohort.has(task.id)) continue;
        const previous = progress.get(task.id),
          allowed = authorized(task, old),
          continuous = previous
            ? previous.last.version + 1 === task.version
            : task.version === 1;
        const completePrefix =
            allowed && continuous && (previous?.completePrefix ?? true),
          reopened =
            previous?.last.data.status === "done" &&
            !["done", "cancelled"].includes(task.data.status),
          newStart =
            task.data.status === "in_progress" &&
            (!previous?.started || reopened) &&
            previous?.last.data.status !== "in_progress" &&
            allowed &&
            (previous ? previous.allowed && continuous : task.version === 1),
          started = newStart
            ? event.time
            : reopened
              ? null
              : previous?.started || null,
          cycleAllowed =
            newStart ||
            (Boolean(started) &&
              allowed &&
              continuous &&
              Boolean(previous?.cycleAllowed)),
          created = previous?.created || event.time;
        const isDelivery =
          task.data.status === "done" &&
          previous?.last.data.status !== "done" &&
          allowed &&
          (previous ? previous.allowed && continuous : task.version === 1);
        if (bucket && isDelivery) {
          bucket.completed++;
          completionEvents++;
          delivered.add(task.id);
          if (completePrefix)
            lead.push((Date.parse(event.time) - Date.parse(created)) / 3600000);
          if (started && cycleAllowed)
            cycle.push(
              (Date.parse(event.time) - Date.parse(started)) / 3600000,
            );
        }
        if (
          bucket &&
          allowed &&
          previous?.allowed &&
          continuous &&
          previous.last.data.status === "done" &&
          !["done", "cancelled"].includes(task.data.status)
        ) {
          bucket.reopened++;
          reopenedEvents++;
        }
        progress.set(task.id, {
          last: task,
          allowed,
          completePrefix,
          created,
          started,
          cycleAllowed,
        });
      } else if (bucket && authorized(event.sprint, old)) {
        const selected = (event.sprint.data.snapshot || []).filter(
          (t: Resource) =>
            cohort.has(t.id) &&
            authorized(t, old) &&
            t.data.status !== "cancelled",
        ) as Resource[];
        if (
          selected.length ||
          (!config.projectIds.length &&
            !(event.sprint.data.snapshot || []).length)
        )
          sprints.push({
            id: event.sprint.id,
            title: event.sprint.title,
            closedAt: event.time,
            total: selected.length,
            done: selected.filter((t) => t.data.status === "done").length,
            points: selected.reduce((n, t) => n + (t.data.estimate || 0), 0),
            completedPoints: selected
              .filter((t) => t.data.status === "done")
              .reduce((n, t) => n + (t.data.estimate || 0), 0),
          });
      }
    }
    index = end;
  }
  const median = (values: number[]) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b),
      middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  return {
    available: true as const,
    permissionScoped: true,
    range,
    daily: [...days.values()],
    completionEvents,
    deliveredTasks: delivered.size,
    reopenedEvents,
    medianLeadHours: median(lead),
    medianCycleHours: median(cycle),
    leadMeasurements: lead.length,
    cycleMeasurements: cycle.length,
    closedSprints: sprints
      .sort((a, b) => b.closedAt.localeCompare(a.closedAt))
      .slice(0, 100),
    sprintRowsLimited: sprints.length > 100,
  };
}
