// El payload de posición que publica el equipo GPS del bus, validado campo
// por campo antes de que nada lo toque.
//
// Antes cada campo se leía con `payload.x as number`: el `as` no comprueba
// nada, así que `heading` pasaba con el tipo que trajera —un texto, un
// objeto, 1e308— hasta SQLite y hasta la app del pasajero. Y un payload
// `null` (JSON válido) reventaba al leer `payload.sequence`: la excepción la
// tragaba el broker y el equipo se quedaba sin ack, reintentando.
//
// Las comprobaciones que ya existían van en el mismo orden y con los mismos
// motivos que en el manejador de index.ts, de donde salen: el equipo lee
// esos motivos en el ack.

export type SentidoRuta = 'ida' | 'venida';

export interface PosicionValidada {
  sequence: number;
  capturedAt: number;
  lat: number;
  lon: number;
  /** Sin ella el equipo aún puede publicar: la física calcula la suya. */
  speedKmh?: number;
  /** Grados en [0, 360). Uno fuera de rango se descarta, no tumba la posición. */
  heading?: number;
  sentido?: SentidoRuta;
}

export type ResultadoPayload =
  | { ok: true; posicion: PosicionValidada }
  | { ok: false; reason: string; sequence?: number };

export function validarPayloadPosicion(payload: unknown): ResultadoPayload {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: 'INVALID_PAYLOAD' };
  }
  const p = payload as Record<string, unknown>;
  const { sequence, capturedAt, lat, lon, speedKmh, heading, sentido } = p;

  if (p.protocolVersion !== 1) {
    return {
      ok: false,
      reason: 'UNSUPPORTED_PROTOCOL_VERSION',
      sequence: Number.isSafeInteger(sequence) ? sequence as number : undefined,
    };
  }
  if (!Number.isSafeInteger(sequence) || (sequence as number) < 1) {
    return { ok: false, reason: 'INVALID_SEQUENCE' };
  }
  const seq = sequence as number;
  if (!Number.isSafeInteger(capturedAt) || (capturedAt as number) < 1) {
    return { ok: false, sequence: seq, reason: 'INVALID_CAPTURE_TIME' };
  }
  if (
    typeof lat !== 'number' ||
    typeof lon !== 'number' ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < -90 ||
    lat > 90 ||
    lon < -180 ||
    lon > 180
  ) {
    return { ok: false, sequence: seq, reason: 'INVALID_COORDINATES' };
  }
  // El tope de 120 km/h no va aquí: es física y lo mira sanityCheck.
  if (
    speedKmh != null &&
    (typeof speedKmh !== 'number' || !Number.isFinite(speedKmh) || speedKmh < 0)
  ) {
    return { ok: false, sequence: seq, reason: 'INVALID_REPORTED_SPEED' };
  }

  const posicion: PosicionValidada = { sequence: seq, capturedAt: capturedAt as number, lat, lon };
  if (typeof speedKmh === 'number') posicion.speedKmh = speedKmh;
  if (typeof heading === 'number' && Number.isFinite(heading) && heading >= 0 && heading < 360) {
    posicion.heading = heading;
  }
  if (sentido === 'ida' || sentido === 'venida') posicion.sentido = sentido;
  return { ok: true, posicion };
}
