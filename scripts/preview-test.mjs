// Starts the compiled app for browser checks: raised rate limits, a throwaway encryption key and a
// fresh database each time (a database that keeps growing makes every check slower). The synthetic
// account's saved session goes with it; browser-check sets the account up again first.
// KEEP_DB=1 keeps the previous database and session.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
const dir = '.local/preview-db';
if (!process.env.KEEP_DB) {
  await rm(dir, { recursive: true, force: true });
  await rm(process.env.BROWSER_STATE || '.local/browser-state.json', { force: true });
}
const env = { ...process.env, PGLITE_DIR: dir, TEST_RATE_LIMIT_SCALE: process.env.TEST_RATE_LIMIT_SCALE || '50', ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || randomBytes(32).toString('hex') };
delete env.NODE_ENV;
const child = spawn('npm', ['run', 'preview'], { env, stdio: 'inherit', shell: true });
child.on('exit', (code) => process.exit(code ?? 0));
