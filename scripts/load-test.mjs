import { spawn } from 'node:child_process';

const count = Number.parseInt(process.env.LOAD_BUSES || '10', 10);
const durationMs = Number.parseInt(process.env.LOAD_DURATION_MS || '10000', 10);
const backendUrl = process.env.BACKEND_URL || 'http://localhost:3000';
const adminKey = process.env.ADMIN_API_KEY || '';

if (!adminKey) {
  throw new Error('ADMIN_API_KEY es obligatorio');
}

const children = [];
for (let index = 0; index < count; index += 1) {
  const suffix = String(index).padStart(4, '0');
  children.push(spawn(process.execPath, ['scripts/simulate-bus.mjs'], {
    env: {
      ...process.env,
      BACKEND_URL: backendUrl,
      ADMIN_API_KEY: adminKey,
      PHONE: `30000${suffix}`,
      BUS_ID: `LOAD-${suffix}`,
      ROUTE_ID: 'R-101',
      EMPRESA_ID: 'EMP-01',
      CAPTURE_INTERVAL_MS: '10000',
      CAPTURE_BASE_LAG_MS: '60000',
    },
    stdio: 'ignore',
  }));
}

await new Promise((resolve) => setTimeout(resolve, durationMs));
await Promise.all(children.map((child) => new Promise((resolve) => {
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    resolve();
  };
  child.once('exit', finish);
  child.kill('SIGTERM');
  setTimeout(() => {
    child.kill('SIGKILL');
    finish();
  }, 2000);
})));

const response = await fetch(`${backendUrl}/api/metrics`, {
  headers: { 'x-admin-key': adminKey },
});
const metrics = await response.json();
console.log(JSON.stringify({
  buses: count,
  durationMs,
  status: response.status,
  metrics,
}, null, 2));
