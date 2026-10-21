/**
 * Simulador de bus para prueba E2E de Ya Viene.
 *
 * Modo de uso:
 *   node scripts/simulate-bus.mjs
 *
 * Requiere el backend corriendo (npm run dev).
 * Envía posiciones GPS cada 2 segundos recorriendo la geometría real
 * de la ruta (scripts/data/rutas.json, generado desde los KMZ de Sobusa).
 *
 * Variables: BUS_ID, ROUTE_ID, EMPRESA_ID, BACKEND_URL, PIN,
 *            ADMIN_API_KEY, CAPTURE_INTERVAL_MS (demo rápida: 400).
 */

import net, { isIP } from 'net';
import tls from 'tls';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const backendUrl = new URL(BACKEND_URL);
const hostBackendLocal = ['localhost', '127.0.0.1', '::1'].includes(backendUrl.hostname.replace(/^\[|\]$/g, '').toLowerCase());
if (!['http:', 'https:'].includes(backendUrl.protocol)) {
  throw new Error('BACKEND_URL debe usar http:// o https://');
}
if (backendUrl.protocol === 'http:' && !hostBackendLocal) {
  throw new Error('BACKEND_URL remoto debe usar https:// para proteger PIN y x-admin-key');
}
const MQTT_PORT = parseInt(process.env.MQTT_PORT || '8883', 10);
const BUS_ID = process.env.BUS_ID || 'BUS-ABC123';
const PHONE = process.env.PHONE || '3000000000';
const PIN = process.env.PIN;
if (!PIN) {
  console.error(
    'Falta PIN: el simulador registra al conductor con él y luego inicia sesión. '
    + 'Exporta PIN=… antes de lanzarlo (el backend de demo también lo exige al arrancar). '
    + 'Ya no hay «1234» por omisión.',
  );
  process.exit(1);
}
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const EMPRESA_ID = process.env.EMPRESA_ID || 'EMP-01';
const ROUTE_ID = process.env.ROUTE_ID || 'R-101';
const CAPTURE_INTERVAL_MS = parseInt(process.env.CAPTURE_INTERVAL_MS || '2000', 10);
const CAPTURE_BASE_LAG_MS = parseInt(process.env.CAPTURE_BASE_LAG_MS || '0', 10);
// Demo: arrancar en un punto del recorrido y en un sentido dados.
//   START_FRACTION=0..1 → posición inicial (0 = inicio, 1 = fin del recorrido)
//   SENTIDO=ida|venida  → sentido inicial (la variable cambia en los giros)
const START_FRACTION = Math.min(1, Math.max(0, parseFloat(process.env.START_FRACTION || '0')));
const INITIAL_SENTIDO = process.env.SENTIDO === 'venida' ? 'venida' : 'ida';

// Fallback (recorrido por la Calle 30) si no está rutas.json
const FALLBACK_WAYPOINTS = [
  { lat: 10.9630, lon: -74.8230 },
  { lat: 10.9635, lon: -74.8200 },
  { lat: 10.9640, lon: -74.8170 },
  { lat: 10.9645, lon: -74.8140 },
  { lat: 10.9648, lon: -74.8110 },
  { lat: 10.9650, lon: -74.8080 },
  { lat: 10.9652, lon: -74.8050 },
  { lat: 10.9650, lon: -74.8020 },
  { lat: 10.9648, lon: -74.7990 },
  { lat: 10.9655, lon: -74.7960 },
];

let WAYPOINTS = FALLBACK_WAYPOINTS;
let ROUTE_NAME = ROUTE_ID;
try {
  const payload = JSON.parse(readFileSync(join(SCRIPT_DIR, 'data', 'rutas.json'), 'utf8'));
  const ruta = payload.rutas.find((r) => r.routeId === ROUTE_ID);
  if (ruta && ruta.waypoints.length >= 2) {
    WAYPOINTS = ruta.waypoints;
    ROUTE_NAME = ruta.name;
    console.log(`[RUTA] Geometría real cargada: ${ruta.name} (${ruta.waypoints.length} pts, ${ruta.lengthKm} km)`);
  }
} catch {
  console.log('[RUTA] rutas.json no encontrado, usando recorrido de respaldo');
}

function headingBetween(a, b) {
  const dLat = b.lat - a.lat;
  const dLon = b.lon - a.lon;
  return (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
}

function haversineMeters(a, b) {
  const R = 6371000;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLon = ((b.lon - a.lon) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Longitud de cada tramo real del recorrido (sin el segmento artificial de
// cierre último→primero). En ida el bus "da la vuelta" saltando del final al
// inicio; en venida recorre los mismos tramos en sentido contrario.
const SEG_LENGTHS = [];
for (let i = 0; i < WAYPOINTS.length - 1; i++) {
  SEG_LENGTHS.push(haversineMeters(WAYPOINTS[i], WAYPOINTS[i + 1]));
}
const TOTAL_LENGTH_M = SEG_LENGTHS.reduce((acc, len) => acc + len, 0);

let step = 0;
let sequence = 0;
let simulatedCapturedAt = Date.now() - CAPTURE_BASE_LAG_MS;
let token = '';
let mqttClient = null;

// El reloj del bus tiene que seguir al reloj real. Avanzaba exactamente
// CAPTURE_INTERVAL_MS por posición, pero cada vuelta del setInterval tarda
// más que eso —publicar, escribir el registro, el propio event loop—, así
// que el reloj simulado se atrasaba como medio segundo por cada segundo
// real. A la media hora el atraso pasaba de los 15 minutos que admite el
// backend (MAX_PAST_CAPTURE_MS) y a partir de ahí RECHAZABA todas las
// posiciones con CLOCK_DRIFT_EXCEEDED: el simulador seguía anunciando
// posiciones en su registro, la base no guardaba ninguna, y en las dos apps
// el bus salía "sin señal" para siempre. Era el motivo real de que los buses
// simulados "no funcionaran".
//
// Sigue avanzando a pasos parejos de CAPTURE_INTERVAL_MS —el backend deduce
// la velocidad de ese delta y las medidas irregulares lo alteran— pero nunca
// se le deja quedar más de un paso por detrás de la hora real.
function siguienteCapturedAt() {
  const real = Date.now() - CAPTURE_BASE_LAG_MS;
  if (simulatedCapturedAt < real - CAPTURE_INTERVAL_MS) simulatedCapturedAt = real;
  const capturedAt = simulatedCapturedAt;
  simulatedCapturedAt += CAPTURE_INTERVAL_MS;
  return capturedAt;
}

// El backend contesta cada posición por el tópico /ack diciendo si la aceptó.
// Antes se imprimían todas —un renglón cada 400 ms— y el rechazo quedaba
// enterrado entre miles de líneas iguales. Ahora solo se anuncia el cambio de
// estado, y si el backend rechaza sin parar el simulador se rinde: matarse es
// lo único que lo arregla, porque quien lo vigila lo vuelve a levantar limpio
// y con el reloj recién puesto en hora. Aguantar publicando en el vacío es lo
// que dejaba los buses en "sin señal" el resto de la tarde.
const MAX_RECHAZOS_SEGUIDOS = 25;
let rechazosSeguidos = 0;
let ultimoAckOk = null;

function anotarAck(payload) {
  let ack;
  try {
    ack = JSON.parse(payload);
  } catch {
    console.log(`[MQTT] ACK ilegible: ${payload.slice(0, 120)}`);
    return;
  }

  if (ack.accepted !== false) {
    if (ultimoAckOk !== true) console.log(`[MQTT] ✓ ${BUS_ID}: el backend está aceptando las posiciones`);
    ultimoAckOk = true;
    rechazosSeguidos = 0;
    return;
  }

  rechazosSeguidos++;
  if (ultimoAckOk !== false) {
    console.error(`[MQTT] ✗ ${BUS_ID}: el backend RECHAZA las posiciones (${ack.reason}) — no se guarda ninguna`);
  }
  ultimoAckOk = false;

  if (rechazosSeguidos >= MAX_RECHAZOS_SEGUIDOS) {
    console.error(`[MQTT] ✗ ${BUS_ID}: ${rechazosSeguidos} rechazos seguidos (${ack.reason}); me reinicio`);
    process.exit(1);
  }
}

async function postJson(path, payload, extraHeaders = {}) {
  const respuesta = await fetch(new URL(path, BACKEND_URL), {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(payload),
  });
  const texto = await respuesta.text();
  try {
    return { statusCode: respuesta.status, body: JSON.parse(texto) };
  } catch {
    throw new Error(`Respuesta JSON invalida: ${texto}`);
  }
}

async function registerDriver() {
  if (!ADMIN_API_KEY) {
    throw new Error('ADMIN_API_KEY es obligatorio para provisionar el simulador');
  }

  const registration = await postJson('/api/drivers/register', {
    phoneNumber: PHONE,
    name: `Conductor ${PHONE}`,
    pin: PIN,
    busId: BUS_ID,
    routeId: ROUTE_ID,
    companyId: EMPRESA_ID,
  }, { 'x-admin-key': ADMIN_API_KEY });

  if (registration.statusCode !== 201) {
    throw new Error(`Registro fallo: ${JSON.stringify(registration.body)}`);
  }

  await renovarToken();
  console.log(`[REGISTER] Conductor ${PHONE} provisionado y autenticado. JWT obtenido.`);
}

/**
 * Pide un JWT nuevo.
 *
 * El broker solo mira el token en el CONNECT, así que una conexión ya
 * abierta sobrevive a su propia caducidad; el problema era el reintento.
 * El token dura 24 h y el simulador guardaba el primero para siempre: al
 * caerse el MQTT pasado ese día, cada reconexión volvía con un token
 * vencido, el broker la rechazaba, y el bus quedaba vivo y mudo —proceso en
 * pie, así que ningún vigilante lo levantaba— hasta salir "sin señal" en
 * las dos apps. Una flota entera podía morirse así de un día para otro.
 */
async function renovarToken() {
  const login = await postJson('/api/auth/login', {
    phoneNumber: PHONE,
    pin: PIN,
    busId: BUS_ID,
    routeId: ROUTE_ID,
  });

  if (login.statusCode !== 200 || !login.body.token) {
    throw new Error(`Login fallo: ${JSON.stringify(login.body)}`);
  }

  token = login.body.token;
}

async function connectMQTTWithAuth() {
  return new Promise((resolve, reject) => {
    const host = backendUrl.hostname.replace(/^\[|\]$/g, '');
    const conectar = backendUrl.protocol === 'https:'
      ? tls.connect({ host, port: MQTT_PORT, ...(isIP(host) ? {} : { servername: host }) })
      : net.createConnection({ host, port: MQTT_PORT });
    const client = conectar;
    client.once(backendUrl.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
      console.log(`[MQTT] Conectado a ${host}:${MQTT_PORT}`);
      mqttClient = client;
      resolve();
    });

    // Si la conexión se cae (túnel, red), se reconecta solo: sin esto el
    // bus quedaba mudo para siempre y "se congelaba" en el mapa del pasajero
    // hasta volverse "sin señal" tras 5 minutos.
    client.on('close', () => {
      console.log('[MQTT] Desconectado — reconectando en 3s...');
      mqttClient = null;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(ensureReconnected, 3000);
    });

    const ackTopic = `empresa/${EMPRESA_ID}/bus/${BUS_ID}/ack`;
    const ackTopicBuf = Buffer.from(ackTopic);
    const ackPacket = Buffer.concat([
      Buffer.from([0x82, 2 + 2 + ackTopicBuf.length + 1]),
      Buffer.from([0x00, 0x01]),
      Buffer.from([0x00, ackTopicBuf.length]),
      ackTopicBuf,
      Buffer.from([0x01]),
    ]);
    let incoming = Buffer.alloc(0);

    client.on('data', (data) => {
      incoming = Buffer.concat([incoming, data]);
      while (incoming.length >= 2) {
        let multiplier = 1;
        let remaining = 0;
        let index = 1;
        let encoded;
        do {
          if (index >= incoming.length) return;
          encoded = incoming[index++];
          remaining += (encoded & 0x7f) * multiplier;
          multiplier *= 128;
        } while (encoded & 0x80);

        const packetLength = index + remaining;
        if (incoming.length < packetLength) return;

        const packet = incoming.subarray(0, packetLength);
        incoming = incoming.subarray(packetLength);
        const firstByte = packet[0] & 0xf0;
        if (firstByte === 0x20) {
          console.log('[MQTT] ✓ CONNACK recibido');
          client.write(ackPacket);
        } else if (firstByte === 0x30) {
          const topicLength = packet.readUInt16BE(index);
          const topicStart = index + 2;
          const topicEnd = topicStart + topicLength;
          const payload = packet.subarray(topicEnd).toString();
          anotarAck(payload);
        } else if (firstByte !== 0x90) {
          console.log('[MQTT] ←', packet.toString('hex').substring(0, 80));
        }
      }
    });

    client.on('error', (err) => {
      console.error('[MQTT] Error:', err.message);
      reject(err);
    });

    // Enviar CONNECT packet con JWT como password
    const clientId = `sim_${BUS_ID}_${Date.now()}`;
    const clientIdBuf = Buffer.from(clientId);
    const usernameBuf = Buffer.from(PHONE);
    const passwordBuf = Buffer.from(token);

    // Calcular remaining length
    const protocolName = Buffer.from('MQTT');
    const protocolLevel = 4; // MQTT 3.1.1
    const connectFlags = 0xC2; // Clean Session + Username + Password
    const keepAlive = 60;

    let remaining =
      2 + protocolName.length + // protocol name length + name
      1 +                       // protocol level
      1 +                       // connect flags
      2 +                       // keep alive
      2 + clientIdBuf.length;   // client id

    if (connectFlags & 0x80) {
      remaining += 2 + usernameBuf.length; // username
    }
    if (connectFlags & 0x40) {
      remaining += 2 + passwordBuf.length; // password
    }

    const remainingBuf = remaining < 128
      ? Buffer.from([remaining])
      : Buffer.from([(remaining & 0x7f) | 0x80, remaining >> 7]);

    const passwordLength = Buffer.alloc(2);
    passwordLength.writeUInt16BE(passwordBuf.length);

    const packet = Buffer.concat([
      Buffer.from([0x10]),                                                      // CONNECT
      remainingBuf,                                                              // remaining length
      Buffer.from([0x00, protocolName.length]),                                  // protocol name length
      protocolName,                                                              // "MQTT"
      Buffer.from([protocolLevel]),                                              // protocol level
      Buffer.from([connectFlags]),                                               // connect flags
      Buffer.from([0x00, keepAlive]),                                            // keep alive
      Buffer.from([0x00, clientIdBuf.length]), clientIdBuf,                      // client id
      Buffer.from([0x00, usernameBuf.length]), usernameBuf,                      // username
      passwordLength, passwordBuf,                                               // password
    ]);

    client.write(packet);
  });
}

let reconnectTimer = null;

async function ensureReconnected() {
  // El temporizador que nos trajo hasta aquí ya se disparó, así que deja de
  // estar pendiente. Sin esta línea el guardia de abajo leía el identificador
  // viejo —`clearTimeout` no lo borra, solo cancela— y se devolvía a sí mismo
  // en la primera vuelta: el bus quedaba vivo pero mudo para siempre. Es
  // exactamente lo que pasó al reiniciar el backend, y desde el vigilante no
  // se ve, porque el proceso sigue en pie.
  reconnectTimer = null;
  if (mqttClient) return;
  try {
    // Token fresco en cada reintento: el guardado puede llevar horas ahí.
    await renovarToken();
    await connectMQTTWithAuth();
    console.log(`[MQTT] ${BUS_ID} reconectado`);
  } catch (err) {
    console.error(`[MQTT] Reconexión falló (${err.message}); reintento en 5s`);
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(ensureReconnected, 5000);
  }
}

async function publishPositionWithAuth(lat, lon, heading, speedKmh, sentido) {
  // Sin conexión no hay nada que publicar, y quien llame tiene que saberlo:
  // el registro anunciaba la posición igual, así que un bus desconectado se
  // leía idéntico a uno sano mientras la base no recibía nada.
  if (!mqttClient) return false;

  const topic = `empresa/${EMPRESA_ID}/bus/${BUS_ID}/posicion`;
  const payload = JSON.stringify({
    protocolVersion: 1,
    lat,
    lon,
    heading,
    speedKmh,
    sentido,
    capturedAt: siguienteCapturedAt(),
    sequence: ++sequence,
  });

  const topicBuf = Buffer.from(topic);
  const payloadBuf = Buffer.from(payload);

  // PUBLISH packet (QoS 0)
  const remainingLen = 2 + topicBuf.length + payloadBuf.length;
  const remainingBuf = remainingLen < 128
    ? Buffer.from([remainingLen])
    : Buffer.from([(remainingLen & 0x7f) | 0x80, remainingLen >> 7]);

  const topicLen = Buffer.alloc(2);
  topicLen.writeUInt16BE(topicBuf.length);

  const packet = Buffer.concat([
    Buffer.from([0x30]),  // PUBLISH
    remainingBuf,
    topicLen,
    topicBuf,
    payloadBuf,
  ]);

  return new Promise((resolve) => {
    mqttClient.write(packet, () => resolve(true));
  });
}

async function run() {
  try {
    console.log('══════════════════════════════════════════');
    console.log('  YA VIENE — Simulador de Bus');
    console.log(`  Bus: ${BUS_ID} | Ruta: ${ROUTE_ID}`);
    console.log(`  Backend: ${BACKEND_URL}`);
    console.log('══════════════════════════════════════════\n');

    // 1. Registrar conductor y obtener JWT
    await registerDriver();

    // 2. Conectar MQTT con JWT
    await connectMQTTWithAuth();

    // 3. Publicar posiciones interpolando sobre la geometría real
    console.log(`\n[LOOP] ${BUS_ID} recorriendo ${ROUTE_NAME} (${ROUTE_ID}, ${(TOTAL_LENGTH_M / 1000).toFixed(1)} km) cada ${CAPTURE_INTERVAL_MS} ms...\n`);
    // La variable `sentido` cambia en los puntos de giro (terminales): el bus
    // hace el recorrido de ida, gira en el final y regresa de venida; al
    // volver al inicio gira de nuevo. Esa variable viaja en cada posición.
    let sentido = INITIAL_SENTIDO;
    let progress = START_FRACTION * TOTAL_LENGTH_M;
    // Si arranca de venida, queda "bajando" desde su fracción de inicio.
    if (sentido === 'venida') progress = TOTAL_LENGTH_M - progress;
    setInterval(async () => {
      const dt = CAPTURE_INTERVAL_MS / 1000;
      // Velocidad constante: evita que el ETA de la app salte con la variación.
      const speedKmh = 35;
      const distM = (speedKmh / 3.6) * dt;
      progress += sentido === 'ida' ? distM : -distM;
      if (progress >= TOTAL_LENGTH_M) {
        progress = 2 * TOTAL_LENGTH_M - progress;
        sentido = 'venida';
      } else if (progress <= 0) {
        progress = -progress;
        sentido = 'ida';
      }

      let acc = 0;
      let seg = 0;
      while (acc + SEG_LENGTHS[seg] <= progress) {
        acc += SEG_LENGTHS[seg];
        seg++;
      }
      const t = (progress - acc) / SEG_LENGTHS[seg];
      const a = WAYPOINTS[seg];
      const b = WAYPOINTS[seg + 1];
      const lat = a.lat + (b.lat - a.lat) * t + (Math.random() - 0.5) * 0.00004;
      const lon = a.lon + (b.lon - a.lon) * t + (Math.random() - 0.5) * 0.00004;
      // De venida el bus se mueve de b hacia a: el rumbo se invierte.
      const heading = sentido === 'venida'
        ? headingBetween(b, a)
        : headingBetween(a, b);

      const publicada = await publishPositionWithAuth(lat, lon, heading, speedKmh, sentido);

      const now = new Date().toLocaleTimeString();
      if (publicada) {
        console.log(`[${now}] ${BUS_ID} → (${lat.toFixed(5)}, ${lon.toFixed(5)}) ${speedKmh.toFixed(0)} km/h rumbo ${heading.toFixed(0)}° · ${sentido.toUpperCase()}`);
      } else if (step % 25 === 0) {
        console.log(`[${now}] ${BUS_ID} sin conexión MQTT — la posición no salió a ningún lado`);
      }

      step++;
    }, CAPTURE_INTERVAL_MS);

  } catch (err) {
    console.error('[FATAL]', err.message);
    process.exit(1);
  }
}

run();
