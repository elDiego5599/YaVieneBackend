"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handleAPI = handleAPI;
const buses_1 = require("../data/buses");
const handlers = [];
function addRoute(method, path, handler) {
    const paramNames = [];
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
});
addRoute('GET', '/api/companies', (_req, res) => {
    const companies = [
        { id: '1', name: 'Coolitoral S.A.' },
        { id: '2', name: 'Metrocaribe Ltda.' },
        { id: '3', name: 'Transcaribe S.A.S.' },
    ];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(companies));
});
addRoute('GET', '/api/companies/:id/routes', (_req, res, params) => {
    const allRoutes = {
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
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(routes));
});
addRoute('GET', '/api/routes/:routeId/positions', (_req, res, params) => {
    const { getPositionsByRoute } = require('../data/buses');
    const positions = getPositionsByRoute(params.routeId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ routeId: params.routeId, buses: positions }));
});
addRoute('GET', '/api/buses/:busId', (_req, res, params) => {
    const bus = (0, buses_1.getPosition)(params.busId);
    if (!bus) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Bus not found' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(bus));
});
addRoute('GET', '/api/drivers/:phone', (_req, res, params) => {
    const driver = (0, buses_1.getDriver)(params.phone);
    if (!driver) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Driver not found' }));
        return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(driver));
});
addRoute('POST', '/api/gps', (_req, res, _params, body) => {
    const { phoneNumber, busId, routeId, lat, lon, heading, speedKmh } = body || {};
    if (!phoneNumber || !busId || lat == null || lon == null) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Missing required fields' }));
        return;
    }
    const { upsertPosition } = require('../data/buses');
    const { broadcastBusPosition } = require('../socket/handler');
    const updated = upsertPosition(phoneNumber, { busId, routeId, lat, lon, heading, speedKmh });
    if (!updated) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Driver not registered' }));
        return;
    }
    broadcastBusPosition(updated);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(updated));
});
addRoute('POST', '/api/drivers/register', (_req, res, _params, body) => {
    const { phoneNumber, name, routeId } = body || {};
    if (!phoneNumber || !routeId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'phoneNumber and routeId required' }));
        return;
    }
    (0, buses_1.registerDriver)(String(phoneNumber), String(name || phoneNumber), String(routeId));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ phoneNumber, routeId, status: 'registered' }));
});
function handleAPI(req, res) {
    const url = req.url?.split('?')[0] || '';
    for (const h of handlers) {
        if (req.method !== h.method)
            continue;
        const match = url.match(h.pattern);
        if (!match)
            continue;
        const params = {};
        h.paramNames.forEach((name, i) => {
            params[name] = match[i + 1];
        });
        if (req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => { body += chunk.toString(); });
            req.on('end', () => {
                try {
                    h.handler(req, res, params, body ? JSON.parse(body) : {});
                }
                catch {
                    h.handler(req, res, params, {});
                }
            });
        }
        else {
            h.handler(req, res, params);
        }
        return true;
    }
    return false;
}
//# sourceMappingURL=routes.js.map