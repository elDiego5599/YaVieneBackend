const { GHOST_TIMEOUT_MS } = require('../config');

const busPositions = new Map();
const drivers = new Map();

function upsertPosition(phoneNumber, data) {
  const driver = drivers.get(phoneNumber);
  if (!driver) return null;

  const previous = busPositions.get(data.busId);
  busPositions.set(data.busId, {
    busId: data.busId,
    routeId: data.routeId || driver.routeId,
    lat: data.lat,
    lon: data.lon,
    heading: data.heading ?? previous?.heading ?? 0,
    speedKmh: data.speedKmh ?? previous?.speedKmh ?? 0,
    timestamp: new Date().toISOString(),
    driverPhone: phoneNumber,
    isGhost: false,
  });
  return busPositions.get(data.busId);
}

function getPositionsByRoute(routeId) {
  const now = Date.now();
  const result = [];
  for (const bus of busPositions.values()) {
    if (bus.routeId !== routeId) continue;
    const elapsed = now - new Date(bus.timestamp).getTime();
    if (elapsed < GHOST_TIMEOUT_MS) {
      result.push({ ...bus });
    }
  }
  return result;
}

function getPosition(busId) {
  return busPositions.get(busId) ?? null;
}

function getAllPositions() {
  return Array.from(busPositions.values());
}

function registerDriver(phoneNumber, name, routeId) {
  drivers.set(phoneNumber, { name, routeId, registeredAt: new Date().toISOString() });
  return drivers.get(phoneNumber);
}

function getDriver(phoneNumber) {
  return drivers.get(phoneNumber) ?? null;
}

module.exports = {
  upsertPosition,
  getPositionsByRoute,
  getPosition,
  getAllPositions,
  registerDriver,
  getDriver,
};
