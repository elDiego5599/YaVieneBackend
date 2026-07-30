import { BUS_TIMEOUT_MS } from '../config';

export interface BusPosition {
  busId: string;
  routeId: string;
  lat: number;
  lon: number;
  heading: number;
  speedKmh: number;
  timestamp: string;
  driverPhone: string;
  isGhost: boolean;
}

interface DriverInfo {
  name: string;
  routeId: string;
  registeredAt: string;
}

const busPositions = new Map<string, BusPosition>();
const drivers = new Map<string, DriverInfo>();

export function upsertPosition(phoneNumber: string, data: {
  busId: string;
  routeId?: string;
  lat: number;
  lon: number;
  heading?: number;
  speedKmh?: number;
}): BusPosition | null {
  const driver = drivers.get(phoneNumber);
  if (!driver) return null;

  const previous = busPositions.get(data.busId);
  const position: BusPosition = {
    busId: data.busId,
    routeId: data.routeId || driver.routeId,
    lat: data.lat,
    lon: data.lon,
    heading: data.heading ?? previous?.heading ?? 0,
    speedKmh: data.speedKmh ?? previous?.speedKmh ?? 0,
    timestamp: new Date().toISOString(),
    driverPhone: phoneNumber,
    isGhost: false,
  };
  busPositions.set(data.busId, position);
  return position;
}

export function getPositionsByRoute(routeId: string): BusPosition[] {
  const result: BusPosition[] = [];
  for (const bus of busPositions.values()) {
    if (bus.routeId !== routeId) continue;
    result.push({ ...bus });
  }
  return result;
}

export function sweepPositions(ghostMs: number, removeMs: number): {
  toGhost: BusPosition[];
  toRemove: { busId: string; routeId: string }[];
} {
  const now = Date.now();
  const toGhost: BusPosition[] = [];
  const toRemove: { busId: string; routeId: string }[] = [];

  for (const [busId, pos] of busPositions) {
    const elapsed = now - new Date(pos.timestamp).getTime();

    if (elapsed > removeMs) {
      busPositions.delete(busId);
      toRemove.push({ busId: pos.busId, routeId: pos.routeId });
    } else if (elapsed > ghostMs && !pos.isGhost) {
      pos.isGhost = true;
      toGhost.push({ ...pos });
    }
  }

  return { toGhost, toRemove };
}

export function removePosition(busId: string): BusPosition | undefined {
  const pos = busPositions.get(busId);
  if (pos) busPositions.delete(busId);
  return pos;
}

export function getPosition(busId: string): BusPosition | null {
  return busPositions.get(busId) ?? null;
}

export function getAllPositions(): BusPosition[] {
  return Array.from(busPositions.values());
}

export function registerDriver(phoneNumber: string, name: string, routeId: string): DriverInfo {
  const driver: DriverInfo = { name, routeId, registeredAt: new Date().toISOString() };
  drivers.set(phoneNumber, driver);
  return driver;
}

export function getDriver(phoneNumber: string): DriverInfo | null {
  return drivers.get(phoneNumber) ?? null;
}
