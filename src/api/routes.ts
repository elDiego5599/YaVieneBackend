import { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
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
import { MAX_INTERNO } from '../data/fleet_admin';
import { isRouteId, MAX_NOMBRE_RUTA } from '../data/routes_store';
import {
  adminRateLimiter,
  fleetWriteRateLimiter,
  loginIpRateLimiter,
  loginRateLimiter,
  readRateLimiter,
  requestKey,
  SlidingWindowRateLimiter,
} from '../security/rate_limiter';
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

/**
 * Guarda de lecturas públicas: el catálogo y las posiciones son GET abiertos
 * a internet que la app consulta cada pocos segundos. 120/min por IP deja
 * trabajar a la app de verdad y frena el scraping; health/ready quedan fuera
 * a propósito para no romper los sondeos de vida.
 */
function guardPublicRead(req: IncomingMessage, res: ServerResponse): boolean {
  if (readRateLimiter.allow(requestKey(req, 'read'))) return true;
  writeError(res, 429, 'TOO_MANY_REQUESTS', 'Demasiadas consultas, intenta más tarde');
  return false;
}

/** Deja pasar la petición o responde 429. Devuelve si puede seguir. */
function guardRate(
  limiter: SlidingWindowRateLimiter,
  req: IncomingMessage,
  res: ServerResponse,
  suffix: string,
): boolean {
  if (limiter.allow(requestKey(req, suffix))) return true;
  writeError(res, 429, 'RATE_LIMITED', 'Too many requests');
  return false;
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
  // El limitador va antes de mirar la clave: si fuera después, solo contaría
  // a quien ya la tiene y dejaría probar claves sin tope.
  if (!guardRate(adminRateLimiter, req, res, 'metrics')) return;
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

addRoute('GET', '/api/companies', (req, res) => {
  if (!guardPublicRead(req, res)) return;
  const companies = getEmpresas().map((company) => ({
    id: company.companyId,
    name: company.name,
  }));
  writeJson(res, 200, companies);
});

addRoute('GET', '/api/companies/:id/routes', (req, res, params) => {
  if (!guardPublicRead(req, res)) return;
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

addRoute('GET', '/api/companies/:id/buses', (req, res, params) => {
  if (!guardPublicRead(req, res)) return;
  writeJson(
    res,
    200,
    getCompanyBuses(params.id).filter((b) => b.visible),
  );
});

addRoute('GET', '/api/routes/:routeId/positions', (req, res, params) => {
  if (!guardPublicRead(req, res)) return;
  // La misma revisión que hace el socket antes de abrir sala: si la ruta no
  // tiene forma de ruta, la consulta no llega a la base. Lo que se evita no
  // es la consulta —saldría vacía— sino la respuesta: el `routeId` se
  // devuelve escrito en el cuerpo, y sin esto cualquiera elige qué contesta
  // el servidor. Además el pasajero recibe un 400 y sabe que preguntó mal,
  // en vez de un 200 con la lista vacía que parece "no hay buses".
  if (!isRouteId(params.routeId)) {
    writeError(res, 400, 'INVALID_ROUTE', 'routeId debe tener forma de ruta (ej. R-101)');
    return;
  }
  const positions = getPositionsByRoute(params.routeId).map(toPublicPosition);
  writeJson(res, 200, { routeId: params.routeId, buses: positions });
});

addRoute('GET', '/api/buses/:busId', (req, res, params) => {
  if (!guardPublicRead(req, res)) return;
  const bus = getPosition(params.busId);
  if (!bus) {
    writeError(res, 404, 'BUS_NOT_FOUND', 'Bus not found');
    return;
  }
  const { visible, ...position } = bus;
  if (!visible) {
    writeJson(res, 200, { busId: bus.busId, visible: false });
    return;
  }
  writeJson(res, 200, toPublicPosition(position));
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

// La búsqueda iba antes de la autenticación: sin token, un teléfono dado de
// alta respondía 403 y uno desconocido 404, así que cualquiera podía barrer
// números y saber cuáles son de conductores. Ahora quien no puede leer la
// ficha recibe siempre el mismo 403, exista o no; el 404 queda para quien
// sí tiene permiso de verlo.
addRoute('GET', '/api/drivers/:phone', (req, res, params) => {
  const auth = authenticateRequest(req);
  if (auth?.role !== 'driver') {
    writeError(res, 403, 'DRIVER_FORBIDDEN', 'The token cannot read this driver');
    return;
  }
  const admin = isAdminRequest(req);
  const driver = getDriver(params.phone);
  if (!driver) {
    if (admin) {
      writeError(res, 404, 'DRIVER_NOT_FOUND', 'Driver not found');
    } else {
      writeError(res, 403, 'DRIVER_FORBIDDEN', 'The token cannot read this driver');
    }
    return;
  }
  if (!admin && auth.driverId !== driver.driverId) {
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
  // El limitador iba después de comprobar la clave de administración, así
  // que solo frenaba a quien ya la tenía: los intentos fallidos no contaban
  // y se podían probar claves sin tope. Ahora cuenta todo intento.
  if (!adminRateLimiter.allow(requestKey(req, 'provision'))) {
    writeError(res, 429, 'RATE_LIMITED', 'Too many provisioning attempts');
    return;
  }
  if (!isAdminRequest(req)) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Administrator authentication is required');
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

  // Dos topes: el de la IP entera frena la barrida de cuentas, y el de
  // (IP, teléfono) frena el bombardeo de PIN contra una sola.
  if (
    !loginIpRateLimiter.allow(requestKey(req, 'login')) ||
    !loginRateLimiter.allow(requestKey(req, `login:${phoneNumber || 'unknown'}`))
  ) {
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

// Aquí vivían POST /api/demo/session y POST /api/demo/buses. El primero
// entregaba una sesión de conductor sobre un bus real sin pedir
// autenticación —bastaba con leer el busId de la ruta pública— y de paso
// echaba la sesión legítima del bus. Los buses simulados de la demo se
// arrancan ahora desde el servidor con scripts/demo-buses.sh, que se
// autentica como cualquier otro cliente.

addRoute('POST', '/api/admin/login', (req, res, _params, body) => {
  const username = typeof body?.username === 'string'
    ? body.username.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';
  if (
    !loginIpRateLimiter.allow(requestKey(req, 'adminlogin')) ||
    !loginRateLimiter.allow(requestKey(req, `adminlogin:${username || 'unknown'}`))
  ) {
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
    tv: admin.tokenVersion,
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
  // Igual que en la provisión: el tope va antes de la clave para que los
  // intentos fallidos también cuenten. Y la key ya no lleva la empresa:
  // con ella, cambiar el :companyId de la URL estrenaba presupuesto.
  if (!adminRateLimiter.allow(requestKey(req, 'companyadmin'))) {
    writeError(res, 429, 'RATE_LIMITED', 'Too many attempts');
    return;
  }
  if (!isAdminRequest(req)) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Administrator authentication is required');
    return;
  }

  const username = typeof body?.username === 'string'
    ? body.username.trim().toLowerCase() : '';
  const password = typeof body?.password === 'string' ? body.password : '';

  // 12, igual que scripts/crear-admin-empresa.mjs: la ruta HTTP pedía 8 y el
  // script 12, así que por aquí entraban cuentas de panel más débiles que
  // las que el propio proyecto considera aceptables.
  if (!username || password.length < 12) {
    writeError(res, 400, 'INVALID_ADMIN_CREDENTIALS', 'username and a password of at least 12 characters are required');
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

// Las rutas de flota de aquí abajo que no tenían tope ahora llevan uno: las
// lecturas el mismo de las lecturas públicas (el panel se alimenta del
// socket, no sondea por HTTP) y las escrituras `fleetWriteRateLimiter`.
// Van después de autenticar: sin token no hay nada que leer ni escribir, y
// así un tercero no puede agotarle el cupo a una oficina que comparte IP.
addRoute('GET', '/api/fleet/positions', (req, res) => {
  const auth = authenticateCompanyAdmin(req);
  if (!auth) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Company administrator authentication is required');
    return;
  }
  if (!guardRate(readRateLimiter, req, res, 'fleet:read')) return;
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
  if (!guardRate(fleetWriteRateLimiter, req, res, 'fleet:write')) return;

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
  if (!guardRate(fleetWriteRateLimiter, req, res, 'fleet:write')) return;

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
  if (!guardRate(readRateLimiter, req, res, 'fleet:read')) return;
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
  // 409 y no 201: antes el alta con un id repetido renombraba la ruta que
  // ya existía. El panel lo enseña como «ese identificador ya está».
  if (route === 'taken') {
    writeError(res, 409, 'ROUTE_EXISTS', 'Ya existe una ruta con ese identificador');
    return;
  }
  if (!route) {
    writeError(res, 400, 'INVALID_ROUTE', `routeId (ej. R-104) y name (máx. ${MAX_NOMBRE_RUTA} caracteres) son obligatorios`);
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
  // Sin esto un nombre largo salía como 404 «ruta no encontrada», que es
  // mentira: la ruta existe, lo que sobra es el nombre.
  if (name.trim().length > MAX_NOMBRE_RUTA) {
    writeError(res, 400, 'INVALID_ROUTE', `name admite hasta ${MAX_NOMBRE_RUTA} caracteres`);
    return;
  }
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
  if (!guardRate(fleetWriteRateLimiter, req, res, 'fleet:write')) return;
  const removed = removeCompanyRoute(auth.companyId, params.routeId);
  if (!removed) {
    writeError(res, 404, 'ROUTE_NOT_FOUND', 'Route not found in this company');
    return;
  }
  console.log(`[API] ${auth.username} eliminó la ruta ${params.routeId} del catálogo de ${auth.companyId}`);
  writeJson(res, 200, { status: 'deleted', routeId: params.routeId });
});

/**
 * Borrado masivo: es la única ruta que puede dejar a una empresa sin flota
 * de un golpe, y hasta ahora bastaba con el token —el mismo que se queda
 * abierto en el computador de la oficina toda la jornada— para vaciarla sin
 * decir nada. Ahora hay que nombrar la empresa en `?confirm=`, igual que
 * GitHub pide escribir el nombre del repo antes de borrarlo: un curl mal
 * copiado o un clic perdido ya no alcanzan, y el que sí quiere borrar tiene
 * que escribir a qué empresa le está apuntando. Va con el mismo limitador
 * que la creación de buses y deja el nombre del admin en el registro.
 */
addRoute('DELETE', '/api/fleet/buses', (req, res) => {
  const auth = authenticateCompanyAdmin(req);
  if (!auth) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Company administrator authentication is required');
    return;
  }
  if (!adminRateLimiter.allow(requestKey(req, 'fleet:wipe'))) {
    writeError(res, 429, 'RATE_LIMITED', 'Too many fleet wipe attempts');
    return;
  }

  const query = req.url?.split('?')[1] ?? '';
  const confirm = new URLSearchParams(query).get('confirm');
  if (confirm !== auth.companyId) {
    writeError(
      res,
      400,
      'CONFIRMATION_REQUIRED',
      `Para borrar toda la flota hay que confirmar la empresa: ?confirm=${auth.companyId}`,
    );
    return;
  }

  const count = deleteAllBuses(auth.companyId);
  console.log(`[API] ${auth.username} borró los ${count} buses de ${auth.companyId}`);
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
  if (bus === 'invalid') {
    writeError(
      res,
      400,
      'INVALID_BUS',
      `Placa inválida (3 letras + 3 números, ej. ABC123), ruta que falta o mal escrita (ej. R-101) o interno de más de ${MAX_INTERNO} caracteres`,
    );
    return;
  }
  // La placa ya está dada de alta en otra empresa. No se dice en cuál: quien
  // pregunta no tiene por qué enterarse de la flota ajena.
  if (bus === 'taken') {
    writeError(res, 409, 'BUS_TAKEN', 'Esa placa ya está registrada en otra empresa');
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
  if (!guardRate(fleetWriteRateLimiter, req, res, 'fleet:write')) return;

  const companyId = getBusCompanyId(params.busId);
  if (!companyId || companyId !== auth.companyId) {
    writeError(res, 404, 'BUS_NOT_FOUND', 'Bus not found in this company');
    return;
  }

  const placa = typeof body?.placa === 'string' ? body.placa : undefined;
  const rawRouteId = typeof body?.routeId === 'string' ? body.routeId.trim() : undefined;
  const interno = typeof body?.interno === 'string' ? body.interno : undefined;
  // La edición guardaba cualquier cadena como ruta, igual que el alta: un bus
  // pasado a `<lo que sea>` desaparecía del mapa del pasajero. La cadena vacía
  // sigue sirviendo para dejar el bus sin ruta.
  if (rawRouteId && !isRouteId(rawRouteId)) {
    writeError(res, 400, 'INVALID_ROUTE', 'routeId debe tener forma de ruta (ej. R-101)');
    return;
  }
  if (interno !== undefined && interno.trim().length > MAX_INTERNO) {
    writeError(res, 400, 'INVALID_INTERNO', `interno admite hasta ${MAX_INTERNO} caracteres`);
    return;
  }
  const routeId = rawRouteId;

  const bus = updateBus(params.busId, { placa, routeId, interno });
  // El mismo 409 que el alta, y sin decir de quién es la placa: con la
  // edición se podía hacer lo que el alta ya no deja.
  if (bus === 'taken') {
    writeError(res, 409, 'BUS_TAKEN', 'Esa placa ya está registrada en otro bus');
    return;
  }
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
  if (!guardRate(fleetWriteRateLimiter, req, res, 'fleet:write')) return;

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
  console.log(`[API] ${auth.username} eliminó el bus ${params.busId} del catálogo (empresa ${auth.companyId})`);
  writeJson(res, 200, { status: 'deleted', ...result });
});

/**
 * Los métodos que la API atiende de verdad, en el orden en que se
 * registran. La cabecera `Access-Control-Allow-Methods` sale de aquí y no
 * de una lista escrita a mano: esa lista decía `GET, POST` mucho después
 * de que la flota estrenara sus rutas PATCH y DELETE, y una cabecera corta
 * no rompe nada hasta que el panel se sirve desde otro origen y el
 * navegador se niega a mandar la petición. Añadir una ruta con un método
 * nuevo la anuncia sola.
 */
export function metodosHttpRegistrados(): string[] {
  const vistos: string[] = [];
  for (const h of handlers) if (!vistos.includes(h.method)) vistos.push(h.method);
  return vistos;
}

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
          // `req.destroy()` iba antes de escribir la respuesta y se llevaba
          // por delante el socket: el cliente veía un reset de conexión, no
          // el 413. Primero sale el JSON, y el socket se corta cuando la
          // respuesta ya se fue, para no seguir tragando el cuerpo entero.
          if (!res.headersSent) {
            res.setHeader('Connection', 'close');
            writeError(res, 413, 'REQUEST_TOO_LARGE', 'Request body is too large');
          }
          res.once('finish', () => req.destroy());
          body = '';
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
