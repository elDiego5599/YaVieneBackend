// ── Candado 3: Sanity check de física imposible ─────────────────────
import { dentroDeZona } from './zona';

export const MAX_SPEED_KMH = 120;
export const EARTH_RADIUS_KM = 6371;
export const MAX_CAPTURE_CLOCK_SKEW_MS = 30_000;
// Ventana de reloj en el pasado: permite reenvío de buffers offline (túneles
// sin señal, hasta 15 min), pero rechaza relojes manipulados más atrás.
export const MAX_PAST_CAPTURE_MS = 15 * 60 * 1000;

export function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineDistanceKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

export interface PhysicalPositionState {
  sessionId: string | null;
  lat: number;
  lon: number;
  capturedAt: number;
}

export interface SanityResult {
  accepted: boolean;
  reason?: string;
}

export function sanityCheck(
  busId: string,
  sessionId: string,
  previous: PhysicalPositionState | null | undefined,
  lat: number,
  lon: number,
  speedKmh: number,
  capturedAt: number,
): SanityResult {
  if (capturedAt > Date.now() + MAX_CAPTURE_CLOCK_SKEW_MS) {
    return { accepted: false, reason: 'FUTURE_CAPTURE_TIME' };
  }

  if (capturedAt < Date.now() - MAX_PAST_CAPTURE_MS) {
    return { accepted: false, reason: 'CLOCK_DRIFT_EXCEEDED' };
  }

  if (!Number.isFinite(speedKmh) || speedKmh < 0 || speedKmh > MAX_SPEED_KMH) {
    return { accepted: false, reason: 'INVALID_REPORTED_SPEED' };
  }

  // Antes de mirar si hay posición anterior: la primera de cada sesión
  // entraba sin más, y con ella un bus podía aparecer en cualquier parte del
  // mundo. La velocidad calculada solo compara contra la anterior.
  if (!dentroDeZona(lat, lon)) {
    return { accepted: false, reason: 'FUERA_DE_ZONA' };
  }

  if (!previous || previous.sessionId !== sessionId) {
    return { accepted: true };
  }

  if (capturedAt <= previous.capturedAt) {
    return { accepted: false, reason: 'OUT_OF_ORDER_CAPTURE' };
  }

  const elapsedSec = (capturedAt - previous.capturedAt) / 1000;
  if (elapsedSec <= 0) {
    return { accepted: false, reason: 'NO_CAPTURE_TIME_DELTA' };
  }

  const distanceKm = haversineDistanceKm(previous.lat, previous.lon, lat, lon);
  const calculatedSpeedKmh = (distanceKm / elapsedSec) * 3600;

  if (calculatedSpeedKmh > MAX_SPEED_KMH) {
    return { accepted: false, reason: 'SANITY_REJECTED' };
  }

  return { accepted: true };
}