import pg from "pg";
import { DOCUMENT_SCHEMA_VERSION } from "../shared/document-protocol.js";
import { mkdir } from "node:fs/promises";

export interface Connection {
  query<T = any>(sql: string, parameters?: any[]): Promise<{ rows: T[] }>;
}
export interface Database extends Connection {
  transaction<T>(run: (connection: Connection) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function createDatabase(
  url = process.env.DATABASE_URL,
  path = ".local/database",
): Promise<Database> {
  if (url) {
    const pool = new pg.Pool({
      connectionString: url,
      max: 8,
      idleTimeoutMillis: 30000,
      statement_timeout: 15000,
    });
    return {
      query: async <T>(sql: string, p?: any[]) => ({
        rows: (await pool.query(sql, p)).rows as T[],
      }),
      transaction: async (run) => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          const value = await run(client);
          await client.query("COMMIT");
          return value;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }
  if (process.env.NODE_ENV === "production")
    throw new Error("DATABASE_URL is required in production");
  const { PGlite } = await import("@electric-sql/pglite");
  if (path !== "memory://") await mkdir(path, { recursive: true });
  const database = new PGlite(path);
  await database.waitReady;
  let queue = Promise.resolve();
  const exclusive = <T>(run: () => Promise<T>): Promise<T> => {
    const result = queue.then(run, run);
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  };
  return {
    query: (sql, p) => exclusive(() => database.query(sql, p)),
    transaction: (run) =>
      exclusive(() =>
        database.transaction((tx) =>
          run({ query: (sql, p) => tx.query(sql, p) }),
        ),
      ),
    close: () => exclusive(() => database.close()),
  };
}

export async function migrate(db: Database) {
  await db.transaction(async (tx) => {
    await tx.query(
      "CREATE TABLE IF NOT EXISTS document_format (id integer PRIMARY KEY CHECK(id=1),version integer NOT NULL)",
    );
    await tx.query(
      "INSERT INTO document_format(id,version) VALUES(1,1) ON CONFLICT(id) DO NOTHING",
    );
    const format = (
      await tx.query(
        "SELECT version FROM document_format WHERE id=1 FOR UPDATE",
      )
    ).rows[0];
    if (format.version !== DOCUMENT_SCHEMA_VERSION)
      throw new Error(
        "Document schema migration required; existing data was preserved.",
      );
    await tx.query(`CREATE TABLE IF NOT EXISTS app_users (
      id uuid PRIMARY KEY, email text UNIQUE NOT NULL, name text NOT NULL,
      password_hash text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS workspaces (id uuid PRIMARY KEY, name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now())`,
    );
    await tx.query(`CREATE TABLE IF NOT EXISTS memberships (
      workspace_id uuid REFERENCES workspaces(id), user_id uuid REFERENCES app_users(id),
      role text NOT NULL CHECK (role IN ('admin','member','viewer','guest')), PRIMARY KEY(workspace_id,user_id)
    )`);
    await tx.query(`CREATE TABLE IF NOT EXISTS sessions (
      token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_users(id),
      created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, user_agent text NOT NULL DEFAULT ''
    )`);
    await tx.query(`CREATE TABLE IF NOT EXISTS resources (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id), kind text NOT NULL, title text NOT NULL,
      data jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1,
      created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
    )`);
    await tx.query(
      `CREATE INDEX IF NOT EXISTS resources_workspace_kind ON resources(workspace_id,kind,updated_at)`,
    );
    await tx.query(
      `CREATE INDEX IF NOT EXISTS resources_project ON resources(workspace_id,(data->>'projectId'))`,
    );
    await tx.query(
      `CREATE INDEX IF NOT EXISTS resources_search ON resources USING gin(to_tsvector('simple', title || ' ' || coalesce(data->>'description','')))`,
    );
    await tx.query(`CREATE TABLE IF NOT EXISTS resource_versions (
      resource_id uuid REFERENCES resources(id), version integer NOT NULL, snapshot jsonb NOT NULL,
      user_id uuid REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(resource_id,version)
    )`);
    await tx.query(`CREATE TABLE IF NOT EXISTS operations (
      id uuid PRIMARY KEY, workspace_id uuid REFERENCES workspaces(id), user_id uuid REFERENCES app_users(id),
      response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await tx.query(`CREATE TABLE IF NOT EXISTS activity (
      sequence bigserial PRIMARY KEY, workspace_id uuid REFERENCES workspaces(id), resource_id uuid REFERENCES resources(id),
      user_id uuid REFERENCES app_users(id), action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await tx.query(`CREATE TABLE IF NOT EXISTS invitations (
      id uuid PRIMARY KEY, workspace_id uuid REFERENCES workspaces(id), email text NOT NULL, role text NOT NULL,
      token_hash text UNIQUE NOT NULL, created_by uuid REFERENCES app_users(id), expires_at timestamptz NOT NULL, accepted_at timestamptz
    )`);
    await tx.query(`CREATE TABLE IF NOT EXISTS document_states (
      resource_id uuid PRIMARY KEY REFERENCES resources(id), state bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
    )`);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS workspace_settings (workspace_id uuid PRIMARY KEY REFERENCES workspaces(id), data jsonb NOT NULL DEFAULT '{}')`,
    );
    await tx.query(
      `CREATE TABLE IF NOT EXISTS user_preferences (user_id uuid PRIMARY KEY REFERENCES app_users(id), data jsonb NOT NULL DEFAULT '{}')`,
    );
    await tx.query(`CREATE TABLE IF NOT EXISTS notification_queue (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id),
      recipient_id uuid NOT NULL REFERENCES app_users(id), category text NOT NULL,
      deliver_at timestamptz NOT NULL, payload jsonb NOT NULL, action text,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
    await tx.query(
      "CREATE INDEX IF NOT EXISTS notification_queue_due ON notification_queue(deliver_at,id)",
    );
    await tx.query(
      "CREATE INDEX IF NOT EXISTS notification_queue_recipient ON notification_queue(recipient_id)",
    );
    await tx.query(`CREATE TABLE IF NOT EXISTS reminder_deliveries (
      reminder_id uuid NOT NULL REFERENCES resources(id), revision_id uuid NOT NULL,
      status text NOT NULL, notification_id uuid, processed_at timestamptz NOT NULL,
      PRIMARY KEY(reminder_id,revision_id)
    )`);
    const reminderPrimary = (
      await tx.query(
        "SELECT conname,array_length(conkey,1) AS columns FROM pg_constraint WHERE conrelid='reminder_deliveries'::regclass AND contype='p'",
      )
    ).rows[0];
    if (reminderPrimary?.columns === 1) {
      const constraint =
        '"' + String(reminderPrimary.conname).replace(/"/g, '""') + '"';
      await tx.query(
        `ALTER TABLE reminder_deliveries DROP CONSTRAINT ${constraint}, ADD PRIMARY KEY(reminder_id,revision_id)`,
      );
    }
    await tx.query(
      "CREATE INDEX IF NOT EXISTS reminders_due ON resources((data->'reminder'->>'at'),id) WHERE kind='reminder' AND deleted_at IS NULL AND data->'reminder'->>'enabled'='true'",
    );
    await tx.query(
      "ALTER TABLE app_users ADD COLUMN IF NOT EXISTS mfa_secret text",
    );
    await tx.query(
      "ALTER TABLE app_users ADD COLUMN IF NOT EXISTS mfa_pending_secret text",
    );
    await tx.query(
      "ALTER TABLE app_users ADD COLUMN IF NOT EXISTS mfa_pending_expires_at timestamptz",
    );
    await tx.query(
      "ALTER TABLE app_users ADD COLUMN IF NOT EXISTS mfa_last_counter bigint NOT NULL DEFAULT 0",
    );
    await tx.query(
      "ALTER TABLE app_users ADD COLUMN IF NOT EXISTS recovery_hashes jsonb NOT NULL DEFAULT '[]'",
    );
    // Platform administration (0.19): platform role, suspension, last login, reset links and audit.
    await tx.query(
      "ALTER TABLE app_users ADD COLUMN IF NOT EXISTS platform_admin boolean NOT NULL DEFAULT false",
    );
    await tx.query(
      "ALTER TABLE app_users ADD COLUMN IF NOT EXISTS suspended_at timestamptz",
    );
    await tx.query(
      "ALTER TABLE app_users ADD COLUMN IF NOT EXISTS last_login_at timestamptz",
    );
    await tx.query(
      `CREATE TABLE IF NOT EXISTS password_resets (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_users(id), created_by uuid NOT NULL REFERENCES app_users(id), created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL, used_at timestamptz)`,
    );
    await tx.query(
      `CREATE TABLE IF NOT EXISTS platform_audit (id bigserial PRIMARY KEY, actor_id uuid NOT NULL REFERENCES app_users(id), target_id uuid REFERENCES app_users(id), action text NOT NULL, details jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now())`,
    );
    // The first account becomes the platform administrator when none exists yet.
    await tx.query(
      `UPDATE app_users SET platform_admin=true WHERE id=(SELECT id FROM app_users ORDER BY created_at, id LIMIT 1) AND NOT EXISTS (SELECT 1 FROM app_users WHERE platform_admin)`,
    );
    await tx.query(
      `CREATE TABLE IF NOT EXISTS document_revisions (id bigserial PRIMARY KEY,resource_id uuid NOT NULL REFERENCES resources(id),content jsonb NOT NULL,user_id uuid REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now())`,
    );
    await tx.query(
      "CREATE INDEX IF NOT EXISTS document_revisions_resource ON document_revisions(resource_id,id DESC)",
    );
    await tx.query(
      `CREATE TABLE IF NOT EXISTS attachments(id uuid PRIMARY KEY,workspace_id uuid NOT NULL REFERENCES workspaces(id),target_id uuid NOT NULL REFERENCES resources(id),name text NOT NULL,mime text NOT NULL,size integer NOT NULL,body bytea NOT NULL,created_by uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),deleted_at timestamptz)`,
    );
    await tx.query(
      "CREATE INDEX IF NOT EXISTS attachments_target ON attachments(target_id)",
    );
    await tx.query(`CREATE TABLE IF NOT EXISTS automation_runs (
      id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES workspaces(id),
      rule_id uuid REFERENCES resources(id), target_id uuid REFERENCES resources(id), actor_id uuid NOT NULL REFERENCES app_users(id),
      event_key text NOT NULL, trigger text NOT NULL, status text NOT NULL DEFAULT 'queued',
      attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
      result jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
      UNIQUE(workspace_id,event_key)
    )`);
    await tx.query(
      "CREATE INDEX IF NOT EXISTS automation_runs_queue ON automation_runs(status,next_attempt_at,created_at)",
    );
    await tx.query(
      "CREATE INDEX IF NOT EXISTS automation_runs_workspace ON automation_runs(workspace_id,created_at DESC)",
    );
    await tx.query(
      "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS rule_version integer",
    );
    await tx.query(
      "ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS cycle_attempts integer NOT NULL DEFAULT 0",
    );
    await tx.query(`CREATE TABLE IF NOT EXISTS automation_attempts (
      run_id uuid NOT NULL REFERENCES automation_runs(id), attempt integer NOT NULL,
      status text NOT NULL, result jsonb NOT NULL, finished_at timestamptz NOT NULL,
      PRIMARY KEY(run_id,attempt)
    )`);
    await tx.query(
      `CREATE TABLE IF NOT EXISTS sprint_baselines(sprint_id uuid PRIMARY KEY REFERENCES resources(id),started_at timestamptz NOT NULL DEFAULT now(),tasks jsonb NOT NULL,capacity_plan jsonb NOT NULL DEFAULT '[]')`,
    );
    await tx.query(
      `CREATE TABLE IF NOT EXISTS sprint_ceremonies(sprint_id uuid PRIMARY KEY REFERENCES resources(id),version integer NOT NULL,data jsonb NOT NULL,updated_by uuid NOT NULL REFERENCES app_users(id),updated_at timestamptz NOT NULL DEFAULT now())`,
    );
    await tx.query(
      `CREATE TABLE IF NOT EXISTS sprint_ceremony_versions(sprint_id uuid NOT NULL REFERENCES resources(id),version integer NOT NULL,data jsonb NOT NULL,user_id uuid NOT NULL REFERENCES app_users(id),created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(sprint_id,version))`,
    );
    await tx.query(
      `CREATE TABLE IF NOT EXISTS poker_rounds(id uuid PRIMARY KEY,sprint_id uuid NOT NULL REFERENCES resources(id),task_id uuid NOT NULL REFERENCES resources(id),facilitator_id uuid NOT NULL REFERENCES app_users(id),status text NOT NULL DEFAULT 'voting',version integer NOT NULL DEFAULT 1,task_version integer NOT NULL,applied_estimate numeric,created_at timestamptz NOT NULL DEFAULT now(),revealed_at timestamptz,applied_at timestamptz)`,
    );
    await tx.query(
      "CREATE UNIQUE INDEX IF NOT EXISTS poker_one_open_round ON poker_rounds(sprint_id) WHERE status IN ('voting','revealed')",
    );
    await tx.query(
      `CREATE TABLE IF NOT EXISTS poker_votes(round_id uuid NOT NULL REFERENCES poker_rounds(id),user_id uuid NOT NULL REFERENCES app_users(id),value text NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(round_id,user_id))`,
    );
    await tx.query(
      "CREATE INDEX IF NOT EXISTS resource_versions_sprint ON resource_versions((snapshot->'data'->>'sprintId'))",
    );
    await tx.query(
      "ALTER TABLE poker_rounds ADD COLUMN IF NOT EXISTS task_scope jsonb NOT NULL DEFAULT '{}'",
    );
    await tx.query(
      "ALTER TABLE attachments ADD COLUMN IF NOT EXISTS template_node_key text",
    );
  });
}
