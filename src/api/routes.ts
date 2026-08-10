import { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { spawn } from 'child_process';
import { join } from 'path';
import {
  getDriver,
  endAssignment,
  getPosition,
  getPositionsByRoute,
  registerDriver,
  removePositionOwned,
  toPublicPosition,
  getFleetPositions,
  getBusCompanyId,
  setBusVisibility,
  setAllBusVisibility,
  createBus,
  updateBus,
  deleteBus,
  getCompanyRoutes,
  addCompanyRoute,
  renameCompanyRoute,
  removeCompanyRoute,
  deleteAllBuses,
  routeNameExists,
  getCompanyBuses,
} from '../data/buses';
import { getEmpresas } from '../data/empresas';
import { authenticateRequest, isAdminRequest, isDriverForBus, authenticateCompanyAdmin } from '../auth/http';
import { hashPin, verifyPin, hashSecret, verifySecret } from '../auth/passwords';
import { signToken } from '../auth/tokens';
import { createDriverSession, revokeSession, revokeSessionsForDriver } from '../data/sessions';
import { getMetrics } from '../observability/metrics';
import { adminRateLimiter, loginRateLimiter, requestKey } from '../security/rate_limiter';
import { getDb } from '../data/database';
import { isBrokerReady } from '../mqtt/broker';
import {
  getEmpresa,
  ensureEmpresa,
  createOrUpdateCompanyAdmin,
  getCompanyAdminByUsername,
} from '../data/empresas';

interface RouteHandler {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: (req: IncomingMessage, res: ServerResponse, params: Record<string, string>, body?: Record<string, unknown>) => void;
}

const handlers: RouteHandler[] = [];
const MAX_BODY_BYTES = 32 * 1024;

function writeJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function writeError(res: ServerResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { error: { code, message } });
}

function publicDriver(driver: NonNullable<ReturnType<typeof getDriver>>): Record<string, unknown> {
  return {
    driverId: driver.driverId,
    phoneNumber: driver.phoneNumber,
    name: driver.name,
    companyId: driver.companyId,
    busId: driver.busId,
    routeId: driver.routeId,
    registeredAt: driver.registeredAt,
  };
}

function addRoute(method: string, path: string, handler: RouteHandler['handler']): void {
  const paramNames: string[] = [];
  const patternStr = path.replace(/:(\w+)/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  handlers.push({
    method,
    pattern: new RegExp(`^${patternStr}$`),
    paramNames,
    handler,
  });
}

addRoute('GET', '/api/health', (_req, res) => {
  writeJson(res, 200, { status: 'ok', uptime: process.uptime() });
});

addRoute('GET', '/api/metrics', (req, res) => {
  if (!isAdminRequest(req)) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Administrator authentication is required');
    return;
  }
  writeJson(res, 200, getMetrics());
});

addRoute('GET', '/api/ready', (_req, res) => {
  try {
    getDb().prepare('SELECT 1').get();
    if (!isBrokerReady()) {
      writeError(res, 503, 'BROKER_NOT_READY', 'MQTT broker is not ready');
      return;
    }
    writeJson(res, 200, { status: 'ready' });
  } catch {
    writeError(res, 503, 'DATABASE_NOT_READY', 'Database is not ready');
  }
});

addRoute('GET', '/api/companies', (_req, res) => {
  const companies = getEmpresas().map((company) => ({
    id: company.companyId,
    name: company.name,
  }));
  writeJson(res, 200, companies);
});

addRoute('GET', '/api/companies/:id/routes', (_req, res, params) => {
  const routes = getCompanyRoutes(params.id).map((route) => ({
    id: route.routeId,
    name: route.name,
    companyId: params.id,
    terminalA: route.terminalA,
    terminalB: route.terminalB,
    total: route.total,
    online: route.online,
  }));
  writeJson(res, 200, routes);
});

addRoute('GET', '/api/companies/:id/buses', (_req, res, params) => {
  writeJson(res, 200, getCompanyBuses(params.id));
});

addRoute('GET', '/api/routes/:routeId/positions', (_req, res, params) => {
  const positions = getPositionsByRoute(params.routeId).map(toPublicPosition);
  writeJson(res, 200, { routeId: params.routeId, buses: positions });
});

addRoute('GET', '/api/buses/:busId', (_req, res, params) => {
  const bus = getPosition(params.busId);
  if (!bus) {
    writeError(res, 404, 'BUS_NOT_FOUND', 'Bus not found');
    return;
  }
  writeJson(res, 200, toPublicPosition(bus));
});

addRoute('POST', '/api/buses/:busId/offline', (req, res, params) => {
  const auth = authenticateRequest(req);
  if (auth?.role !== 'driver' || !isDriverForBus(auth, params.busId)) {
    writeError(res, 403, 'BUS_FORBIDDEN', 'The token cannot control this bus');
    return;
  }

  const bus = getPosition(params.busId);
  if (!bus) {
    writeError(res, 404, 'BUS_NOT_FOUND', 'Bus not found');
    return;
  }
  removePositionOwned(params.busId, auth.sessionId);
  revokeSession(auth.sessionId);
  endAssignment(auth.driverId, params.busId);
  console.log(`[API] Bus ${params.busId} marcado offline por el conductor`);
  writeJson(res, 200, { status: 'offline', busId: params.busId });
});

addRoute('GET', '/api/drivers/:phone', (req, res, params) => {
  const driver = getDriver(params.phone);
  if (!driver) {
    writeError(res, 404, 'DRIVER_NOT_FOUND', 'Driver not found');
    return;
  }

  const auth = authenticateRequest(req);
  if (auth?.role !== 'driver' || (!isAdminRequest(req) && auth.driverId !== driver.driverId)) {
    writeError(res, 403, 'DRIVER_FORBIDDEN', 'The token cannot read this driver');
    return;
  }
  writeJson(res, 200, publicDriver(driver));
});

addRoute('POST', '/api/gps', (_req, res) => {
  writeError(res, 410, 'HTTP_GPS_DISABLED', 'GPS ingestion is available through authenticated MQTT only');
});

function provisionDriver(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  body?: Record<string, unknown>,
): void {
  if (!isAdminRequest(req)) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Administrator authentication is required');
    return;
  }
  if (!adminRateLimiter.allow(requestKey(req, 'provision'))) {
    writeError(res, 429, 'RATE_LIMITED', 'Too many provisioning attempts');
    return;
  }

  const phoneNumber = typeof body?.phoneNumber === 'string' ? body.phoneNumber : '';
  const name = typeof body?.name === 'string' ? body.name : phoneNumber;
  const routeId = typeof body?.routeId === 'string' ? body.routeId : '';
  const busId = typeof body?.busId === 'string' ? body.busId : '';
  const companyId = typeof body?.companyId === 'string'
    ? body.companyId
    : typeof body?.empresaId === 'string' ? body.empresaId : '';
  const pin = typeof body?.pin === 'string' ? body.pin : '';

  if (!phoneNumber || !name || !routeId || !busId || !companyId || !/^\d{4,8}$/.test(pin)) {
    writeError(res, 400, 'INVALID_DRIVER_PROVISION', 'phoneNumber, name, routeId, busId, companyId and a numeric pin are required');
    return;
  }

  const driver = registerDriver(phoneNumber, name, routeId, {
    driverId: getDriver(phoneNumber)?.driverId ?? randomUUID(),
    companyId,
    busId,
    pinHash: hashPin(pin),
  });
  revokeSessionsForDriver(driver.driverId);

  writeJson(res, 201, {
    status: 'provisioned',
    driver: publicDriver(driver),
  });
}

addRoute('POST', '/api/admin/drivers', provisionDriver);
addRoute('POST', '/api/drivers/register', provisionDriver);

addRoute('POST', '/api/auth/login', (req, res, _params, body) => {
  const phoneNumber = typeof body?.phoneNumber === 'string' ? body.phoneNumber : '';
  const pin = typeof body?.pin === 'string' ? body.pin : '';
  const requestedBusId = typeof body?.busId === 'string' ? body.busId : null;
  const requestedRouteId = typeof body?.routeId === 'string' ? body.routeId : null;

  if (!loginRateLimiter.allow(requestKey(req, `login:${phoneNumber || 'unknown'}`))) {
    writeError(res, 429, 'RATE_LIMITED', 'Too many login attempts');
    return;
  }

  if (!phoneNumber || !pin) {
    writeError(res, 400, 'CREDENTIALS_REQUIRED', 'phoneNumber and pin are required');
    return;
  }

  const driver = getDriver(phoneNumber);
  if (!driver || !verifyPin(pin, driver.pinHash) || !driver.companyId || !driver.busId) {
    writeError(res, 401, 'INVALID_CREDENTIALS', 'Invalid driver credentials');
    return;
  }

  if (requestedBusId && requestedBusId !== driver.busId) {
    writeError(res, 403, 'BUS_FORBIDDEN', 'The driver is not assigned to this bus');
    return;
  }
  if (requestedRouteId && requestedRouteId !== driver.routeId) {
    writeError(res, 403, 'ROUTE_FORBIDDEN', 'The driver is not assigned to this route');
    return;
  }

  const sessionId = randomUUID();
  const token = signToken({
    sub: driver.driverId,
    driverId: driver.driverId,
    phoneNumber: String(phoneNumber),
    role: 'driver',
    companyId: driver.companyId,
    busId: driver.busId,
    routeId: driver.routeId,
    sessionId,
  });

  createDriverSession({
    sessionId,
    driverId: driver.driverId,
    phoneNumber: driver.phoneNumber,
    companyId: driver.companyId,
    busId: driver.busId,
    routeId: driver.routeId,
  });

  writeJson(res, 200, {
    driver: publicDriver(driver),
    token,
  });
});

const DEMO_MODE = process.env.DEMO_MODE === '1';

addRoute('POST', '/api/demo/session', (req, res, _params, body) => {
  if (!DEMO_MODE) {
    writeError(res, 404, 'NOT_FOUND', 'Endpoint not found');
    return;
  }
  if (!adminRateLimiter.allow(requestKey(req, 'demo-session'))) {
    writeError(res, 429, 'RATE_LIMITED', 'Too many demo session requests');
    return;
  }

  const companyId = typeof body?.companyId === 'string' ? body.companyId : '';
  const busId = typeof body?.busId === 'string' ? body.busId : '';
  const routeId = typeof body?.routeId === 'string' ? body.routeId : '';

  if (!companyId || !busId || !routeId) {
    writeError(res, 400, 'INVALID_DEMO_SESSION', 'companyId, busId and routeId are required');
    return;
  }

  const busCompany = getBusCompanyId(busId);
  if (!busCompany || busCompany !== companyId) {
    writeError(res, 403, 'BUS_FORBIDDEN', 'The bus does not belong to this company');
    return;
  }
  const route = getCompanyRoutes(companyId).find((r) => r.routeId === routeId);
  if (!route) {
    writeError(res, 404, 'ROUTE_NOT_FOUND', 'The route does not belong to this company');
    return;
  }

  const phoneNumber = `demo:${busId}`;
  const driver = registerDriver(phoneNumber, 'Demo Sobusa', routeId, {
    companyId,
    busId,
    pinHash: hashPin('1234'),
  });
  revokeSessionsForDriver(driver.driverId);

  const sessionId = randomUUID();
  const token = signToken({
    sub: driver.driverId,
    driverId: driver.driverId,
    phoneNumber,
    role: 'driver',
    companyId,
    busId,
    routeId,
    sessionId,
  });

  createDriverSession({
    sessionId,
    driverId: driver.driverId,
    phoneNumber,
    companyId,
    busId,
    routeId,
  });

  writeJson(res, 200, {
    driver: publicDriver(driver),
    token,
  });
});

// ── Demo: buses simulados bajo demanda ──────────────────────────────
// Cuando el pasajero entra a "Ver buses en vivo", el backend lanza 2
// simuladores de la ruta elegida: uno que ya pasó (80%) y uno que viene
// (15%). Cada llamada mata los anteriores y los relanza desde el inicio.
const DEMO_SIMS = new Set<ReturnType<typeof spawn>>();
let DEMO_SIM_PHONE = 3_000_000_000;

function spawnDemoSim(busId: string, fraction: string, routeId: string, companyId: string): void {
  const phone = `${DEMO_SIM_PHONE++}`;
  const child = spawn('node', ['scripts/simulate-bus.mjs'], {
    cwd: join(__dirname, '..', '..'),
    env: {
      ...process.env,
      BUS_ID: busId,
      ROUTE_ID: routeId,
      EMPRESA_ID: companyId,
      PHONE: phone,
      PIN: '1234',
      START_FRACTION: fraction,
      SENTIDO: 'ida',
      CAPTURE_INTERVAL_MS: '400',
    },
    stdio: 'ignore',
  });
  child.on('exit', () => DEMO_SIMS.delete(child));
  DEMO_SIMS.add(child);
}

addRoute('POST', '/api/demo/buses', (req, res, _params, body) => {
  if (!DEMO_MODE) {
    writeError(res, 404, 'NOT_FOUND', 'Endpoint not found');
    return;
  }
  if (!adminRateLimiter.allow(requestKey(req, 'demo-buses'))) {
    writeError(res, 429, 'RATE_LIMITED', 'Too many demo bus requests');
    return;
  }

  const companyId = typeof body?.companyId === 'string' ? body.companyId : '';
  const routeId = typeof body?.routeId === 'string' ? body.routeId : '';
  if (!companyId || !routeId) {
    writeError(res, 400, 'INVALID_DEMO_BUSES', 'companyId and routeId are required');
    return;
  }
  if (!getCompanyRoutes(companyId).some((r) => r.routeId === routeId)) {
    writeError(res, 404, 'ROUTE_NOT_FOUND', 'The route does not belong to this company');
    return;
  }

  for (const child of DEMO_SIMS) {
    try {
      child.kill('SIGTERM');
    } catch {
      /* proceso ya terminado */
    }
  }
  DEMO_SIMS.clear();

  spawnDemoSim('B-042', '0.80', routeId, companyId);
  spawnDemoSim('B-055', '0.15', routeId, companyId);

  // Los buses demo deben difundirse al pasajero: el registro del simulador
  // crea el bus con visible=false; se marca visible apenas exista.
  for (const busId of ['B-042', 'B-055']) {
    let attempts = 0;
    const timer = setInterval(() => {
      attempts++;
      if (setBusVisibility(busId, true)) {
        clearInterval(timer);
      } else if (attempts >= 20) {
        clearInterval(timer);
        console.warn(`[DEMO] No se pudo marcar ${busId} como visible`);
      }
    }, 500);
  }

  writeJson(res, 200, { started: true, routeId, buses: ['B-042', 'B-055'] });
});

addRoute('POST', '/api/admin/login', (req, res, _params, body) => {
  const username = typeof body?.username === 'string'
    ? body.username.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (!loginRateLimiter.allow(requestKey(req, `adminlogin:${username || 'unknown'}`))) {
    writeError(res, 429, 'RATE_LIMITED', 'Too many login attempts');
    return;
  }

  if (!username || !password) {
    writeError(res, 400, 'CREDENTIALS_REQUIRED', 'username and password are required');
    return;
  }

  const admin = getCompanyAdminByUsername(username);
  if (!admin || !verifySecret(password, admin.passwordHash)) {
    writeError(res, 401, 'INVALID_CREDENTIALS', 'Invalid admin credentials');
    return;
  }

  const token = signToken({
    sub: admin.adminId,
    role: 'admin',
    companyId: admin.companyId,
    username: admin.username,
  });

  writeJson(res, 200, {
    token,
    company: {
      companyId: admin.companyId,
      name: getEmpresa(admin.companyId)?.name ?? admin.companyId,
    },
  });
});

addRoute('POST', '/api/admin/empresas/:companyId/admin', (req, res, params, body) => {
  if (!isAdminRequest(req)) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Administrator authentication is required');
    return;
  }
  if (!adminRateLimiter.allow(requestKey(req, `companyadmin:${params.companyId}`))) {
    writeError(res, 429, 'RATE_LIMITED', 'Too many attempts');
    return;
  }

  const username = typeof body?.username === 'string'
    ? body.username.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  if (!username || password.length < 8) {
    writeError(res, 400, 'INVALID_ADMIN_CREDENTIALS', 'username and a password of at least 8 characters are required');
    return;
  }

  ensureEmpresa(params.companyId);
  const admin = createOrUpdateCompanyAdmin(params.companyId, username, hashSecret(password));
  console.log(`[API] Admin ${admin.username} creado/actualizado para empresa ${params.companyId}`);

  writeJson(res, 201, {
    status: 'created',
    companyId: params.companyId,
    username: admin.username,
  });
});

addRoute('GET', '/api/fleet/positions', (req, res) => {
  const auth = authenticateCompanyAdmin(req);
  if (!auth) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Company administrator authentication is required');
    return;
  }
  writeJson(res, 200, {
    companyId: auth.companyId,
    buses: getFleetPositions(auth.companyId),
  });
});

addRoute('POST', '/api/fleet/buses/:busId/visibility', (req, res, params, body) => {
  const auth = authenticateCompanyAdmin(req);
  if (!auth) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Company administrator authentication is required');
    return;
  }

  const companyId = getBusCompanyId(params.busId);
  if (!companyId || companyId !== auth.companyId) {
    writeError(res, 404, 'BUS_NOT_FOUND', 'Bus not found in this company');
    return;
  }

  const visible = body?.visible;
  if (typeof visible !== 'boolean') {
    writeError(res, 400, 'INVALID_VISIBILITY', 'visible must be a boolean');
    return;
  }

  const result = setBusVisibility(params.busId, visible);
  if (!result) {
    writeError(res, 404, 'BUS_NOT_FOUND', 'Bus not found');
    return;
  }
  console.log(`[API] Bus ${params.busId} ${result.visible ? 'visible' : 'oculto'} (empresa ${auth.companyId})`);
  writeJson(res, 200, result);
});

addRoute('POST', '/api/fleet/buses/visibility', (req, res, _params, body) => {
  const auth = authenticateCompanyAdmin(req);
  if (!auth) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Company administrator authentication is required');
    return;
  }

  const visible = body?.visible;
  if (typeof visible !== 'boolean') {
    writeError(res, 400, 'INVALID_VISIBILITY', 'visible must be a boolean');
    return;
  }

  const count = setAllBusVisibility(auth.companyId, visible);
  console.log(`[API] ${count} buses ${visible ? 'visibles' : 'ocultos'} (empresa ${auth.companyId})`);
  writeJson(res, 200, { count });
});

addRoute('GET', '/api/fleet/routes', (req, res) => {
  const auth = authenticateCompanyAdmin(req);
  if (!auth) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Company administrator authentication is required');
    return;
  }
  writeJson(res, 200, {
    companyId: auth.companyId,
    routes: getCompanyRoutes(auth.companyId),
  });
});

addRoute('POST', '/api/fleet/routes', (req, res, _params, body) => {
  const auth = authenticateCompanyAdmin(req);
  if (!auth) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Company administrator authentication is required');
    return;
  }
  if (!adminRateLimiter.allow(requestKey(req, 'route:create'))) {
    writeError(res, 429, 'RATE_LIMITED', 'Too many route creation attempts');
    return;
  }

  const routeId = typeof body?.routeId === 'string' ? body.routeId : '';
  const name = typeof body?.name === 'string' ? body.name : '';

  if (routeNameExists(auth.companyId, name)) {
    writeError(res, 400, 'DUPLICATE_ROUTE', 'Ya existe una ruta con ese nombre');
    return;
  }

  const route = addCompanyRoute(auth.companyId, routeId, name);
  if (!route) {
    writeError(res, 400, 'INVALID_ROUTE', 'routeId (ej. R-104) y name son obligatorios');
    return;
  }
  console.log(`[API] Ruta ${route.routeId} creada para ${auth.companyId}: ${route.name}`);
  writeJson(res, 201, { ...route, total: 0, online: 0 });
});

addRoute('PATCH', '/api/fleet/routes/:routeId', (req, res, params, body) => {
  const auth = authenticateCompanyAdmin(req);
  if (!auth) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Company administrator authentication is required');
    return;
  }
  if (!adminRateLimiter.allow(requestKey(req, 'route:rename'))) {
    writeError(res, 429, 'RATE_LIMITED', 'Too many route rename attempts');
    return;
  }

  const name = typeof body?.name === 'string' ? body.name : '';
  if (routeNameExists(auth.companyId, name, params.routeId)) {
    writeError(res, 400, 'DUPLICATE_ROUTE', 'Ya existe una ruta con ese nombre');
    return;
  }

  const route = renameCompanyRoute(auth.companyId, params.routeId, name);
  if (!route) {
    writeError(res, 404, 'ROUTE_NOT_FOUND', 'Route not found in this company');
    return;
  }
  console.log(`[API] Ruta ${route.routeId} renombrada en ${auth.companyId}: ${route.name}`);
  writeJson(res, 200, { ...route, total: 0, online: 0 });
});

addRoute('DELETE', '/api/fleet/routes/:routeId', (req, res, params) => {
  const auth = authenticateCompanyAdmin(req);
  if (!auth) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Company administrator authentication is required');
    return;
  }
  const removed = removeCompanyRoute(auth.companyId, params.routeId);
  if (!removed) {
    writeError(res, 404, 'ROUTE_NOT_FOUND', 'Route not found in this company');
    return;
  }
  console.log(`[API] Ruta ${params.routeId} eliminada del catálogo de ${auth.companyId}`);
  writeJson(res, 200, { status: 'deleted', routeId: params.routeId });
});

addRoute('DELETE', '/api/fleet/buses', (req, res) => {
  const auth = authenticateCompanyAdmin(req);
  if (!auth) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Company administrator authentication is required');
    return;
  }
  const count = deleteAllBuses(auth.companyId);
  console.log(`[API] Debug: todos los buses (${count}) de ${auth.companyId} eliminados`);
  writeJson(res, 200, { status: 'deleted', count });
});

addRoute('POST', '/api/fleet/buses', (req, res, _params, body) => {
  const auth = authenticateCompanyAdmin(req);
  if (!auth) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Company administrator authentication is required');
    return;
  }
  if (!adminRateLimiter.allow(requestKey(req, 'bus:create'))) {
    writeError(res, 429, 'RATE_LIMITED', 'Too many bus creation attempts');
    return;
  }

  const placa = typeof body?.placa === 'string' ? body.placa : '';
  const routeId = typeof body?.routeId === 'string' ? body.routeId : '';
  const interno = typeof body?.interno === 'string' ? body.interno : '';

  const bus = createBus(auth.companyId, placa, routeId, interno);
  if (!bus) {
    writeError(res, 400, 'INVALID_BUS', 'Placa inválida (3 letras + 3 números, ej. ABC123) o falta la ruta (ej. R-101)');
    return;
  }
  console.log(`[API] Bus ${bus.busId} creado (placa ${bus.placa}, ruta ${bus.routeId ?? '-'}) por ${auth.companyId}`);
  writeJson(res, 201, bus);
});

addRoute('PATCH', '/api/fleet/buses/:busId', (req, res, params, body) => {
  const auth = authenticateCompanyAdmin(req);
  if (!auth) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Company administrator authentication is required');
    return;
  }

  const companyId = getBusCompanyId(params.busId);
  if (!companyId || companyId !== auth.companyId) {
    writeError(res, 404, 'BUS_NOT_FOUND', 'Bus not found in this company');
    return;
  }

  const placa = typeof body?.placa === 'string' ? body.placa : undefined;
  const routeId = typeof body?.routeId === 'string' ? body.routeId : undefined;
  const interno = typeof body?.interno === 'string' ? body.interno : undefined;

  const bus = updateBus(params.busId, { placa, routeId, interno });
  if (!bus) {
    writeError(res, 400, 'INVALID_BUS_PLACA', 'placa must be 3 letters followed by 3 numbers (e.g. ABC123)');
    return;
  }
  console.log(`[API] Bus ${bus.busId} actualizado (placa ${bus.placa}, ruta ${bus.routeId ?? '-'})`);
  writeJson(res, 200, bus);
});

addRoute('DELETE', '/api/fleet/buses/:busId', (req, res, params) => {
  const auth = authenticateCompanyAdmin(req);
  if (!auth) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Company administrator authentication is required');
    return;
  }

  const companyId = getBusCompanyId(params.busId);
  if (!companyId || companyId !== auth.companyId) {
    writeError(res, 404, 'BUS_NOT_FOUND', 'Bus not found in this company');
    return;
  }

  const result = deleteBus(params.busId);
  if (!result) {
    writeError(res, 404, 'BUS_NOT_FOUND', 'Bus not found');
    return;
  }
  console.log(`[API] Bus ${params.busId} eliminado del catálogo (empresa ${auth.companyId})`);
  writeJson(res, 200, { status: 'deleted', ...result });
});

export function handleAPI(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url?.split('?')[0] || '';

  for (const h of handlers) {
    if (req.method !== h.method) continue;
    const match = url.match(h.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    h.paramNames.forEach((name, i) => {
      params[name] = match[i + 1];
    });

    const runHandler = (parsedBody?: Record<string, unknown>): void => {
      try {
        h.handler(req, res, params, parsedBody);
      } catch (error) {
        console.error('[HTTP] Handler error:', error);
        if (!res.headersSent) {
          writeError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
        }
      }
    };

    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
      let body = '';
      let bodyBytes = 0;
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        bodyBytes += chunk.length;
        if (bodyBytes > MAX_BODY_BYTES) {
          tooLarge = true;
          req.destroy();
          if (!res.headersSent) {
            writeError(res, 413, 'REQUEST_TOO_LARGE', 'Request body is too large');
          }
          return;
        }
        body += chunk.toString();
      });
      req.on('end', () => {
        if (tooLarge) return;

        let parsedBody: Record<string, unknown>;
        try {
          parsedBody = body ? JSON.parse(body) as Record<string, unknown> : {};
        } catch {
          writeError(res, 400, 'INVALID_JSON', 'Request body must be valid JSON');
          return;
        }
        runHandler(parsedBody);
      });
    } else {
      runHandler();
    }
    return true;
  }

  return false;
}
