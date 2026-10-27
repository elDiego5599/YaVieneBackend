/** Decisión pura de visibilidad para rutas ordenadas como en SeguidorRuta. */
export type PuntoRuta = { lat: number; lon: number };
export type EstadoVisibilidad = {
  visible: boolean;
  rutaId: string;
  sentido?: 'ida' | 'venida';
  fraccionRecorrida?: number;
  fraccionAlOcultar?: number;
  muestrasQuieto: number;
  quietoDesde?: number;
  muestrasSalida: number;
  progresoSalida?: number;
};
export type EntradaVisibilidad = {
  busId: string;
  routeId?: string | null;
  lat: number;
  lon: number;
  speedKmh?: number;
  capturedAt: number;
  sentido?: 'ida' | 'venida' | null;
  geometria?: PuntoRuta[] | null;
};
export type ResultadoVisibilidad = {
  visible: boolean;
  estado: EstadoVisibilidad;
  motivo: 'visible' | 'en_terminal' | 'sin_ruta' | 'sin_terminal' | 'geometria_invalida' | 'sentido_desconocido';
  fraccionRecorrida?: number;
};

const RADIO_ENTRADA_M = 100;
const RADIO_SALIDA_M = 120;
const VELOCIDAD_QUIETO_KMH = 3;
const QUIETUD_MINIMA_MS = 1_000;
const MUESTRAS_QUIETO = 2;
const FRACCION_INICIO = 0.10;
const FRACCION_LLEGADA = 0.95;
const FRACCION_REENGANCHE = 0.002;
const FRACCION_PASO_MINIMO = 0.00001;
const TOLERANCIA_PROYECCION_M = 30;

function distancia(a: PuntoRuta, b: PuntoRuta): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12_742_000 * Math.asin(Math.sqrt(h));
}

type Proyeccion = { fraccion: number; metrosFuera: number };

/** Proyecta sobre cada segmento y elige el candidato continuo con el viaje anterior. */
function proyectar(p: PuntoRuta, ruta: PuntoRuta[], longitud: number, anterior?: number, sentido?: 'ida' | 'venida'): Proyeccion {
  const rad = Math.PI / 180;
  const candidatos: Proyeccion[] = [];
  let acumulado = 0;
  for (let i = 0; i < ruta.length - 1; i++) {
    const a = ruta[i];
    const b = ruta[i + 1];
    const tramo = distancia(a, b);
    if (tramo <= 0) continue;
    const lat0 = (a.lat + b.lat + p.lat) / 3 * rad;
    const escalaX = Math.cos(lat0);
    const ax = a.lon * rad * escalaX;
    const ay = a.lat * rad;
    const bx = b.lon * rad * escalaX;
    const by = b.lat * rad;
    const px = p.lon * rad * escalaX;
    const py = p.lat * rad;
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
    const proyectado = { lat: (ay + dy * t) / rad, lon: (ax + dx * t) / (rad * escalaX) };
    candidatos.push({
      fraccion: (acumulado + tramo * t) / longitud,
      metrosFuera: distancia(p, proyectado),
    });
    acumulado += tramo;
  }
  const minimo = Math.min(...candidatos.map((c) => c.metrosFuera));
  const cercanos = candidatos.filter((c) => c.metrosFuera <= minimo + TOLERANCIA_PROYECCION_M);
  cercanos.sort((x, y) => {
    if (anterior !== undefined) {
      const continuidad = Math.abs(x.fraccion - anterior) - Math.abs(y.fraccion - anterior);
      if (Math.abs(continuidad) > 0.00001) return continuidad;
    } else if (sentido) {
      const extremos = sentido === 'ida' ? x.fraccion - y.fraccion : y.fraccion - x.fraccion;
      if (Math.abs(extremos) > 0.00001) return extremos;
    }
    return x.metrosFuera - y.metrosFuera;
  });
  return cercanos[0];
}

/**
 * Para ocultar hace falta posición sobre la ruta y quietud en su tramo terminal.
 * El `estado` se conserva entre muestras; en arranque se reconstruye con la
 * posición actual y el sentido. Datos de ruta insuficientes fallan abiertos.
 */
export function decidirVisibilidadTerminal(
  entrada: EntradaVisibilidad,
  anterior?: EstadoVisibilidad,
): ResultadoVisibilidad {
  const routeId = entrada.routeId ?? '';
  const reset = !anterior || anterior.rutaId !== routeId;
  const base: EstadoVisibilidad = reset
    ? { visible: true, rutaId: routeId, muestrasQuieto: 0, muestrasSalida: 0 }
    : { ...anterior };
  const salida = (visible: boolean, motivo: ResultadoVisibilidad['motivo'], fraccion?: number): ResultadoVisibilidad => ({
    visible, estado: { ...base, visible }, motivo,
    ...(fraccion === undefined ? {} : { fraccionRecorrida: fraccion }),
  });
  if (!routeId) return salida(true, 'sin_ruta');
  if (!entrada.geometria || entrada.geometria.length < 2) return salida(true, 'sin_terminal');
  if (entrada.geometria.some((p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lon)
    || Math.abs(p.lat) > 90 || Math.abs(p.lon) > 180)) return salida(true, 'geometria_invalida');
  const sentidoConocido = entrada.sentido ?? base.sentido;
  const longitud = entrada.geometria.slice(1).reduce((suma, p, i) => suma + distancia(entrada.geometria![i], p), 0);
  if (!Number.isFinite(longitud) || longitud <= 0) return salida(true, 'geometria_invalida');
  const fraccionAnterior = reset || (sentidoConocido && base.sentido !== sentidoConocido)
    ? undefined
    : base.fraccionRecorrida;
  const proyeccion = proyectar(
    { lat: entrada.lat, lon: entrada.lon }, entrada.geometria, longitud, fraccionAnterior, sentidoConocido,
  );
  if (!proyeccion || !Number.isFinite(proyeccion.fraccion)) return salida(true, 'geometria_invalida');
  const fraccion = Math.max(0, Math.min(1, proyeccion.fraccion));
  const punto = { lat: entrada.lat, lon: entrada.lon };
  const terminalA = entrada.geometria[0];
  const terminalB = entrada.geometria[entrada.geometria.length - 1];
  const metrosA = distancia(punto, terminalA);
  const metrosB = distancia(punto, terminalB);
  let sentido = sentidoConocido;
  if (!sentido && base.fraccionRecorrida !== undefined) {
    const avance = fraccion - base.fraccionRecorrida;
    if (avance >= FRACCION_PASO_MINIMO) sentido = 'ida';
    else if (avance <= -FRACCION_PASO_MINIMO) sentido = 'venida';
  }
  if (!sentido && fraccion <= FRACCION_INICIO && metrosA <= RADIO_ENTRADA_M) sentido = 'ida';
  if (!sentido && fraccion >= FRACCION_LLEGADA && metrosB <= RADIO_ENTRADA_M) sentido = 'venida';
  if (!sentido) {
    const estadoSinSentido = { ...base, fraccionRecorrida: fraccion };
    return {
      visible: base.visible,
      estado: estadoSinSentido,
      motivo: 'sentido_desconocido',
      fraccionRecorrida: fraccion,
    };
  }
  const orientada = sentido === 'ida' ? fraccion : 1 - fraccion;
  const origen = sentido === 'ida' ? entrada.geometria[0] : entrada.geometria[entrada.geometria.length - 1];
  const destino = sentido === 'ida' ? entrada.geometria[entrada.geometria.length - 1] : entrada.geometria[0];
  const metrosAlOrigen = distancia(punto, origen);
  const metrosAlDestino = distancia(punto, destino);
  const quieto = (entrada.speedKmh ?? 0) <= VELOCIDAD_QUIETO_KMH;
  const siguiente: EstadoVisibilidad = {
    ...base,
    sentido,
    fraccionRecorrida: fraccion,
  };

  if (base.visible) {
    const tramoFinal = orientada >= FRACCION_LLEGADA;
    const tramoInicial = orientada <= FRACCION_INICIO;
    const terminal = tramoFinal || tramoInicial;
    const quietudConfirmable = ((tramoInicial && metrosAlOrigen <= RADIO_ENTRADA_M)
      || (tramoFinal && metrosAlDestino <= RADIO_ENTRADA_M)) && quieto;
    if (!quietudConfirmable) {
      siguiente.muestrasQuieto = 0;
      delete siguiente.quietoDesde;
      return { visible: true, estado: siguiente, motivo: 'visible', fraccionRecorrida: fraccion };
    }
    siguiente.quietoDesde ??= entrada.capturedAt;
    siguiente.muestrasQuieto += 1;
    const reinicioEnTerminal = reset && siguiente.muestrasQuieto >= 1;
    const confirmada = siguiente.muestrasQuieto >= MUESTRAS_QUIETO
      && entrada.capturedAt - siguiente.quietoDesde >= QUIETUD_MINIMA_MS;
    if (!reinicioEnTerminal && !confirmada) {
      return { visible: true, estado: siguiente, motivo: 'visible', fraccionRecorrida: fraccion };
    }
    siguiente.visible = false;
    siguiente.fraccionAlOcultar = orientada;
    siguiente.muestrasSalida = 0;
    delete siguiente.progresoSalida;
    return { visible: false, estado: siguiente, motivo: 'en_terminal', fraccionRecorrida: fraccion };
  }

  siguiente.muestrasQuieto = 0;
  delete siguiente.quietoDesde;
  const cambioSentido = base.sentido !== sentido;
  // Al relevar en el terminal opuesto, `fraccionAlOcultar` sigue expresada
  // desde el origen del viaje anterior. Reancla el umbral al primer punto
  // observado con el nuevo sentido; después exige dos fijaciones con avance.
  if (cambioSentido) siguiente.fraccionAlOcultar = orientada;
  // La terminal es el primer punto del recorrido: ocultarse al cerrar la
  // vuelta es estar al inicio de la siguiente.
  if (siguiente.fraccionAlOcultar !== undefined && siguiente.fraccionAlOcultar >= FRACCION_LLEGADA) {
    siguiente.fraccionAlOcultar = 0;
  }
  const referenciaSalida = siguiente.fraccionAlOcultar;
  if (referenciaSalida === undefined && orientada <= FRACCION_INICIO) {
    siguiente.fraccionAlOcultar = orientada;
  }
  const referenciaSalidaActualizada = siguiente.fraccionAlOcultar;
  const inicio = referenciaSalidaActualizada !== undefined
    && referenciaSalidaActualizada <= FRACCION_INICIO
    && orientada - referenciaSalidaActualizada >= FRACCION_REENGANCHE;
  const progresoDeSalida = inicio && metrosAlOrigen >= RADIO_SALIDA_M;
  if (!progresoDeSalida) {
    siguiente.muestrasSalida = 0;
    delete siguiente.progresoSalida;
  } else if (siguiente.muestrasSalida > 0 && siguiente.progresoSalida !== undefined
    && orientada - siguiente.progresoSalida >= FRACCION_PASO_MINIMO) {
    siguiente.muestrasSalida += 1;
    siguiente.progresoSalida = orientada;
    if (siguiente.muestrasSalida >= 2) siguiente.visible = true;
    if (siguiente.visible) {
      delete siguiente.fraccionAlOcultar;
      siguiente.muestrasSalida = 0;
      delete siguiente.progresoSalida;
    }
  } else {
    siguiente.muestrasSalida = 1;
    siguiente.progresoSalida = orientada;
  }
  return {
    visible: siguiente.visible,
    estado: siguiente,
    motivo: siguiente.visible ? 'visible' : 'en_terminal',
    fraccionRecorrida: fraccion,
  };
}
