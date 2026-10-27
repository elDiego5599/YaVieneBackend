import assert from 'node:assert/strict';
import { createServer, IncomingMessage, request } from 'node:http';
import test from 'node:test';
import jwt from 'jsonwebtoken';

process.env.JWT_SECRET = 'test-jwt-secret';
process.env.ADMIN_API_KEY = 'test-admin-key';

import { hashPin, verifyPin } from '../src/auth/passwords';
import { signToken, verifyToken } from '../src/auth/tokens';
import {
  adminRateLimiter,
  avisosRateLimiter,
  BloqueoPorCuenta,
  fleetWriteRateLimiter,
  loginIpRateLimiter,
  loginRateLimiter,
  readRateLimiter,
  requestKey,
  SlidingWindowRateLimiter,
} from '../src/security/rate_limiter';
import { hayIpv6 } from './red_pruebas';

function peticionFalsa(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
  return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

test('requestKey: X-Forwarded-For solo cuenta si la conexión viene del túnel en loopback', () => {
  // Desde internet la cabecera la escribe el cliente: si contara, cada
  // intento traería una IP inventada y un cupo nuevo.
  assert.equal(
    requestKey(peticionFalsa('203.0.113.5', { 'x-forwarded-for': '1.2.3.4' })),
    '203.0.113.5',
  );
  // Detrás de ngrok manda el último salto, el que añadió el túnel.
  assert.equal(
    requestKey(peticionFalsa('127.0.0.1', { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' }), 'read'),
    '1.2.3.4:read',
  );
});

test('requestKey: en Fly cuenta por Fly-Client-IP, y fuera de Fly la cabecera no vale nada', () => {
  const previo = process.env.FLY_APP_NAME;
  try {
    delete process.env.FLY_APP_NAME;
    assert.equal(
      requestKey(peticionFalsa('172.16.0.2', { 'fly-client-ip': '1.2.3.4' })),
      '172.16.0.2',
      'fuera de Fly cualquiera podría mandar la cabecera',
    );

    // En Fly todas las conexiones llegan desde el proxy: sin la cabecera,
    // dos pasajeros distintos compartían cupo.
    process.env.FLY_APP_NAME = 'yaviene-backend';
    assert.equal(
      requestKey(peticionFalsa('172.16.0.2', { 'fly-client-ip': '1.2.3.4' }), 'login'),
      '1.2.3.4:login',
    );
    assert.equal(
      requestKey(peticionFalsa('172.16.0.2', { 'fly-client-ip': '5.6.7.8' }), 'login'),
      '5.6.7.8:login',
    );
  } finally {
    if (previo === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = previo;
  }
});

// El servidor escucha en '::', así que una conexión IPv4 desde loopback no
// llega como '127.0.0.1' sino como '::ffff:127.0.0.1' (IPv4 mapeada). Si la
// comparación mira la cadena tal cual, el túnel deja de ser de confianza
// —se ignora X-Forwarded-For— y todos los que entren por él comparten una
// sola clave: 120 lecturas por minuto entre todas las apps.
test('requestKey: loopback IPv4 mapeado es el mismo túnel de confianza', () => {
  assert.equal(
    requestKey(peticionFalsa('::ffff:127.0.0.1', { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' }), 'read'),
    '1.2.3.4:read',
  );
  // Y sin cabecera, la clave va sin el prefijo: si no, el mismo cliente
  // ocupa dos cupos distintos según por dónde entre.
  assert.equal(requestKey(peticionFalsa('::ffff:203.0.113.5')), '203.0.113.5');
});

// Auditoría 2026-09, P2-2: un cliente IPv6 suele tener un /64 entero (2^64
// direcciones) y la clave era la dirección completa, así que cambiando de
// dirección en cada intento se estrenaba cupo: login, lecturas, sockets y
// el tope de conexiones MQTT anónimas. La clave de una IPv6 es su /64.
test('requestKey: una IPv6 cuenta por su /64, venga por el túnel, por Fly o directa', () => {
  const previo = process.env.FLY_APP_NAME;
  try {
    delete process.env.FLY_APP_NAME;
    const porTunel = (ip: string) =>
      requestKey(peticionFalsa('127.0.0.1', { 'x-forwarded-for': ip }), 'login');
    assert.equal(porTunel('2001:db8:aa:1::1'), porTunel('2001:db8:aa:1:ffff:ffff:ffff:fffe'),
      'dos direcciones del mismo /64 son el mismo cliente');
    assert.equal(porTunel('2001:0DB8:00aa:0001:0:0:0:7'), porTunel('2001:db8:aa:1::9'),
      'la forma de escribirla no cambia la clave');
    assert.notEqual(porTunel('2001:db8:aa:1::1'), porTunel('2001:db8:aa:2::1'),
      'otro /64 es otro cliente');
    assert.equal(porTunel('2001:db8:aa:1::1'), '2001:db8:aa:1::/64:login');

    // Directa, sin túnel (el servidor escucha en '::').
    assert.equal(requestKey(peticionFalsa('2001:db8:bb:3::10')), requestKey(peticionFalsa('2001:db8:bb:3::11')));

    process.env.FLY_APP_NAME = 'yaviene-backend';
    const porFly = (ip: string) =>
      requestKey(peticionFalsa('172.16.0.2', { 'fly-client-ip': ip }), 'read');
    assert.equal(porFly('2a02:6ea0:c000:1::1'), porFly('2a02:6ea0:c000:1::2'));
    assert.notEqual(porFly('2a02:6ea0:c000:1::1'), porFly('2a02:6ea0:c000:2::1'));
  } finally {
    if (previo === undefined) delete process.env.FLY_APP_NAME;
    else process.env.FLY_APP_NAME = previo;
  }
});

test('requestKey: las IPv4, mapeadas o no, siguen contando por dirección', () => {
  const porTunel = (ip: string) => requestKey(peticionFalsa('127.0.0.1', { 'x-forwarded-for': ip }));
  assert.equal(porTunel('203.0.113.7'), '203.0.113.7');
  assert.notEqual(porTunel('203.0.113.7'), porTunel('203.0.113.8'));
  // Una IPv4 mapeada es esa IPv4, no el /64 ::ffff:0:0, que juntaría a
  // todos los clientes IPv4 en un solo cupo.
  assert.equal(porTunel('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(porTunel('::ffff:cb00:7107'), '203.0.113.7');
  assert.notEqual(porTunel('::ffff:203.0.113.7'), porTunel('::ffff:203.0.113.8'));
  // El túnel en IPv6 (::1) sigue siendo de confianza: el /64 se calcula
  // sobre la clave, no antes de decidir si se cree a X-Forwarded-For.
  assert.equal(requestKey(peticionFalsa('::1', { 'x-forwarded-for': '198.51.100.4' })), '198.51.100.4');
  // Lo que no es una dirección se queda como está.
  assert.equal(porTunel('no-es-ip'), 'no-es-ip');
});

// La de arriba usa una petición construida a mano; esta comprueba contra un
// socket de verdad que el sistema produce esa forma, que es justo lo que la
// anterior da por supuesto. Vale para cualquiera de las dos formas: lo que
// se exige es que una conexión real por loopback sea de confianza.
// Donde el sistema no tiene IPv6 (el contenedor de la nube) listen(::)
// falla con EAFNOSUPPORT y el backend de esa máquina escucha en IPv4
// (HTTP_HOST): ahí la prueba escucha en '0.0.0.0' y el socket llega como
// '127.0.0.1', la otra forma, que también tiene que ser de confianza.
test('requestKey: socket real por loopback IPv4 contra listen(::), o 0.0.0.0 sin IPv6', async () => {
  const host = (await hayIpv6()) ? '::' : '0.0.0.0';
  const visto: { direccion?: string; clave?: string } = {};
  const server = createServer((req, res) => {
    visto.direccion = req.socket.remoteAddress ?? undefined;
    visto.clave = requestKey(req, 'read');
    res.end('ok');
  });
  await new Promise<void>((listo) => server.listen(0, host, listo));
  const { port } = server.address() as { port: number };
  try {
    await new Promise<void>((listo, falla) => {
      const req = request(
        {
          host: '127.0.0.1',
          port,
          family: 4,
          headers: { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' },
        },
        (res) => {
          res.resume();
          res.on('end', listo);
        },
      );
      req.on('error', falla);
      req.end();
    });
  } finally {
    await new Promise<void>((listo) => server.close(() => listo()));
  }
  assert.equal(
    visto.clave,
    '1.2.3.4:read',
    `el socket llegó como ${visto.direccion}, así que el túnel no contó como de confianza`,
  );
});

test('PIN hashing never validates the wrong PIN', () => {
  const hash = hashPin('2468');
  assert.notEqual(hash, '2468');
  assert.equal(verifyPin('2468', hash), true);
  assert.equal(verifyPin('0000', hash), false);
});

test('JWT validates canonical claims and rejects tampering', () => {
  const token = signToken({
    sub: 'driver-1',
    deviceId: 'driver-1',
    identifier: '3000000000',
    role: 'device',
    companyId: 'EMP-01',
    busId: 'BUS-WFK042',
    routeId: 'R-101',
    sessionId: 'session-1',
  });

  assert.equal(verifyToken(token)?.sessionId, 'session-1');
  assert.equal(verifyToken(`${token}tampered`), null);
});

test('JWT de equipo normaliza la identidad; rechaza el rol driver y claims incompletos', () => {
  const device = signToken({
    sub: 'device-1', deviceId: 'device-1', identifier: 'gps-001', role: 'device',
    companyId: 'EMP-01', busId: 'BUS-WFK042', routeId: 'R-101', sessionId: 'session-1',
  });
  const verifiedDevice = verifyToken(device);
  assert.equal(verifiedDevice?.role, 'device');
  assert.equal(verifiedDevice?.deviceId, 'device-1');
  assert.equal(verifiedDevice?.identifier, 'gps-001');
  assert.equal(verifiedDevice?.sessionId, 'session-1');

  const legacy = jwt.sign({
    sub: 'device-1', driverId: 'device-1', phoneNumber: 'gps-001', role: 'driver',
    companyId: 'EMP-01', busId: 'BUS-WFK042', routeId: 'R-101', sessionId: 'session-1',
  }, process.env.JWT_SECRET!, {
    algorithm: 'HS256', issuer: 'ya-viene-backend', audience: 'ya-viene-mqtt', expiresIn: '24h',
  });
  // No hay app de conductor: el token viejo con rol driver ya no entra.
  assert.equal(verifyToken(legacy), null);

  const incomplete = jwt.sign({ sub: 'device-1', role: 'device' }, process.env.JWT_SECRET!, {
    algorithm: 'HS256', issuer: 'ya-viene-backend', audience: 'ya-viene-mqtt', expiresIn: '24h',
  });
  assert.equal(verifyToken(incomplete), null);
});

// El token del panel lleva la versión de la credencial; uno emitido antes de
// que existiera no la trae y no debe seguir abriendo la flota.
test('JWT de panel sin versión de credencial no valida', () => {
  const admin = { sub: 'admin-1', role: 'admin', companyId: 'EMP-01', username: 'jefa' } as const;
  assert.equal(verifyToken(signToken({ ...admin, tv: 3 }))?.role, 'admin');
  assert.equal(verifyToken(signToken(admin as never)), null);
  assert.equal(verifyToken(signToken({ ...admin, tv: '3' } as never)), null);
});

test('rate limiter rejects after the configured window budget', () => {
  const limiter = new SlidingWindowRateLimiter(2, 60_000);
  assert.equal(limiter.allow('test-key'), true);
  assert.equal(limiter.allow('test-key'), true);
  assert.equal(limiter.allow('test-key'), false);
  assert.equal(limiter.allow('other-key'), true);
});

// Los topes son la política, no un detalle: el comentario de cada limitador
// en `rate_limiter.ts` explica su número. Sin fijarlos aquí, subir el de
// login de 5 a 6 o el de lectura de 120 a 121 pasaba la suite entera
// (auditoría 2026-09-27, R-05: F_R4 y F_R6 vivos). Cada fila prueba el
// último intento que entra, el primero que se rechaza y que la ventana de
// un minuto lo devuelve.
const TOPES: Array<[string, SlidingWindowRateLimiter, number]> = [
  ['login', loginRateLimiter, 5],
  ['loginIp', loginIpRateLimiter, 20],
  ['admin', adminRateLimiter, 20],
  ['read', readRateLimiter, 120],
  ['fleetWrite', fleetWriteRateLimiter, 60],
  ['avisos', avisosRateLimiter, 120],
];

for (const [nombre, limitador, tope] of TOPES) {
  test(`rate limiter ${nombre}: entran ${tope} por minuto y la siguiente se rechaza`, () => {
    const clave = `tope-${nombre}-${process.pid}`;
    const t0 = 1_000_000;
    for (let i = 1; i <= tope; i += 1) {
      assert.equal(limitador.allow(clave, t0), true, `la petición ${i} de ${tope} debe entrar`);
    }
    assert.equal(limitador.allow(clave, t0), false, `la petición ${tope + 1} debe dar 429`);
    assert.equal(limitador.allow(clave, t0 + 59_999), false, 'dentro del minuto sigue cerrado');
    assert.equal(limitador.allow(clave, t0 + 60_000), true, 'pasado el minuto vuelve a entrar');
  });
}

// P2-3: el bloqueo por cuenta, con el reloj en la mano. Lo que se prueba
// contra el backend (10 fallos desde IP distintas, 429 con Retry-After,
// otra cuenta sin enterarse) está en seguridad_p2.test.ts.
test('bloqueo por cuenta: diez fallos la cierran, y ni el PIN bueno entra mientras dure', () => {
  const minuto = 60_000;
  const hora = 60 * minuto;
  const bloqueo = new BloqueoPorCuenta(10, hora, 5 * minuto, 24 * hora);
  for (let i = 0; i < 9; i++) assert.equal(bloqueo.fallo('300', i), 0);
  assert.equal(bloqueo.restante('300', 9), 0, 'con 9 fallos todavía puede intentarlo');
  assert.equal(bloqueo.fallo('300', 10), 5 * minuto, 'el décimo la cierra, la primera vez 5 minutos');
  assert.equal(bloqueo.restante('300', 10), 5 * minuto);
  assert.equal(bloqueo.restante('301', 10), 0, 'otra cuenta no se entera');
  // Intentar durante el bloqueo no lo alarga: el login no llega a apuntar
  // fallos mientras dure, así que el reloj es el del fallo que lo cerró.
  assert.equal(bloqueo.restante('300', 10 + 2 * minuto), 3 * minuto);
  assert.equal(bloqueo.restante('300', 10 + 5 * minuto), 0, 'pasados los 5 minutos se abre');
  // Y se abre con la cuenta a cero, no a un fallo de volver a cerrarse.
  assert.equal(bloqueo.fallo('300', 11 + 5 * minuto), 0);
});

test('bloqueo por cuenta: cada bloqueo seguido dura el doble, hasta el tope', () => {
  const minuto = 60_000;
  const hora = 60 * minuto;
  const bloqueo = new BloqueoPorCuenta(10, hora, 5 * minuto, 24 * hora);
  // Diez fallos en cuanto se abre, una y otra vez: lo que hace quien adivina
  // y lo que hace un equipo mal configurado que reintenta en bucle.
  let t = 0;
  const duraciones: number[] = [];
  for (let i = 0; i < 12; i++) {
    let dura = 0;
    for (let f = 0; f < 10; f++) dura = bloqueo.fallo('300', t++);
    duraciones.push(dura / minuto);
    t += bloqueo.restante('300', t);
  }
  assert.deepEqual(duraciones, [5, 10, 20, 40, 80, 160, 320, 640, 1280, 1440, 1440, 1440]);
});

test('bloqueo por cuenta: la racha se olvida con un acierto, con un PIN nuevo o tras un día quieta', () => {
  const minuto = 60_000;
  const hora = 60 * minuto;
  const tope = 24 * hora;
  const cerrar = (b: BloqueoPorCuenta, cuenta: string, desde: number): number => {
    let dura = 0;
    for (let f = 0; f < 10; f++) dura = b.fallo(cuenta, desde + f);
    return dura;
  };
  const bloqueo = new BloqueoPorCuenta(10, hora, 5 * minuto, tope);

  // Dos bloqueos seguidos y luego un acierto: el siguiente vuelve a 5.
  assert.equal(cerrar(bloqueo, 'acierto', 0), 5 * minuto);
  assert.equal(cerrar(bloqueo, 'acierto', 5 * minuto + 10), 10 * minuto);
  bloqueo.acierto('acierto');
  assert.equal(cerrar(bloqueo, 'acierto', hora), 5 * minuto);

  // Quien administra da un PIN nuevo: bloqueo y racha fuera.
  assert.equal(cerrar(bloqueo, 'pin', 0), 5 * minuto);
  bloqueo.levantar('pin');
  assert.equal(bloqueo.restante('pin', 20), 0);
  assert.equal(cerrar(bloqueo, 'pin', 20), 5 * minuto);

  // Un día entero sin bloqueo desde que terminó el último: se olvida. Uno
  // menos, no: esperar a que se olvide cuesta lo mismo que el tope.
  assert.equal(cerrar(bloqueo, 'quieta', 0), 5 * minuto);
  assert.equal(cerrar(bloqueo, 'quieta', 5 * minuto + tope - 100), 10 * minuto);
  const fin = 5 * minuto + tope - 100 + 9 + 10 * minuto;
  assert.equal(cerrar(bloqueo, 'quieta', fin + tope), 5 * minuto);

  // El barrido quita la racha olvidada: la memoria no guarda cada teléfono
  // que alguien probó alguna vez.
  const otro = new BloqueoPorCuenta(10, hora, 5 * minuto, tope);
  cerrar(otro, 'x', 0);
  otro.sweep(5 * minuto + tope - 1);
  assert.equal(otro.size, 1, 'dentro del día sigue recordada');
  otro.sweep(9 + 5 * minuto + tope);
  assert.equal(otro.size, 0);
});

test('bloqueo por cuenta: los fallos viejos caducan y un acierto borra la cuenta', () => {
  const bloqueo = new BloqueoPorCuenta(3, 1000, 5000, 5000);
  bloqueo.fallo('a', 0);
  bloqueo.fallo('a', 1);
  assert.equal(bloqueo.fallo('a', 1500), 0, 'los de t=0 y t=1 ya salieron de la ventana');
  bloqueo.fallo('b', 0);
  bloqueo.fallo('b', 1);
  bloqueo.acierto('b');
  assert.equal(bloqueo.fallo('b', 2), 0, 'tras un acierto empieza de cero');
  assert.equal(bloqueo.fallo('b', 3), 0);
  assert.equal(bloqueo.fallo('b', 4), 5000);
  // El barrido quita lo que ya no cuenta: la memoria no crece con cada
  // teléfono que alguien prueba una vez.
  bloqueo.sweep(20_000);
  assert.equal(bloqueo.size, 0);
});
