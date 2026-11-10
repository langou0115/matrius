import { spawn } from 'node:child_process';
const api = spawn(process.argv[2], process.argv.slice(3), { stdio: 'inherit' });
const agent = spawn(process.execPath, ['--import', '/opt/matrius/node_modules/tsx/dist/loader.mjs', '/opt/matrius/agent/src/server.ts'], {
  cwd: '/opt/matrius/agent', stdio: 'inherit',
  env: { ...process.env, AGENT_HOST: '0.0.0.0', MATRIUS_API_URL: 'http://127.0.0.1:8000' },
});
const closed = [api, agent].map(child => new Promise(resolve => child.once('close', resolve)));
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  api.kill('SIGTERM'); agent.kill('SIGTERM');
  const timer = setTimeout(() => { api.kill('SIGKILL'); agent.kill('SIGKILL'); }, 10000);
  timer.unref();
  Promise.all(closed)
    .then(() => process.exit(code));
}
for (const child of [api, agent]) {
  child.on('error', () => stop(1));
  child.on('exit', code => stop(code ?? 1));
}
process.on('SIGTERM', () => stop(0));
process.on('SIGINT', () => stop(0));
