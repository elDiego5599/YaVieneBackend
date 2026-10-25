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
import { getActiveDeviceByIdentifier } from '../data/drivers_store';
import { authenticateRequest, isAdminRequest, isDeviceForBus, authenticateCompanyAdmin } from '../auth/http';
import { hashPin, hashSecret, verifySecretSinDelatar } from '../auth/passwords';
import { signToken } from '../auth/tokens';
import { cookieBorrada, cookieDeSesion, esOrigenDelPanel, leerCookiePanel } from '../auth/cookie_panel';
import { createDeviceSession, revokeSession, revokeSessionsForDevice } from '../data/sessions';
import { getMetrics, incrementMetric } from '../observability/metrics';
import { MAX_INTERNO, TIPOLOGIAS, MAX_CAPACIDAD, MIN_CAPACIDAD, getBusRouteId, normalizeCapacidad, normalizeTipologia } from '../data/fleet_admin';
import { esRutaDeEmpresa, isRouteId, MAX_NOMBRE_RUTA } from '../data/routes_store';
import {
  adminRateLimiter,
  avisosRateLimiter,
  fleetWriteRateLimiter,
  loginIpRateLimiter,
  loginRateLimiter,
  MAX_FALLOS_PIN_POR_CUENTA,
  deviceLoginLockout,
  readRateLimiter,
  reportesRateLimiter,
  lanzamientoRateLimiter,
  busquedasRateLimiter,
  requestKey,
  SlidingWindowRateLimiter,
} from '../security/rate_limiter';
import { getDb } from '../data/database';
import {
  borrarAviso, crearAviso, RADIO_AVISO_M, RADIO_MAXIMO_M, RADIO_MINIMO_M, renovarAviso, VIDA_MAXIMA_MS,
} from '../data/avisos_push';
import { crearReporte, leerReporte } from '../data/reportes';
import {
  borrarSuscripcion, borrarTodas, guardarSuscripcion, leerSuscripcion, listarSuscripciones, normalizarTelefono,
} from '../data/lanzamiento';
import { busInCatalog } from '../data/positions_store';
import { getBusVisibility } from '../data/fleet_admin';
import { dentroDeZona } from '../security/zona';
import { calorBusquedas, PASO_LAT, PASO_LNG, rankingBusquedas, registrarBusqueda } from '../data/busquedas';
import { emisorPush } from '../push/fcm';
import { isBrokerReady } from '../mqtt/broker';
import {
  getEmpresa,
  ensureEmpresa,
  createOrUpdateCompanyAdmin,
  getCompanyAdminByUsername,
  revokeAdminTokens,
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

function setSecurityHeaders(res: ServerResponse): void {
  // Globales vía setHeader para no quedar fuera de writeHead(204) directos.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
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
  // `routeId` es el nombre que usa el resto del contrato. `id` lleva el mismo
  // valor para las apps ya instaladas, que leen ese; se retira cuando todas
  // lean `routeId`.
  const routes = getCompanyRoutes(params.id).map((route) => ({
    routeId: route.routeId,
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
  // Un bus oculto contesta lo mismo que uno que no existe: con un 200
  // `{visible:false}` aparte, cualquiera distinguía «existe pero la empresa
  // lo esconde» de «no hay tal bus» probando ids (T3.4, YV-21).
  if (!bus || !bus.visible) {
    writeError(res, 404, 'BUS_NOT_FOUND', 'Bus not found');
    return;
  }
  const { visible: _visible, ...position } = bus;
  writeJson(res, 200, toPublicPosition(position));
});

addRoute('POST', '/api/buses/:busId/offline', (req, res, params) => {
  const auth = authenticateRequest(req);
  if (auth?.role !== 'device' || !isDeviceForBus(auth, params.busId)) {
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
  endAssignment(auth.deviceId, params.busId);
  console.log(`[API] Bus ${params.busId} marcado offline por el conductor`);
  writeJson(res, 200, { status: 'offline', busId: params.busId });
});

addRoute('POST', '/api/gps', (_req, res) => {
  writeError(res, 410, 'HTTP_GPS_DISABLED', 'GPS ingestion is available through authenticated MQTT only');
});

/** Un segmento de topic MQTT: sin separador ni comodines ni controles, hasta 64. */
const IDENTIFICADOR_DE_TOPIC = /^[^/+#\u0000-\u001f\u007f]{1,64}$/;
/** Texto de una línea, sin caracteres de control: la línea hasta 32, el nombre hasta 120. */
const TELEFONO_DE_TEXTO = /^[^\u0000-\u001f\u007f]{1,32}$/;
const NOMBRE_DE_TEXTO = /^[^\u0000-\u001f\u007f]{1,120}$/;

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

  const secureDeviceProvision = typeof body?.identifier === 'string' && typeof body?.secret === 'string';
  const phoneNumber = secureDeviceProvision
    ? body.identifier as string
    : typeof body?.phoneNumber === 'string' ? body.phoneNumber : '';
  const name = typeof body?.name === 'string' ? body.name : phoneNumber;
  const routeId = typeof body?.routeId === 'string' ? body.routeId : '';
  const busId = typeof body?.busId === 'string' ? body.busId : '';
  const companyId = typeof body?.companyId === 'string'
    ? body.companyId
    : typeof body?.empresaId === 'string' ? body.empresaId : '';
  const pin = typeof body?.pin === 'string' ? body.pin : '';
  const secret = secureDeviceProvision ? body.secret as string : '';

  if (!phoneNumber || !name || !routeId || !busId || !companyId
    || (secureDeviceProvision ? secret.length < 32 : !/^\d{4,8}$/.test(pin))) {
    writeError(
      res,
      400,
      'INVALID_DRIVER_PROVISION',
      secureDeviceProvision
        ? 'identifier, name, routeId, busId, companyId and a secret of at least 32 characters are required'
        : 'phoneNumber, name, routeId, busId, companyId and a numeric pin are required',
    );
    return;
  }
  // Formas (auditoría 2026-09, P3-10). Solo se cierra lo que nunca pudo
  // funcionar: un busId o companyId con /, + o # arma un topic MQTT que el
  // broker no acepta, una ruta sin forma de ruta no la ve ningún pasajero,
  // y un caracter de control o un texto de kilobytes no es una línea ni un
  // nombre. Antes todo eso entraba con 201 y el equipo quedaba mudo.
  if (
    !IDENTIFICADOR_DE_TOPIC.test(busId)
    || !IDENTIFICADOR_DE_TOPIC.test(companyId)
    || !isRouteId(routeId)
    || !TELEFONO_DE_TEXTO.test(phoneNumber)
    || !NOMBRE_DE_TEXTO.test(name)
  ) {
    writeError(res, 400, 'INVALID_DRIVER_PROVISION', 'busId and companyId cannot contain /, + or #; routeId must look like a route; phoneNumber and name must be short plain text');
    return;
  }
  if (!getEmpresa(companyId)) {
    writeError(res, 404, 'COMPANY_NOT_FOUND', 'Company not found');
    return;
  }

  const driver = registerDriver(phoneNumber, name, routeId, {
    driverId: getDriver(phoneNumber)?.driverId ?? randomUUID(),
    companyId,
    busId,
    pinHash: secureDeviceProvision ? hashSecret(secret) : hashPin(pin),
  });
  // Mismo 409 que el alta desde el panel, sin decir de quién es el bus.
  if (driver === 'taken') {
    writeError(res, 409, 'BUS_TAKEN', 'Ese bus ya está registrado en otra empresa');
    return;
  }
  revokeSessionsForDevice(driver.driverId);
  // El alta pone un PIN nuevo con la clave de administración: el bloqueo por
  // PIN fallidos de esa línea ya no protege nada y el equipo entra enseguida.
  deviceLoginLockout.levantar(phoneNumber);

  writeJson(res, 201, {
    status: 'provisioned',
    driver: publicDriver(driver),
  });
}

addRoute('POST', '/api/admin/drivers', provisionDriver);
addRoute('POST', '/api/drivers/register', provisionDriver);

function loginDevice(
  req: IncomingMessage,
  res: ServerResponse,
  identifier: string,
  secret: string,
  requestedBusId: string | null,
  requestedRouteId: string | null,
): void {
  // Dos topes: el de la IP entera frena la barrida de cuentas, y el de
  // (IP, teléfono) frena el bombardeo de PIN contra una sola.
  if (
    !loginIpRateLimiter.allow(requestKey(req, 'login')) ||
    !loginRateLimiter.allow(requestKey(req, `login:${identifier || 'unknown'}`))
  ) {
    writeError(res, 429, 'RATE_LIMITED', 'Too many login attempts');
    return;
  }

  if (!identifier || !secret) {
    writeError(res, 400, 'CREDENTIALS_REQUIRED', 'El identificador y el secreto son obligatorios');
    return;
  }

  // Y un tercero por la cuenta sola (P2-3): los dos de arriba no ven los
  // intentos contra un mismo teléfono repartidos entre muchas IP. Mientras
  // dura el bloqueo no se mira el PIN, ni siquiera el bueno. Mismo 429 que
  // los otros topes: el equipo ya sabe esperar y reintentar.
  const bloqueo = deviceLoginLockout.restante(identifier);
  if (bloqueo > 0) {
    res.setHeader('Retry-After', String(Math.ceil(bloqueo / 1000)));
    writeError(res, 429, 'RATE_LIMITED', 'Too many login attempts');
    return;
  }

  const device = getActiveDeviceByIdentifier(identifier);
  // scrypt corre siempre, exista o no la línea (P3-1): si no, el tiempo de
  // respuesta decía qué teléfonos están dados de alta.
  const pinBueno = verifySecretSinDelatar(secret, device?.pinHash);
  const companyId = device?.companyId;
  const busId = device?.busId;
  const company = companyId ? getEmpresa(companyId) : null;
  const busBelongsToCompany = Boolean(companyId && busId
    && getDb().prepare('SELECT 1 FROM buses WHERE bus_id = ? AND company_id = ?')
      .get(busId, companyId));
  if (!device || !pinBueno || !companyId || !busId || !company || !busBelongsToCompany) {
    const bloqueoMs = deviceLoginLockout.fallo(identifier);
    if (bloqueoMs > 0) {
      incrementMetric('login.cuenta_bloqueada');
      console.warn(`[Auth] Cuenta …${identifier.slice(-4)} bloqueada ${Math.round(bloqueoMs / 60_000)} min tras ${MAX_FALLOS_PIN_POR_CUENTA} PIN fallidos`);
    }
    writeError(res, 401, 'INVALID_CREDENTIALS', 'Invalid driver credentials');
    return;
  }
  deviceLoginLockout.acierto(identifier);

  if (requestedBusId && requestedBusId !== device.busId) {
    writeError(res, 403, 'BUS_FORBIDDEN', 'The driver is not assigned to this bus');
    return;
  }
  if (requestedRouteId && requestedRouteId !== device.routeId) {
    writeError(res, 403, 'ROUTE_FORBIDDEN', 'The driver is not assigned to this route');
    return;
  }

  const sessionId = randomUUID();
  const token = signToken({
    sub: device.driverId,
    deviceId: device.driverId,
    identifier,
    role: 'device',
    companyId,
    busId,
    routeId: device.routeId,
    sessionId,
  });

  createDeviceSession({
    sessionId,
    deviceId: device.driverId,
    identifier: device.phoneNumber,
    companyId,
    busId,
    routeId: device.routeId,
  });

  writeJson(res, 200, {
    driver: publicDriver(device),
    token,
  });
}

addRoute('POST', '/api/devices/login', (req, res, _params, body) => {
  const identifier = typeof body?.identifier === 'string' ? body.identifier : '';
  const secret = typeof body?.secret === 'string' ? body.secret : '';
  loginDevice(req, res, identifier, secret, null, null);
});

// Compatibilidad temporal: clientes anteriores todavía envían phoneNumber/pin.
addRoute('POST', '/api/auth/login', (req, res, _params, body) => {
  const identifier = typeof body?.phoneNumber === 'string' ? body.phoneNumber : '';
  const secret = typeof body?.pin === 'string' ? body.pin : '';
  const busId = typeof body?.busId === 'string' ? body.busId : null;
  const routeId = typeof body?.routeId === 'string' ? body.routeId : null;
  loginDevice(req, res, identifier, secret, busId, routeId);
});

// Aquí vivían POST /api/demo/session y POST /api/demo/buses. El primero
// entregaba una sesión de conductor sobre un bus real sin pedir
// autenticación —bastaba con leer el busId de la ruta pública— y de paso
// echaba la sesión legítima del bus. Los buses simulados de la demo se
// arrancan ahora desde el servidor con scripts/demo-buses.sh, que se
// autentica como cualquier otro cliente.

addRoute('POST', '/api/admin/login', (req, res, _params, body) => {
  // Una página que no es el panel no inicia sesiones: sin esto podía meter
  // al navegador de alguien en una cuenta ajena (CSRF del login). Sin
  // Origin es el escritorio, que nunca lo manda.
  const web = req.headers.origin !== undefined;
  if (web && !esOrigenDelPanel(req.headers)) {
    writeError(res, 403, 'ORIGIN_NOT_ALLOWED', 'Origin not allowed');
    return;
  }
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
  // Igual que en el login del equipo (P3-1): el tiempo no dice si el
  // usuario existe.
  if (!verifySecretSinDelatar(password, admin?.passwordHash) || !admin) {
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

  const company = {
    companyId: admin.companyId,
    name: getEmpresa(admin.companyId)?.name ?? admin.companyId,
  };
  // En el navegador el token va solo en la cookie HttpOnly: si además
  // viajara en el cuerpo, un script inyectado lo leería al entrar.
  if (web) {
    res.setHeader('Set-Cookie', cookieDeSesion(token));
    writeJson(res, 200, { company });
    return;
  }
  writeJson(res, 200, { token, company });
});

// Con qué empresa está abierta la sesión del panel web. El panel no puede
// leer su cookie (HttpOnly) y al arrancar le pregunta esto al servidor; el
// escritorio sabe lo mismo por su llavero y no lo usa.
addRoute('GET', '/api/admin/sesion', (req, res) => {
  const auth = authenticateCompanyAdmin(req);
  if (!auth) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Company administrator authentication is required');
    return;
  }
  if (!guardRate(readRateLimiter, req, res, 'fleet:read')) return;
  writeJson(res, 200, {
    company: {
      companyId: auth.companyId,
      name: getEmpresa(auth.companyId)?.name ?? auth.companyId,
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

// Cerrar sesión en el panel. Antes solo se borraba el token del equipo, y
// quien lo hubiera copiado seguía entrando hasta que caducara (8 h). Ahora
// sube la versión de la credencial: el REST rechaza el token en la siguiente
// petición y la revisión de paneles del socket lo saca en menos de un
// minuto. Corta todas las sesiones de esa cuenta, no solo la de este equipo:
// los tokens no llevan identificador propio y esto no guarda una lista de
// revocados. Sin cuerpo en la respuesta: no hay nada que contar.
addRoute('POST', '/api/fleet/logout', (req, res) => {
  // La cookie del panel web se borra pase lo que pase: aunque su token ya
  // no valga, no tiene por qué quedarse en el navegador.
  if (leerCookiePanel(req.headers)) res.setHeader('Set-Cookie', cookieBorrada());
  const auth = authenticateCompanyAdmin(req);
  if (!auth) {
    writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Company administrator authentication is required');
    return;
  }
  if (!guardRate(fleetWriteRateLimiter, req, res, 'fleet:write')) return;
  if (revokeAdminTokens(auth.sub, auth.companyId, auth.tv)) {
    console.log(`[API] Admin ${auth.username} cerró sesión (empresa ${auth.companyId})`);
  }
  res.writeHead(204);
  res.end();
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
  // Tipología cerrada (SENCILLO | PADRON | ARTICULADO) y aforo por bus.
  // Sin tipología se asume SENCILLO; sin capacidad, el ejemplo de su
  // tipología (30/60/80). El panel manda el desplegable + el número.
  const rawTipologia = body?.tipologia === undefined ? undefined : body.tipologia;
  const rawCapacidad = body?.capacidad === undefined ? undefined : body.capacidad;
  if (rawTipologia !== undefined && !normalizeTipologia(rawTipologia)) {
    writeError(res, 400, 'INVALID_TIPOLOGIA', `tipologia debe ser una de: ${TIPOLOGIAS.join(', ')}`);
    return;
  }
  if (rawCapacidad !== undefined && normalizeCapacidad(rawCapacidad) === null) {
    writeError(res, 400, 'INVALID_CAPACIDAD', `capacidad debe ser un entero entre ${MIN_CAPACIDAD} y ${MAX_CAPACIDAD}`);
    return;
  }

  // La ruta tiene que ser del catálogo de esta empresa (auditoría 2026-09,
  // P1-2): antes bastaba con la forma, y B ponía buses en la R-301 de A. El
  // 404 es el mismo que da una ruta ajena en /api/fleet/routes, sin decir si
  // existe en otra parte. Una ruta mal escrita sigue siendo el 400 de abajo.
  const rutaPedida = routeId.trim();
  if (isRouteId(rutaPedida) && !esRutaDeEmpresa(auth.companyId, rutaPedida)) {
    writeError(res, 404, 'ROUTE_NOT_FOUND', 'Route not found in this company');
    return;
  }

  const bus = createBus(auth.companyId, placa, routeId, interno, { tipologia: rawTipologia, capacidad: rawCapacidad });
  if (bus === 'invalid') {
    writeError(
      res,
      400,
      'INVALID_BUS',
      `Placa inválida (3 letras + 3 números, ej. ABC123), ruta que falta o mal escrita (ej. R-101), interno de más de ${MAX_INTERNO} caracteres, tipología fuera de ${TIPOLOGIAS.join('/')} o capacidad fuera de ${MIN_CAPACIDAD}-${MAX_CAPACIDAD}`,
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
  const rawTipologia = body?.tipologia === undefined ? undefined : body.tipologia;
  const rawCapacidad = body?.capacidad === undefined ? undefined : body.capacidad;
  // La edición guardaba cualquier cadena como ruta, igual que el alta: un bus
  // pasado a `<lo que sea>` desaparecía del mapa del pasajero. La cadena vacía
  // sigue sirviendo para dejar el bus sin ruta.
  if (rawRouteId && !isRouteId(rawRouteId)) {
    writeError(res, 400, 'INVALID_ROUTE', 'routeId debe tener forma de ruta (ej. R-101)');
    return;
  }
  // Misma regla que el alta: solo rutas del catálogo de esta empresa. Si el
  // panel reenvía la ruta que el bus ya tiene no es un cambio de ruta, y se
  // deja pasar: un bus que quedó en una ruta fuera del catálogo (provisión
  // con la clave global, bases viejas) tiene que poder editarse igual.
  if (
    rawRouteId
    && rawRouteId !== getBusRouteId(params.busId)
    && !esRutaDeEmpresa(auth.companyId, rawRouteId)
  ) {
    writeError(res, 404, 'ROUTE_NOT_FOUND', 'Route not found in this company');
    return;
  }
  if (interno !== undefined && interno.trim().length > MAX_INTERNO) {
    writeError(res, 400, 'INVALID_INTERNO', `interno admite hasta ${MAX_INTERNO} caracteres`);
    return;
  }
  if (rawTipologia !== undefined && !normalizeTipologia(rawTipologia)) {
    writeError(res, 400, 'INVALID_TIPOLOGIA', `tipologia debe ser una de: ${TIPOLOGIAS.join(', ')}`);
    return;
  }
  if (rawCapacidad !== undefined && normalizeCapacidad(rawCapacidad) === null) {
    writeError(res, 400, 'INVALID_CAPACIDAD', `capacidad debe ser un entero entre ${MIN_CAPACIDAD} y ${MAX_CAPACIDAD}`);
    return;
  }
  const routeId = rawRouteId;

  const bus = updateBus(params.busId, { placa, routeId, interno, tipologia: rawTipologia, capacidad: rawCapacidad });
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

// ── Avisos por push (D13) ────────────────────────────────────────────
// Públicos como el catálogo: el pasajero no tiene cuenta. El identificador
// del aviso (un UUID aleatorio) es la llave para latir y desarmar; quien no
// lo tiene no puede tocar el aviso de otro. Ver `data/avisos_push.ts`.

/** Tokens de registro de FCM: base64 de URL con «:», unos 160 caracteres. */
const TOKEN_FCM = /^[A-Za-z0-9_:.-]{20,1024}$/;
const ID_AVISO = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Token y punto de un cuerpo de aviso, o el mensaje de lo que falla. */
function leerPuntoYToken(body: Record<string, unknown> | undefined): { token: string; lat: number; lon: number } | string {
  const { token, lat, lon } = body ?? {};
  if (typeof token !== 'string' || !TOKEN_FCM.test(token)) return 'token inválido';
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return 'lat y lon tienen que ser números';
  }
  // Fuera del área metropolitana no hay buses que esperar: el mapa de la
  // app no llega allá (`security/zona.ts`).
  if (!dentroDeZona(lat, lon)) return 'el punto está fuera de la zona de servicio';
  return { token, lat, lon };
}

addRoute('POST', '/api/avisos', (req, res, _params, body) => {
  if (!guardRate(avisosRateLimiter, req, res, 'avisos')) return;
  if (!emisorPush()) {
    writeError(res, 503, 'PUSH_NO_DISPONIBLE', 'Los avisos con la app cerrada no están activos en este servidor');
    return;
  }
  const punto = leerPuntoYToken(body);
  if (typeof punto === 'string') {
    writeError(res, 400, 'INVALID_INPUT', punto);
    return;
  }
  const { busId, routeId, vidaMs, radioM } = body ?? {};
  if (typeof routeId !== 'string' || !isRouteId(routeId)) {
    writeError(res, 400, 'INVALID_INPUT', 'routeId inválido');
    return;
  }
  if (vidaMs !== undefined && (typeof vidaMs !== 'number' || !Number.isInteger(vidaMs) || vidaMs <= 0)) {
    writeError(res, 400, 'INVALID_INPUT', 'vidaMs tiene que ser un entero positivo');
    return;
  }
  // La distancia que eligió el pasajero. Sin ella (una app de antes) suena
  // al kilómetro de siempre.
  if (radioM !== undefined && (
    typeof radioM !== 'number' || !Number.isInteger(radioM) || radioM < RADIO_MINIMO_M || radioM > RADIO_MAXIMO_M
  )) {
    writeError(res, 400, 'INVALID_INPUT', `radioM tiene que ser un entero entre ${RADIO_MINIMO_M} y ${RADIO_MAXIMO_M}`);
    return;
  }
  // Un bus oculto por su empresa responde igual que uno que no existe: el
  // pasajero no lo ve en el mapa y no tiene por qué saber que está.
  if (typeof busId !== 'string' || !busInCatalog(busId) || !getBusVisibility(busId)) {
    writeError(res, 404, 'BUS_NOT_FOUND', 'Bus no encontrado');
    return;
  }
  const creado = crearAviso({
    ...punto, busId, routeId, vidaMs: vidaMs ?? VIDA_MAXIMA_MS, radioM: radioM ?? RADIO_AVISO_M,
  });
  if (creado === 'tope_token') {
    writeError(res, 429, 'DEMASIADOS_AVISOS', 'Este teléfono ya tiene el máximo de avisos armados');
    return;
  }
  if (creado === 'lleno') {
    incrementMetric('push.tabla_llena');
    writeError(res, 503, 'AVISOS_LLENOS', 'No se pueden armar más avisos por ahora');
    return;
  }
  writeJson(res, 201, creado);
});

addRoute('PUT', '/api/avisos/:id', (req, res, params, body) => {
  if (!guardRate(avisosRateLimiter, req, res, 'avisos')) return;
  const punto = leerPuntoYToken(body);
  if (!ID_AVISO.test(params.id) || typeof punto === 'string') {
    writeError(res, 400, 'INVALID_INPUT', typeof punto === 'string' ? punto : 'id inválido');
    return;
  }
  const resultado = renovarAviso(params.id, punto);
  if (resultado === 'no_existe') {
    writeError(res, 404, 'AVISO_NOT_FOUND', 'El aviso no existe o ya venció');
    return;
  }
  if (resultado === 'enviado') {
    // 410 y no 200: la app que vuelve se entera de que el servidor ya avisó
    // y no vuelve a avisar ella.
    writeError(res, 410, 'AVISO_ENVIADO', 'El aviso ya se envió');
    return;
  }
  res.writeHead(204);
  res.end();
});

addRoute('DELETE', '/api/avisos/:id', (req, res, params) => {
  if (!guardRate(avisosRateLimiter, req, res, 'avisos')) return;
  if (!ID_AVISO.test(params.id)) {
    writeError(res, 400, 'INVALID_INPUT', 'id inválido');
    return;
  }
  // Idempotente: desarmar dos veces, o desarmar uno que ya venció, es lo mismo.
  borrarAviso(params.id);
  res.writeHead(204);
  res.end();
});

// ─── Buzón de problemas y sugerencias (D14) ─────────────────────────────

addRoute('POST', '/api/reportes', (req, res, _params, body) => {
  if (!guardRate(reportesRateLimiter, req, res, 'reportes')) return;
  const reporte = leerReporte(body);
  if ('error' in reporte) {
    writeError(res, 400, 'INVALID_INPUT', reporte.error);
    return;
  }
  // 201 aunque el correo aún no esté configurado: el reporte queda en la
  // cola y sale cuando lo esté. Al pasajero le basta con saber que llegó.
  if (crearReporte(reporte) === 'lleno') {
    writeError(res, 503, 'BUZON_LLENO', 'El buzón está lleno, intenta más tarde');
    return;
  }
  writeJson(res, 201, { recibido: true });
});

// ─── «Avísame cuando salga», la lista de la web (D15) ───────────────────

addRoute('POST', '/api/lanzamiento', (req, res, _params, body) => {
  if (!guardRate(lanzamientoRateLimiter, req, res, 'lanzamiento')) return;
  const suscripcion = leerSuscripcion(body);
  if ('error' in suscripcion) {
    writeError(res, 400, 'INVALID_INPUT', suscripcion.error);
    return;
  }
  if (guardarSuscripcion(suscripcion.telefono) === 'lleno') {
    writeError(res, 503, 'LISTA_LLENA', 'No se pueden guardar más números por ahora');
    return;
  }
  writeJson(res, 201, { recibido: true });
});

// Conteo agregado para analítica. requestKey solo se usa dentro del limitador;
// ninguna identidad ni dirección se entrega a registrarBusqueda.
addRoute('POST', '/api/busquedas', (req, res, _params, body) => {
  if (!guardRate(busquedasRateLimiter, req, res, 'busquedas')) return;
  if (!body || Buffer.byteLength(JSON.stringify(body)) > 1024 || typeof body.routeId !== 'string') {
    writeError(res, 400, 'INVALID_INPUT', 'Cuerpo de búsqueda inválido'); return;
  }
  const ruta = getDb().prepare('SELECT 1 FROM company_routes WHERE route_id = ?').get(body.routeId);
  if (!ruta) { writeError(res, 400, 'INVALID_ROUTE', 'La ruta no existe o no está visible'); return; }
  let lat: number | null = null; let lng: number | null = null;
  if (body.celda !== undefined) {
    const celda = body.celda as Record<string, unknown>;
    if (!celda || typeof celda !== 'object' || !Number.isFinite(celda.lat) || !Number.isFinite(celda.lng)) {
      writeError(res, 400, 'INVALID_CELL', 'celda debe traer lat y lng finitos'); return;
    }
    const rawLat = celda.lat as number; const rawLng = celda.lng as number;
    if (!dentroDeZona(rawLat, rawLng)) { writeError(res, 400, 'INVALID_CELL', 'celda fuera del área de servicio'); return; }
    const alignedLat = Math.round(rawLat / PASO_LAT) * PASO_LAT;
    const alignedLng = Math.round(rawLng / PASO_LNG) * PASO_LNG;
    if (Math.abs(rawLat - alignedLat) > 1e-7 || Math.abs(rawLng - alignedLng) > 1e-7) {
      writeError(res, 400, 'INVALID_CELL', 'celda debe coincidir con la rejilla'); return;
    }
    lat = Number(alignedLat.toFixed(8)); lng = Number(alignedLng.toFixed(8));
  }
  registrarBusqueda(body.routeId, lat, lng);
  res.writeHead(204); res.end();
});

function rangoBusquedas(req: IncomingMessage) {
  const params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  const ahora = Date.now();
  const desde = params.has('desde') ? Date.parse(params.get('desde')!) : ahora - 30 * 24 * 60 * 60_000;
  const hasta = params.has('hasta') ? Date.parse(params.get('hasta')!) : ahora + 1;
  const horaTxt = params.get('hora'); const hora = horaTxt === null ? undefined : Number(horaTxt);
  if (!Number.isFinite(desde) || !Number.isFinite(hasta) || desde >= hasta
    || (hora !== undefined && (!Number.isInteger(hora) || hora < 0 || hora > 23))) return null;
  return { desde, hasta, hora };
}
addRoute('GET', '/api/panel/busquedas', (req, res) => {
  const auth = authenticateCompanyAdmin(req);
  if (!auth) { writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Company admin authentication is required'); return; }
  const rango = rangoBusquedas(req);
  if (!rango) { writeError(res, 400, 'INVALID_INPUT', 'Rango u hora inválidos'); return; }
  writeJson(res, 200, { rutas: rankingBusquedas(auth.companyId, rango.desde, rango.hasta, rango.hora) });
});
addRoute('GET', '/api/panel/busquedas/:routeId/calor', (req, res, params) => {
  const auth = authenticateCompanyAdmin(req);
  if (!auth) { writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Company admin authentication is required'); return; }
  const rango = rangoBusquedas(req);
  if (!rango) { writeError(res, 400, 'INVALID_INPUT', 'Rango u hora inválidos'); return; }
  const celdas = calorBusquedas(auth.companyId, params.routeId, rango.desde, rango.hasta, rango.hora);
  if (celdas === null) { writeError(res, 404, 'ROUTE_NOT_FOUND', 'Route not found'); return; }
  writeJson(res, 200, { routeId: params.routeId, celdas });
});

/** Las rutas del equipo: el tope va antes de la clave, como en las demás. */
function guardAdmin(req: IncomingMessage, res: ServerResponse): boolean {
  if (!guardRate(adminRateLimiter, req, res, 'lanzamiento-admin')) return false;
  if (isAdminRequest(req)) return true;
  writeError(res, 401, 'ADMIN_AUTH_REQUIRED', 'Administrator authentication is required');
  return false;
}

addRoute('GET', '/api/admin/lanzamiento', (req, res) => {
  if (!guardAdmin(req, res)) return;
  writeJson(res, 200, { telefonos: listarSuscripciones() });
});

// A pedido de su dueño (Ley 1581): se escribe como lo dé la persona.
addRoute('DELETE', '/api/admin/lanzamiento/:telefono', (req, res, params) => {
  if (!guardAdmin(req, res)) return;
  const telefono = normalizarTelefono(params.telefono);
  if (!telefono) {
    writeError(res, 400, 'INVALID_INPUT', 'telefono no es un celular válido');
    return;
  }
  borrarSuscripcion(telefono);
  res.writeHead(204);
  res.end();
});

// Tras avisar del lanzamiento la lista ya cumplió: se vacía entera.
addRoute('DELETE', '/api/admin/lanzamiento', (req, res) => {
  if (!guardAdmin(req, res)) return;
  borrarTodas();
  res.writeHead(204);
  res.end();
});

/**
 * Una cookie viaja sola: lo que escribe con la del panel tiene que venir
 * además de una página del panel. SameSite=Strict ya frena a otro sitio;
 * esto es la segunda llave, y cierra también la petición sin Origin. Con
 * `Authorization` la cookie no cuenta (`authenticateRequest`) y no se mira.
 */
function escrituraConCookieAjena(req: IncomingMessage): boolean {
  if (req.method === 'GET' || req.method === 'HEAD') return false;
  if (req.headers.authorization !== undefined) return false;
  return leerCookiePanel(req.headers) !== null && !esOrigenDelPanel(req.headers);
}

export function handleAPI(req: IncomingMessage, res: ServerResponse): boolean {
  setSecurityHeaders(res);
  const url = req.url?.split('?')[0] || '';
  if (escrituraConCookieAjena(req)) {
    writeError(res, 403, 'ORIGIN_NOT_ALLOWED', 'Origin not allowed');
    return true;
  }

  for (const h of handlers) {
    if (req.method !== h.method) continue;
    const match = url.match(h.pattern);
    if (!match) continue;

    const params: Record<string, string> = {};
    try {
      h.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });
    } catch {
      writeError(res, 400, 'INVALID_PARAM', 'Invalid URL encoding');
      return true;
    }

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
      // Los trozos se guardan tal cual y se decodifican de una vez al
      // final. Decodificar trozo a trozo partía por la mitad cualquier
      // letra de dos bytes que cayera en el borde —una eñe, una tilde— y
      // la dejaba en dos rombos: «Muñoz» entraba a la base como «Mu??oz»,
      // sin vuelta atrás. El corte lo decide la red, no el cliente.
      const trozos: Buffer[] = [];
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
          trozos.length = 0;
          return;
        }
        trozos.push(chunk);
      });
      req.on('end', () => {
        if (tooLarge) return;

        const body = Buffer.concat(trozos).toString('utf8');
        // Sin esta comprobación, un navegador puede enviar text/plain sin
        // preflight y el servidor lo interpreta como JSON en operaciones de escritura.
        const tipoJson = /^application\/json(?:\s*;\s*charset\s*=\s*[^;\s]+)?\s*$/i;
        if (body && !tipoJson.test(req.headers['content-type'] ?? '')) {
          writeError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
          return;
        }
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
