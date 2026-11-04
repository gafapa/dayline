// Starts the compiled app for browser checks: raised rate limits and a throwaway encryption key.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
const env = { ...process.env, TEST_RATE_LIMIT_SCALE: process.env.TEST_RATE_LIMIT_SCALE || '50', ENCRYPTION_KEY: process.env.ENCRYPTION_KEY || randomBytes(32).toString('hex') };
delete env.NODE_ENV;
const child = spawn('npm', ['run', 'preview'], { env, stdio: 'inherit', shell: true });
child.on('exit', (code) => process.exit(code ?? 0));
