// Tipos compartidos del dominio bus/posición. Viven aparte para que los
// stores de posiciones, flota y conductores puedan importarlos sin ciclos.
export interface BusPosition {
  busId: string;
  routeId: string;
  lat: number;
  lon: number;
  /** Grados en [0, 360); null si el bus no lo mandó o llegó fuera de rango. */
  heading: number | null;
  speedKmh: number;
  /** Sentido de marcha reportado por el bus: 'ida' | 'venida' | null. */
  sentido: 'ida' | 'venida' | null;
  timestamp: string;
  capturedAt: number;
  receivedAt: number;
  sequence: number | null;
  eventId?: string;
  driverPhone: string;
  companyId: string;
  isGhost: boolean;
  /** El bus es de la flota de ejemplo (`buses.is_demo`). Sale en la posición
   * pública: lo que la app calcule con él (la hora de llegada, D24) lleva
   * la etiqueta «Simulación». */
  simulado: boolean;
  /** Campo exclusivo del panel; nunca se incluye en la posición pública. */
  enTerminal?: boolean;
}

export interface FleetBus {
  busId: string;
  companyId: string;
  routeId: string | null;
  placa: string;
  interno: string;
  /** SENCILLO | PADRON | ARTICULADO. Lista cerrada: el aforo por % se
   * calibra por tipología y un texto libre la rompería. */
  tipologia: string;
  /** Aforo aprox. del bus (sentados + de pie). Lo pone el panel al dar de
   * alta el bus; cada bus lleva el suyo aunque comparta tipología. */
  capacidad: number;
  visible: boolean;
  /** Oculto automáticamente por estar quieto en el terminal de su ruta. */
  enTerminal: boolean;
  online: boolean;
  lat: number | null;
  lon: number | null;
  heading: number | null;
  speedKmh: number | null;
  sentido: 'ida' | 'venida' | null;
  capturedAt: number | null;
  receivedAt: number | null;
  sequence: number | null;
  isGhost: boolean;
}

export interface DriverInfo {
  driverId: string;
  phoneNumber: string;
  name: string;
  routeId: string;
  registeredAt: string;
  companyId: string | null;
  busId: string | null;
  pinHash: string | null;
}

export interface PositionValidationState {
  lat: number;
  lon: number;
  capturedAt: number;
  receivedAt: number;
  sequence: number | null;
  sessionId: string | null;
}

/** Fila cruda de la tabla positions (con el LEFT JOIN a buses cuando aplica). */
export interface PositionRow {
  bus_id: string;
  route_id: string;
  lat: number;
  lon: number;
  heading: number | null;
  speed_kmh: number;
  sentido: string | null;
  timestamp: number;
  device_id: string;
  session_id: string | null;
  captured_at: number | null;
  sequence: number | null;
  is_ghost: number;
  route_fraction?: number | null;
  route_direction?: string | null;
  bus_company_id?: string | null;
  bus_visible?: number | null;
}

export function normalizeSentido(raw: string | null | undefined): 'ida' | 'venida' | null {
  if (raw === 'ida' || raw === 'venida') return raw;
  return null;
}
