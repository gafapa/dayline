// One command before committing: types, unit tests and the build at the same time, then the browser
// checks against a fresh `preview:test` that is stopped at the end.
//   npm run verify                    everything
//   npm run verify -- --quick         core browser flows only
//   npm run verify -- --no-browser    types, unit tests and build
//   npm run verify -- dnd-check …     only these browser checks (other flags pass through)
import { spawn, spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
const browser = !args.includes('--no-browser');
const passThrough = args.filter((a) => a !== '--no-browser');
const base = 'http://127.0.0.1:5173';
const seconds = (since) => `${Math.round((Date.now() - since) / 1000)}s`;

/** Runs a command; its output is kept and shown only when it fails. */
function step(label, command) {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command, { shell: true, env: process.env });
    let output = '';
    child.stdout.on('data', (d) => (output += d));
    child.stderr.on('data', (d) => (output += d));
    child.on('close', (code) => {
      console.info(`${code === 0 ? 'ok  ' : 'FAIL'} ${label} (${seconds(started)})`);
      if (code !== 0) console.error(output.split('\n').slice(-40).join('\n'));
      resolve(code === 0);
    });
  });
}
const healthy = async () => {
  try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; }
};
function stop(child) {
  if (!child || child.exitCode !== null) return;
  // Synchronous: the process exits right after, and the whole tree (npm, vite, server) must go.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else process.kill(-child.pid, 'SIGTERM');
}

const started = Date.now();
const results = await Promise.all([
  step('types', 'npx tsc --noEmit'),
  step('unit tests', 'npx tsx --test tests/*.test.ts'),
  step('build', 'npm run build:app'),
]);
if (results.includes(false)) process.exit(1);
if (!browser) { console.info(`\nAll good in ${seconds(started)}.`); process.exit(0); }

if (await healthy()) {
  console.error('\nSomething is already serving 127.0.0.1:5173. Stop that preview so the checks run against this build.');
  process.exit(1);
}
const preview = spawn(process.execPath, ['scripts/preview-test.mjs'], { stdio: 'ignore', detached: process.platform !== 'win32' });
let code = 1;
try {
  const deadline = Date.now() + 90_000;
  while (!(await healthy())) {
    if (Date.now() > deadline || preview.exitCode !== null) throw new Error('The preview server did not start.');
    await new Promise((r) => setTimeout(r, 500));
  }
  code = await new Promise((resolve) => {
    spawn(process.execPath, ['scripts/verify-browser.mjs', ...passThrough], { stdio: 'inherit' }).on('close', resolve);
  });
} finally {
  stop(preview);
}
console.info(code === 0 ? `\nAll good in ${seconds(started)}.` : `\nBrowser checks failed after ${seconds(started)}.`);
process.exit(code ?? 1);
