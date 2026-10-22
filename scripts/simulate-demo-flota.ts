import { arrancarFlotaDemo, detenerFlotaDemo } from '../src/demo/flota_demo';

arrancarFlotaDemo();

for (const señal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(señal, () => {
    detenerFlotaDemo();
    process.exit(0);
  });
}
