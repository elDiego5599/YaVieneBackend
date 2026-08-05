import { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import {
  getDriver,
  getPosition,
  getPositionsByRoute,
  registerDriver,
  removePositionOwned,
  toPublicPosition,
} from '../data/buses';
import { authenticateRequest, isAdminRequest, isDriverForBus } from '../auth/http';
import { hashPin, verifyPin } from '../auth/passwords';
import { signToken } from '../auth/tokens';
import { createDriverSession, revokeSession, revokeSessionsForDriver } from '../data/sessions';
import { getMetrics } from '../observability/metrics';
import { adminRateLimiter, loginRateLimiter, requestKey } from '../security/rate_limiter';
import { getDb } from '../data/database';
import { isBrokerReady } from '../mqtt/broker';

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
  const companies = [
    { id: '1', name: 'Coolitoral S.A.' },
    { id: '2', name: 'Metrocaribe Ltda.' },
    { id: '3', name: 'Transcaribe S.A.S.' },
  ];
  writeJson(res, 200, companies);
});

addRoute('GET', '/api/companies/:id/routes', (_req, res, params) => {
  const allRoutes: Record<string, { id: string; name: string; companyId: string }[]> = {
    '1': [
      { id: '101', name: 'Ruta 1 - Centro/Soledad', companyId: '1' },
      { id: '102', name: 'Ruta 2 - Murillo/Terminal', companyId: '1' },
    ],
    '2': [
      { id: '201', name: 'Ruta 5 - Riomar/Abello', companyId: '2' },
    ],
    '3': [
      { id: '301', name: 'Troncal - Portal/Caribe', companyId: '3' },
    ],
  };
  const routes = allRoutes[params.id] ?? [];
  writeJson(res, 200, routes);
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
  if (!isDriverForBus(auth, params.busId)) {
    writeError(res, 403, 'BUS_FORBIDDEN', 'The token cannot control this bus');
    return;
  }

  const bus = getPosition(params.busId);
  if (!bus) {
    writeError(res, 404, 'BUS_NOT_FOUND', 'Bus not found');
    return;
  }
  removePositionOwned(params.busId, auth!.sessionId);
  revokeSession(auth!.sessionId);
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
  if (!isAdminRequest(req) && auth?.driverId !== driver.driverId) {
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
    driverId: phoneNumber,
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

    if (req.method === 'POST') {
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

        try {
          h.handler(req, res, params, parsedBody);
        } catch (error) {
          console.error('[HTTP] Handler error:', error);
          if (!res.headersSent) {
            writeError(res, 500, 'INTERNAL_ERROR', 'Internal server error');
          }
        }
      });
    } else {
      h.handler(req, res, params);
    }
    return true;
  }

  return false;
}
