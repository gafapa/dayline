import { validateCustomFieldData } from "./custom-field-validation.js";
import { normalizeTaskState } from "../shared/workflow.js";
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Connection, Database } from "./database.js";
import type { Resource, Role, User } from "../shared/model.js";
import {
  canManageRule,
  nextOccurrence,
  ruleMatches,
  validAction,
  validDay,
  validTimeZone,
  zonedClock,
} from "../shared/automation.js";
import { canRead } from "./permissions.js";
import { HttpError } from "./errors.js";
import { notifyChange } from "./notifications.js";
import { processReminders } from "./reminders.js";
import {
  deliverNotifications,
  scheduleNotification,
} from "./notification-delivery.js";

type Run = {
  id: string;
  workspace_id: string;
  rule_id: string | null;
  rule_version: number | null;
  target_id: string | null;
  actor_id: string;
  event_key: string;
  trigger: string;
  status: string;
  attempts: number;
  cycle_attempts: number;
  result: any;
};
const list = async (tx: Connection, workspaceId: string) =>
  (
    await tx.query<Resource>("SELECT * FROM resources WHERE workspace_id=$1", [
      workspaceId,
    ])
  ).rows;
const cancelled = (reason: string) => ({
  status: "cancelled",
  result: { reason },
});

export async function validateAutomation(
  tx: Connection,
  proposed: Resource,
  previous: Resource | undefined,
  userId: string,
  role: Role,
  all: Resource[],
) {
  if (proposed.kind === "automation") {
    if (
      role === "guest" ||
      role === "viewer" ||
      (previous && !canManageRule(previous, userId, role))
    )
      throw new HttpError(
        403,
        "Solo el autor o un administrador puede modificar esta regla.",
      );
    if (proposed.deleted_at) return;
    if (
      !previous &&
      all.filter((r) => r.kind === "automation" && !r.deleted_at).length >= 100
    )
      throw new HttpError(
        400,
        "El espacio admite hasta 100 reglas. Archiva las que ya no necesites.",
      );
    const data = proposed.data;
    if (!data.projectId && role !== "admin")
      throw new HttpError(
        403,
        "Las reglas generales requieren administración. Selecciona un proyecto.",
      );
    // Incomplete drafts are retained while disabled, but never executed.
    if (!data.enabled) return;
    if (
      ![
        "task_created",
        "task_updated",
        "task_overdue",
        "daily_summary",
      ].includes(data.trigger) ||
      !validAction(data.action, data.actionValue || "")
    )
      throw new HttpError(
        400,
        "Completa el evento, la acción y su valor antes de activar la regla.",
      );
    if (data.trigger === "daily_summary" && data.action !== "notify")
      throw new HttpError(
        400,
        "Los resúmenes diarios generan una notificación interna.",
      );
    if (!validTimeZone(data.timeZone || "UTC"))
      throw new HttpError(400, "La zona horaria no es válida.");
    if (["assign", "notify"].includes(data.action)) {
      const member = (
        await tx.query(
          "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",
          [proposed.workspace_id, data.actionValue],
        )
      ).rows[0];
      const project = all.find((r) => r.id === data.projectId);
      if (
        !member ||
        (project && !canRead(project, data.actionValue, member.role, all))
      )
        throw new HttpError(
          400,
          "El destinatario debe tener acceso al proyecto.",
        );
    }
  }
  if (proposed.deleted_at) return;
  if (
    proposed.kind === "task" &&
    proposed.data.dueDate &&
    !validDay(proposed.data.dueDate)
  )
    throw new HttpError(400, "La fecha límite no es válida.");
  if (
    proposed.kind === "task" &&
    proposed.data.recurrence &&
    proposed.data.recurrence !== "none"
  ) {
    if (!validDay(proposed.data.dueDate))
      throw new HttpError(
        400,
        "Las tareas recurrentes necesitan una fecha límite válida.",
      );
    if (!validTimeZone(proposed.data.timeZone || "UTC"))
      throw new HttpError(400, "La zona horaria no es válida.");
    if (
      proposed.data.recurrenceEndDate &&
      (!validDay(proposed.data.recurrenceEndDate) ||
        proposed.data.recurrenceEndDate < proposed.data.dueDate)
    )
      throw new HttpError(
        400,
        "El final de la serie debe ser posterior a su fecha límite.",
      );
    proposed.data.recurrenceDay =
      previous?.data.dueDate === proposed.data.dueDate
        ? previous.data.recurrenceDay || Number(proposed.data.dueDate.slice(8))
        : Number(proposed.data.dueDate.slice(8));
  }
}

async function enqueue(
  tx: Connection,
  workspaceId: string,
  ruleId: string | null,
  targetId: string | null,
  actorId: string,
  trigger: string,
  key: string,
  now = new Date(),
) {
  await tx.query(
    `INSERT INTO automation_runs(id,workspace_id,rule_id,target_id,actor_id,event_key,trigger,next_attempt_at,rule_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,(SELECT version FROM resources WHERE id=$3)) ON CONFLICT(workspace_id,event_key) DO NOTHING`,
    [
      randomUUID(),
      workspaceId,
      ruleId,
      targetId,
      actorId,
      key,
      trigger,
      now.toISOString(),
    ],
  );
}
export async function enqueueTaskEvents(
  tx: Connection,
  task: Resource,
  previous: Resource | undefined,
  all: Resource[],
  actorId: string,
) {
  if (task.kind !== "task" || task.deleted_at) return;
  const trigger = previous ? "task_updated" : "task_created";
  for (const rule of all.filter(
    (r) =>
      r.kind === "automation" &&
      !r.deleted_at &&
      r.data.enabled &&
      !r.data.archived &&
      r.data.trigger === trigger &&
      ruleMatches(r, task),
  )) {
    await enqueue(
      tx,
      task.workspace_id,
      rule.id,
      task.id,
      rule.created_by,
      trigger,
      `event:${rule.id}:${task.id}:${task.version}`,
    );
  }
  if (
    task.data.recurrence &&
    task.data.recurrence !== "none" &&
    task.data.status === "done" &&
    previous?.data.status !== "done"
  ) {
    await enqueue(
      tx,
      task.workspace_id,
      null,
      task.id,
      actorId,
      "recurrence",
      `recurrence:${task.id}`,
    );
  }
}

export class AutomationEngine {
  private running: Promise<void> | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ruleCursor = "00000000-0000-0000-0000-000000000000";
  lastTick: string | null = null;
  lastError = false;
  constructor(
    private db: Database,
    private changed: (workspaceId: string) => void = () => {},
  ) {}
  start() {
    if (this.timer) return;
    const work = () => {
      void this.tick().catch(() => {
        this.lastError = true;
      });
    };
    this.timer = setInterval(work, 15000);
    this.timer.unref();
    work();
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }
  tick(now = new Date(), workspaceId?: string) {
    if (this.running) return this.running;
    this.running = this.work(now, workspaceId)
      .then(() => {
        this.lastTick = now.toISOString();
        this.lastError = false;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async work(now: Date, workspaceId?: string) {
    for (const workspace of await processReminders(this.db, now, workspaceId))
      this.changed(workspace);
    for (const workspace of await deliverNotifications(
      this.db,
      now,
      workspaceId,
    ))
      this.changed(workspace);
    const rules = (
      await this.db.query<Resource>(
        `SELECT * FROM resources WHERE kind='automation' AND deleted_at IS NULL AND data->>'enabled'='true' AND coalesce(data->>'archived','false')<>'true' AND data->>'trigger' IN ('task_overdue','daily_summary') AND ($1::uuid IS NULL OR workspace_id=$1) AND id>$2 ORDER BY id LIMIT 100`,
        [
          workspaceId || null,
          workspaceId
            ? "00000000-0000-0000-0000-000000000000"
            : this.ruleCursor,
        ],
      )
    ).rows;
    if (!workspaceId)
      this.ruleCursor =
        rules.length === 100
          ? rules[rules.length - 1].id
          : "00000000-0000-0000-0000-000000000000";
    for (const rule of rules) {
      if (!validTimeZone(rule.data.timeZone || "UTC")) continue;
      const clock = zonedClock(now, rule.data.timeZone || "UTC");
      if (clock.time < (rule.data.timeOfDay || "09:00")) continue;
      await this.db.transaction(async (tx) => {
        await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
          rule.workspace_id,
        ]);
        if (rule.data.trigger === "daily_summary")
          await enqueue(
            tx,
            rule.workspace_id,
            rule.id,
            null,
            rule.created_by,
            "daily_summary",
            `summary:${rule.id}:${clock.day}`,
            now,
          );
        else {
          const tasks = (
            await tx.query<Resource>(
              `SELECT * FROM resources t WHERE workspace_id=$1 AND kind='task' AND deleted_at IS NULL AND coalesce(data->>'status','todo') NOT IN ('done','cancelled') AND coalesce(data->>'archived','false')<>'true' AND left(data->>'dueDate',10)<=$2 AND ($3::text IS NULL OR data->>'projectId'=$3) AND ($5::text IS NULL OR data->'labels' ? $5) AND ($6::text IS NULL OR data->>'status'=$6) AND NOT EXISTS (SELECT 1 FROM automation_runs r WHERE r.workspace_id=t.workspace_id AND r.event_key='overdue:'||$4||':'||t.id::text||':'||left(t.data->>'dueDate',10)) ORDER BY id LIMIT 100`,
              [
                rule.workspace_id,
                clock.day,
                rule.data.projectId || null,
                rule.id,
                rule.data.matchLabel || null,
                rule.data.matchStatus || null,
              ],
            )
          ).rows;
          for (const task of tasks)
            if (validDay(task.data.dueDate) && ruleMatches(rule, task))
              await enqueue(
                tx,
                rule.workspace_id,
                rule.id,
                task.id,
                rule.created_by,
                "task_overdue",
                `overdue:${rule.id}:${task.id}:${task.data.dueDate}`,
                now,
              );
        }
      });
    }
    const candidates = (
      await this.db.query<Run>(
        `SELECT * FROM automation_runs WHERE status='queued' AND next_attempt_at<=$1 AND ($2::uuid IS NULL OR workspace_id=$2) ORDER BY next_attempt_at,created_at,id LIMIT 50`,
        [now.toISOString(), workspaceId || null],
      )
    ).rows;
    for (const candidate of candidates) {
      const updated = await this.db.transaction(async (tx) => {
        // All metadata writers take the workspace lock before resource/run locks.
        await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
          candidate.workspace_id,
        ]);
        const run = (
          await tx.query<Run>(
            "SELECT * FROM automation_runs WHERE id=$1 FOR UPDATE",
            [candidate.id],
          )
        ).rows[0];
        if (!run || run.status !== "queued") return false;
        await tx.query(
          "UPDATE automation_runs SET attempts=attempts+1,cycle_attempts=cycle_attempts+1 WHERE id=$1",
          [run.id],
        );
        await tx.query("SAVEPOINT automation_effect");
        try {
          const outcome = await this.execute(tx, run, now);
          await tx.query(
            "UPDATE automation_runs SET status=$2,result=$3,finished_at=$4 WHERE id=$1",
            [
              run.id,
              outcome.status,
              JSON.stringify(outcome.result),
              now.toISOString(),
            ],
          );
          await tx.query(
            "INSERT INTO automation_attempts(run_id,attempt,status,result,finished_at) VALUES($1,$2,$3,$4,$5)",
            [
              run.id,
              run.attempts + 1,
              outcome.status,
              JSON.stringify(outcome.result),
              now.toISOString(),
            ],
          );
          await tx.query("RELEASE SAVEPOINT automation_effect");
        } catch {
          await tx.query("ROLLBACK TO SAVEPOINT automation_effect");
          const retry = run.cycle_attempts + 1 < 3;
          await tx.query(
            "UPDATE automation_runs SET status=$2,result=$3,next_attempt_at=$4,finished_at=$5 WHERE id=$1",
            [
              run.id,
              retry ? "queued" : "failed",
              JSON.stringify({ reason: "execution_failed" }),
              new Date(
                now.getTime() + 60000 * 2 ** run.cycle_attempts,
              ).toISOString(),
              retry ? null : now.toISOString(),
            ],
          );
          await tx.query(
            "INSERT INTO automation_attempts(run_id,attempt,status,result,finished_at) VALUES($1,$2,'failed',$3,$4)",
            [
              run.id,
              run.attempts + 1,
              JSON.stringify({
                reason: "execution_failed",
                automaticRetry: retry,
              }),
              now.toISOString(),
            ],
          );
        }
        return true;
      });
      if (updated) this.changed(candidate.workspace_id);
    }
  }
  private async execute(tx: Connection, run: Run, now: Date) {
    const all = await list(tx, run.workspace_id),
      task = all.find((r) => r.id === run.target_id),
      rule = all.find((r) => r.id === run.rule_id);
    const member = (
      await tx.query(
        // A suspended author's rules stop acting on their behalf.
        "SELECT m.role FROM memberships m JOIN app_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.user_id=$2 AND u.suspended_at IS NULL FOR UPDATE OF m",
        [run.workspace_id, run.actor_id],
      )
    ).rows[0];
    if (
      !member ||
      ![
        "admin",
        "member",
        ...(run.trigger === "recurrence" ? ["guest"] : []),
      ].includes(member.role)
    )
      return cancelled("permissions_changed");
    const role = member.role as Role;
    if (task && (task.deleted_at || !canRead(task, run.actor_id, role, all)))
      return cancelled("target_unavailable");
    if (run.trigger === "recurrence")
      return this.recur(tx, run, task, all, role, now);
    if (
      !rule ||
      rule.deleted_at ||
      !rule.data.enabled ||
      rule.data.archived ||
      rule.data.trigger !== run.trigger ||
      !canRead(rule, run.actor_id, role, all) ||
      (!rule.data.projectId && role !== "admin")
    )
      return cancelled("rule_unavailable");
    if (run.rule_version !== rule.version) return cancelled("rule_changed");
    if (!validAction(rule.data.action, rule.data.actionValue || ""))
      return cancelled("invalid_rule");
    if (run.trigger !== "daily_summary" && (!task || !ruleMatches(rule, task)))
      return cancelled("conditions_changed");
    if (
      run.trigger === "task_overdue" &&
      (!validDay(task?.data.dueDate) ||
        task.data.dueDate > zonedClock(now, rule.data.timeZone || "UTC").day ||
        ["done", "cancelled"].includes(task.data.status))
    )
      return cancelled("conditions_changed");
    if (run.trigger === "daily_summary" || rule.data.action === "notify") {
      const recipient = rule.data.actionValue;
      const recipientMember = (
        await tx.query(
          "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",
          [run.workspace_id, recipient],
        )
      ).rows[0];
      const project = all.find((r) => r.id === rule.data.projectId);
      if (
        !recipientMember ||
        (task && !canRead(task, recipient, recipientMember.role, all)) ||
        (project && !canRead(project, recipient, recipientMember.role, all))
      )
        return cancelled("recipient_unavailable");
      let description = rule.data.description || task?.title || "";
      if (run.trigger === "daily_summary") {
        if (rule.data.action !== "notify") return cancelled("invalid_rule");
        const tasks = all.filter(
          (r) =>
            ruleMatches(rule, r) &&
            canRead(r, run.actor_id, role, all) &&
            canRead(r, recipient, recipientMember.role, all),
        );
        const today = zonedClock(now, rule.data.timeZone || "UTC").day;
        description = `${tasks.filter((t) => t.data.status === "done").length} completadas · ${tasks.filter((t) => !["done", "cancelled"].includes(t.data.status)).length} pendientes · ${tasks.filter((t) => validDay(t.data.dueDate) && t.data.dueDate < today && !["done", "cancelled"].includes(t.data.status)).length} vencidas.`;
      }
      const id = randomUUID();
      const notification = {
        id,
        workspace_id: run.workspace_id,
        kind: "notification" as const,
        title: rule.title,
        data: {
          assigneeId: recipient,
          read: false,
          description: String(description).slice(0, 5000),
          ...(task ? { targetId: task.id } : {}),
          ...(rule.data.projectId ? { projectId: rule.data.projectId } : {}),
        },
        created_by: run.actor_id,
      };
      const category =
        run.trigger === "daily_summary"
          ? "summary"
          : run.trigger === "task_overdue"
            ? "reminder"
            : "automation";
      const status = await scheduleNotification(
        tx,
        notification,
        category,
        now,
        "automation_notification",
        { id: rule.id, version: rule.version },
      );
      if (status === "ready")
        await this.persist(
          tx,
          notification,
          run.actor_id,
          "automation_notification",
        );
      if (status === "suppressed")
        return {
          status: "succeeded",
          result: { notificationSuppressed: true },
        };
      if (status === "queued")
        return { status: "succeeded", result: { notificationQueued: true } };
      return { status: "succeeded", result: { resourceId: id } };
    }
    if (!task) return cancelled("target_unavailable");
    const data = { ...task.data };
    if (rule.data.action === "assign") {
      const recipient = (
        await tx.query(
          "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",
          [run.workspace_id, rule.data.actionValue],
        )
      ).rows[0];
      if (
        !recipient ||
        !canRead(task, rule.data.actionValue, recipient.role, all)
      )
        return cancelled("recipient_unavailable");
      data.assigneeId = rule.data.actionValue;
    } else data.status = rule.data.actionValue;
    if (JSON.stringify(data) === JSON.stringify(task.data))
      return { status: "succeeded", result: { unchanged: true } };
    const normalized = await this.taskFields(
      tx,
      task,
      data,
      all,
      run.actor_id,
      role,
      false,
    );
    for (const key of Object.keys(data))
      if (!(key in normalized)) delete data[key];
    Object.assign(data, normalized);
    const result = await this.persist(
      tx,
      { ...task, data },
      run.actor_id,
      "automation_updated",
    );
    await notifyChange(tx, result, task, all, run.actor_id);
    if (
      data.status === "done" &&
      task.data.status !== "done" &&
      data.recurrence &&
      data.recurrence !== "none"
    )
      await enqueue(
        tx,
        run.workspace_id,
        null,
        task.id,
        run.actor_id,
        "recurrence",
        `recurrence:${task.id}`,
        now,
      );
    return {
      status: "succeeded",
      result: { resourceId: result.id, version: result.version },
    };
  }
  private async recur(
    tx: Connection,
    run: Run,
    task: Resource | undefined,
    all: Resource[],
    role: Role,
    now: Date,
  ) {
    if (
      !task ||
      task.data.archived ||
      task.data.status !== "done" ||
      !["daily", "weekly", "monthly"].includes(task.data.recurrence) ||
      !validDay(task.data.dueDate)
    )
      return cancelled("conditions_changed");
    const today = zonedClock(now, task.data.timeZone || "UTC").day;
    const due = nextOccurrence(
      task.data.dueDate,
      task.data.recurrence,
      today > task.data.dueDate ? today : task.data.dueDate,
      task.data.recurrenceDay,
    );
    if (task.data.recurrenceEndDate && due > task.data.recurrenceEndDate)
      return { status: "succeeded", result: { seriesEnded: true } };
    // Finished sprint scope, attachments, comments and dependencies are not copied.
    const data: Resource["data"] = {
      ...task.data,
      status: "todo",
      dueDate: due,
      sprintId: null,
      dependencies: [],
      related: [],
      checklist: (task.data.checklist || []).map((entry: any) => ({
        ...entry,
        id: randomUUID(),
        done: false,
      })),
    };
    if (validDay(data.startDate)) {
      const shift = Date.parse(due) - Date.parse(task.data.dueDate);
      data.startDate = new Date(Date.parse(data.startDate) + shift)
        .toISOString()
        .slice(0, 10);
    }
    for (const field of ["parentId", "projectId", "teamId"] as const)
      if (data[field]) {
        const target = all.find((r) => r.id === data[field]);
        if (
          !target ||
          target.deleted_at ||
          !canRead(target, run.actor_id, role, all)
        )
          return cancelled("target_unavailable");
      }
    const recipients = [
      ...new Set(
        [
          data.assigneeId,
          ...(data.reviewers || []),
          ...(data.followers || []),
        ].filter(Boolean),
      ),
    ];
    const members = (
      await tx.query(
        "SELECT user_id,role FROM memberships WHERE workspace_id=$1",
        [run.workspace_id],
      )
    ).rows;
    if (
      recipients.some(
        (id) =>
          !members.some(
            (m) => m.user_id === id && canRead(task, id, m.role, all),
          ),
      )
    )
      return cancelled("recipient_unavailable");
    const nextTask: Resource = {
      ...task,
      id: randomUUID(),
      data,
      created_by: run.actor_id,
      deleted_at: null,
      version: 0,
    };
    nextTask.data = await this.taskFields(
      tx,
      nextTask,
      data,
      all,
      run.actor_id,
      role,
      true,
    );
    const result = await this.persist(
      tx,
      nextTask,
      run.actor_id,
      "recurrence_created",
    );
    await notifyChange(tx, result, undefined, all, run.actor_id);
    return {
      status: "succeeded",
      result: { resourceId: result.id, dueDate: due },
    };
  }
  private async taskFields(
    tx: Connection,
    task: Resource,
    data: Record<string, any>,
    all: Resource[],
    actorId: string,
    role: Role,
    creating: boolean,
  ) {
    const project = all.find(
      (r) => r.id === data.projectId && r.kind === "project",
    );
    try {
      data = normalizeTaskState(data, creating ? undefined : task.data, project);
    } catch {
      // Automations never assign an archived named state; fall back to the category.
      const { stateId: _, ...rest } = data;
      data = rest;
    }
    if (!project?.data.fieldDefinitions?.length && !data.fieldSnapshots?.length)
      return data;
    const actor = (
      await tx.query<User>("SELECT id,email,name FROM app_users WHERE id=$1", [
        actorId,
      ])
    ).rows[0];
    if (!actor)
      throw new HttpError(
        403,
        "La persona que creó la regla ya no está disponible.",
      );
    return validateCustomFieldData(
      tx,
      { ...task, data },
      creating ? undefined : task,
      all,
      actor,
      role,
      { trustedFieldSnapshots: creating },
    );
  }
  private async persist(
    tx: Connection,
    resource: Pick<
      Resource,
      "id" | "workspace_id" | "kind" | "title" | "data" | "created_by"
    >,
    actorId: string,
    action: string,
  ) {
    const result = (
      await tx.query<Resource>(
        `INSERT INTO resources(id,workspace_id,kind,title,data,created_by) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data,version=resources.version+1,updated_at=now() WHERE resources.workspace_id=EXCLUDED.workspace_id AND resources.kind=EXCLUDED.kind RETURNING *`,
        [
          resource.id,
          resource.workspace_id,
          resource.kind,
          resource.title,
          JSON.stringify(resource.data),
          resource.created_by,
        ],
      )
    ).rows[0];
    await tx.query(
      "INSERT INTO resource_versions(resource_id,version,snapshot,user_id) VALUES($1,$2,$3,$4)",
      [result.id, result.version, JSON.stringify(result), actorId],
    );
    await tx.query(
      "INSERT INTO activity(workspace_id,resource_id,user_id,action) VALUES($1,$2,$3,$4)",
      [result.workspace_id, result.id, actorId, action],
    );
    return result;
  }
}

export function registerAutomationRoutes(
  app: FastifyInstance,
  db: Database,
  engine: AutomationEngine,
  userFor: (req: FastifyRequest) => Promise<User>,
  accessible: (
    req: FastifyRequest,
    workspaceId: string,
  ) => Promise<{
    user: User;
    role: Role;
    all: Resource[];
    visible: Resource[];
  }>,
) {
  app.get<{ Params: { workspaceId: string } }>(
    "/api/workspaces/:workspaceId/automations/runs",
    async (req) => {
      const access = await accessible(req, req.params.workspaceId);
      const visible = new Set(
        access.visible.filter((r) => !r.deleted_at).map((r) => r.id),
      );
      const runs = (
        await db.query<Run>(
          "SELECT * FROM automation_runs WHERE workspace_id=$1 AND (rule_id IS NULL OR rule_id=ANY($2::uuid[])) AND (target_id IS NULL OR target_id=ANY($2::uuid[])) ORDER BY created_at DESC,id DESC LIMIT 200",
          [req.params.workspaceId, [...visible]],
        )
      ).rows.map((run) => ({
        ...run,
        result:
          run.result?.resourceId && !visible.has(run.result.resourceId)
            ? { reason: "result_unavailable" }
            : run.result,
        canRetry:
          ["failed", "cancelled"].includes(run.status) &&
          (access.role === "admin" || run.actor_id === access.user.id) &&
          ["admin", "member"].includes(access.role),
      }));
      return {
        runs,
        worker: {
          lastTick: engine.lastTick,
          lastError: engine.lastError,
          intervalSeconds: 15,
        },
      };
    },
  );
  app.get<{
    Params: { workspaceId: string; runId: string };
    Querystring: { before?: string };
  }>(
    "/api/workspaces/:workspaceId/automations/runs/:runId/attempts",
    async (req) => {
      const access = await accessible(req, req.params.workspaceId),
        runId = z.string().uuid().parse(req.params.runId);
      const run = (
        await db.query<Run>(
          "SELECT * FROM automation_runs WHERE id=$1 AND workspace_id=$2",
          [runId, req.params.workspaceId],
        )
      ).rows[0];
      const visible = new Set(
        access.visible.filter((r) => !r.deleted_at).map((r) => r.id),
      );
      if (
        !run ||
        [run.rule_id, run.target_id]
          .filter(Boolean)
          .some((id) => !visible.has(id!))
      )
        throw new HttpError(404, "No se encuentra esta ejecución.");
      const before = req.query.before
        ? z.coerce.number().int().positive().parse(req.query.before)
        : 2147483647;
      const attempts = (
        await db.query(
          "SELECT attempt,status,result,finished_at FROM automation_attempts WHERE run_id=$1 AND attempt<$2 ORDER BY attempt DESC LIMIT 50",
          [runId, before],
        )
      ).rows.map((attempt) => ({
        ...attempt,
        result:
          attempt.result?.resourceId && !visible.has(attempt.result.resourceId)
            ? { reason: "result_unavailable" }
            : attempt.result,
      }));
      return {
        attempts,
        nextBefore:
          attempts.length === 50 ? attempts[attempts.length - 1].attempt : null,
      };
    },
  );
  app.post<{ Params: { workspaceId: string; runId: string } }>(
    "/api/workspaces/:workspaceId/automations/runs/:runId/retry",
    async (req) => {
      const user = await userFor(req),
        workspaceId = z.string().uuid().parse(req.params.workspaceId),
        runId = z.string().uuid().parse(req.params.runId);
      return db.transaction(async (tx) => {
        await tx.query("SELECT id FROM workspaces WHERE id=$1 FOR UPDATE", [
          workspaceId,
        ]);
        const member = (
          await tx.query(
            "SELECT role FROM memberships WHERE workspace_id=$1 AND user_id=$2",
            [workspaceId, user.id],
          )
        ).rows[0];
        const run = (
          await tx.query<Run>(
            "SELECT * FROM automation_runs WHERE id=$1 AND workspace_id=$2 FOR UPDATE",
            [runId, workspaceId],
          )
        ).rows[0];
        const all = await list(tx, workspaceId);
        if (
          !member ||
          !["admin", "member"].includes(member.role) ||
          !run ||
          (member.role !== "admin" && run.actor_id !== user.id) ||
          [run.rule_id, run.target_id].filter(Boolean).some((id) => {
            const target = all.find((r) => r.id === id);
            return (
              !target ||
              target.deleted_at ||
              !canRead(target, user.id, member.role, all)
            );
          })
        )
          throw new HttpError(403, "No puedes reintentar esta ejecución.");
        if (!["failed", "cancelled"].includes(run.status))
          throw new HttpError(
            409,
            "Solo se pueden reintentar ejecuciones fallidas o canceladas.",
          );
        await tx.query(
          "UPDATE automation_runs SET status='queued',cycle_attempts=0,next_attempt_at=now(),finished_at=NULL,result='{}',rule_version=(SELECT version FROM resources WHERE id=automation_runs.rule_id) WHERE id=$1",
          [run.id],
        );
        await tx.query(
          "INSERT INTO activity(workspace_id,resource_id,user_id,action) VALUES($1,$2,$3,'automation_retry')",
          [workspaceId, run.rule_id || run.target_id, user.id],
        );
        return { queued: true };
      });
    },
  );
}
