// Preload (NODE_OPTIONS=--require): mide el event loop delay del propio proceso backend
const { monitorEventLoopDelay } = require('perf_hooks');
const h = monitorEventLoopDelay({ resolution: 10 });
h.enable();
setInterval(() => {
  console.log(`[EVENTLOOP] p50=${(h.percentile(50) / 1e6).toFixed(2)}ms p95=${(h.percentile(95) / 1e6).toFixed(2)}ms max=${(h.max / 1e6).toFixed(2)}ms`);
  h.reset();
}, 10000);
