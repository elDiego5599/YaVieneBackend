"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.upsertPosition = upsertPosition;
exports.getPositionsByRoute = getPositionsByRoute;
exports.getPosition = getPosition;
exports.getAllPositions = getAllPositions;
exports.registerDriver = registerDriver;
exports.getDriver = getDriver;
const config_1 = require("../config");
const busPositions = new Map();
const drivers = new Map();
function upsertPosition(phoneNumber, data) {
    const driver = drivers.get(phoneNumber);
    if (!driver)
        return null;
    const previous = busPositions.get(data.busId);
    const position = {
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
function getPositionsByRoute(routeId) {
    const now = Date.now();
    const result = [];
    for (const bus of busPositions.values()) {
        if (bus.routeId !== routeId)
            continue;
        const elapsed = now - new Date(bus.timestamp).getTime();
        if (elapsed < config_1.GHOST_TIMEOUT_MS) {
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
    const driver = { name, routeId, registeredAt: new Date().toISOString() };
    drivers.set(phoneNumber, driver);
    return driver;
}
function getDriver(phoneNumber) {
    return drivers.get(phoneNumber) ?? null;
}
//# sourceMappingURL=buses.js.map