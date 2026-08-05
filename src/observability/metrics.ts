const counters = new Map<string, number>();
const gauges = new Map<string, number>();

export function incrementMetric(name: string, amount = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + amount);
}

export function setMetric(name: string, value: number): void {
  gauges.set(name, value);
}

export function getMetrics(): Record<string, Record<string, number>> {
  return {
    counters: Object.fromEntries(counters.entries()),
    gauges: Object.fromEntries(gauges.entries()),
  };
}
