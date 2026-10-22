// La cookie del panel web solo vale para un token de panel. Nadie emite una
// cookie con el token del conductor, pero si alguien la arma a mano no debe
// abrirle las rutas del bus (`isDeviceForBus`): el equipo entra solo con
// `Authorization: Bearer`. En proceso, sin servidor.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { IncomingMessage } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const tmp = mkdtempSync(join(tmpdir(), 'yaviene-cookie-rol-'));
process.env.YA_VIENE_DB_PATH = join(tmp, 'test.db');
process.env.JWT_SECRET = randomBytes(32).toString('hex');

// require y no import: los módulos leen el env y abren la base al evaluarse.
const { authenticateRequest } = require('../src/auth/http') as typeof import('../src/auth/http');
const { signToken } = require('../src/auth/tokens') as typeof import('../src/auth/tokens');

test.after(() => rmSync(tmp, { recursive: true, force: true }));

const conductor = signToken({
  sub: 'd1', deviceId: 'd1', identifier: '+57800', role: 'device',
  companyId: 'EMP', busId: 'B1', routeId: 'R1', sessionId: 's1',
});
const panel = signToken({ sub: 'a1', role: 'admin', companyId: 'EMP', username: 'u', tv: 0 });

function peticion(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

test('la cookie no lleva el token del conductor', () => {
  assert.equal(authenticateRequest(peticion({ cookie: `yv_panel=${conductor}` })), null);
});

test('la cookie sí lleva el del panel, y el conductor sigue entrando con Bearer', () => {
  assert.equal(authenticateRequest(peticion({ cookie: `yv_panel=${panel}` }))?.role, 'admin');
  assert.equal(authenticateRequest(peticion({ authorization: `Bearer ${conductor}` }))?.role, 'device');
});
