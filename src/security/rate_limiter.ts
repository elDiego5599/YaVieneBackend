import { IncomingMessage } from 'http';
import { isIPv6 } from 'net';

import { setMetric } from '../observability/metrics';

/**
 * Limitador de ventana deslizante: el presupuesto se recupera a medida que
 * los intentos individuales salen de la ventana, así que no existe el borde
 * de ventana fija donde caben 2× maxRequests en dos segundos seguidos.
 *
 * La memoria está acotada por diseño:
 * - Cada clave guarda como máximo `maxRequests` marcas de tiempo.
 * - Un barrido periódico (cada `sweepEvery` llamadas a [allow], o manual
 *   con [sweep]) elimina las claves que llevan `windowMs` sin actividad.
 *   Sin él, detrás de un túnel donde cada visitante trae una IP distinta,
 *   el mapa crece para siempre.
 */
export class SlidingWindowRateLimiter {
  private readonly entries = new Map<string, number[]>();
  private callsSinceSweep = 0;

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number,
    private readonly sweepEvery = 64,
  ) {}

  allow(key: string, now: number = Date.now()): boolean {
    if (++this.callsSinceSweep >= this.sweepEvery) {
      this.callsSinceSweep = 0;
      this.sweep(now);
    }

    const hits = this.entries.get(key);
    const vivas = hits ? hits.filter((t) => now - t < this.windowMs) : [];
    if (vivas.length >= this.maxRequests) {
      // Conserva solo las vivas: las vencidas no vuelven a contar y no
      // deben ocupar sitio en el array.
      this.entries.set(key, vivas);
      return false;
    }
    vivas.push(now);
    this.entries.set(key, vivas);
    return true;
  }

  /** Elimina las claves sin actividad dentro de la ventana. Devuelve cuántas. */
  sweep(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, hits] of this.entries) {
      const vivas = hits.filter((t) => now - t < this.windowMs);
      if (vivas.length === 0) {
        this.entries.delete(key);
        removed += 1;
      } else if (vivas.length !== hits.length) {
        this.entries.set(key, vivas);
      }
    }
    return removed;
  }

  /** Olvida una clave al terminar su sesión, sin esperar al barrido. */
  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Claves actualmente recordadas (uso en tests y métricas). */
  get size(): number {
    return this.entries.size;
  }
}

// 5 logins por minuto por IP es generoso para una persona y frena el
// bombardeo de PIN; el admin mueve más (provisión, rutas, buses) y lleva 20.
export const loginRateLimiter = new SlidingWindowRateLimiter(5, 60_000);
// El de arriba cuenta por (IP, cuenta), así que quien prueba una cuenta
// distinta en cada intento estrena presupuesto cada vez: con una lista de
// teléfonos y el PIN '1234' se pueden barrer cientos de cuentas por minuto
// desde una sola IP sin tocar nunca el tope. Este segundo cuenta todos los
// intentos de una IP juntos y pone el techo a esa barrida. 20/min deja sitio
// a un teléfono compartido o a una oficina detrás de un NAT pequeño —cuatro
// personas equivocándose seguido— y aun así corta el barrido.
export const loginIpRateLimiter = new SlidingWindowRateLimiter(20, 60_000);
export const adminRateLimiter = new SlidingWindowRateLimiter(20, 60_000);
// Lecturas públicas: la app del pasajero refresca posiciones cada pocos
// segundos y el catálogo casi no cambia; 120/min por IP deja trabajar a la
// app y frena el scraping burdo sin tocar a quien la usa de verdad.
export const readRateLimiter = new SlidingWindowRateLimiter(120, 60_000);
// Cambios de flota que no tenían tope: visibilidad (de un bus o de todos),
// editar o borrar un bus y borrar una ruta. Van con token de empresa, así que
// no es un ataque de adivinanza, pero sin límite un token filtrado —o un
// script mal hecho— podía martillar escrituras en SQLite sin freno. 60/min
// deja a una persona ocultar treinta buses uno a uno sin tropezar.
export const fleetWriteRateLimiter = new SlidingWindowRateLimiter(60, 60_000);

/**
 * Avisos de «bus cerca» por push (`/api/avisos`). Una app con un aviso armado
 * late cada 20 s —3 por minuto— y arma o desarma de vez en cuando: 120 por
 * minuto y por IP alcanza para unas cuantas decenas de pasajeros detrás de la
 * misma IP del operador, como el tope de lecturas, y frena a quien quiera
 * llenar la tabla.
 */
export const avisosRateLimiter = new SlidingWindowRateLimiter(120, 60_000);

/**
 * Armar un aviso, aparte (AUD29-02). Con solo el tope de arriba una IP armaba
 * 120 por minuto y llenaba las `MAX_AVISOS` filas en hora y media, y con eso
 * nadie más podía armar uno. Cada aviso vive hasta 3 h: con 30 cada 10
 * minutos una IP sostiene como mucho unos 540 vivos, así que llenar la tabla
 * pide una veintena de IP. 30 deja de sobra a los pasajeros detrás de la
 * misma IP del operador (CGNAT): arman uno y lo cambian de vez en cuando. Solo
 * lo gasta un aviso válido que de verdad se va a armar.
 */
export const MAX_AVISOS_ARMADOS_POR_IP = 30;
export const avisosArmarRateLimiter = new SlidingWindowRateLimiter(MAX_AVISOS_ARMADOS_POR_IP, 10 * 60_000);

/**
 * El buzón de problemas y sugerencias (`POST /api/reportes`, D14). Un
 * pasajero escribe uno de vez en cuando: cinco cada diez minutos por IP deja
 * reportar a varios pasajeros detrás de la misma IP del operador y no deja
 * llenar el correo del equipo.
 */
export const reportesRateLimiter = new SlidingWindowRateLimiter(5, 10 * 60_000);

/**
 * La lista de «Avísame cuando salga» (`POST /api/lanzamiento`, D15). Una
 * persona deja su número una vez: cinco cada diez minutos por IP alcanzan
 * para una familia detrás del mismo router y no dejan llenar la lista.
 */
export const lanzamientoRateLimiter = new SlidingWindowRateLimiter(5, 10 * 60_000);
export const busquedasRateLimiter = new SlidingWindowRateLimiter(120, 60_000);
// D20: un viaje buscado es una intención rara (un toque en «Ir»); 30 cada 10 minutos por IP sobra para una persona y frena a quien infla.
export const viajesRateLimiter = new SlidingWindowRateLimiter(30, 10 * 60_000);

/**
 * Bloqueo temporal de una cuenta tras muchos fallos seguidos (auditoría
 * 2026-09, P2-3). Los topes de login cuentan por IP y por (IP, cuenta): quien
 * reparte los intentos contra un mismo teléfono entre muchas IP no tropieza
 * con ninguno, y el PIN del equipo puede ser de 4 dígitos. Éste cuenta los
 * fallos de la cuenta sola, sin IP: al llegar a `maxFallos` dentro de
 * `ventanaMs`, la cuenta queda cerrada, también para el PIN bueno —si no,
 * probar durante el bloqueo diría cuál es—.
 *
 * La espera crece: el primer bloqueo dura `bloqueoBaseMs` y cada uno que
 * le sigue sin un acierto en medio dura el doble, hasta `bloqueoTopeMs`. Así
 * una persona que se equivoca o un equipo recién mal configurado esperan
 * poco, y quien adivina se queda en el tope enseguida. La racha se olvida
 * con un acierto, cuando quien administra da un PIN nuevo (`levantar`) o
 * tras pasar `bloqueoTopeMs` sin bloqueo: esperar a que se olvide cuesta lo
 * mismo que el tope, así que no sirve para abaratar la adivinanza.
 *
 * Los intentos durante el bloqueo no lo alargan: quien lo provoca a
 * propósito solo consigue que el equipo espere, no dejarlo fuera para
 * siempre.
 *
 * La memoria está acotada igual que en [SlidingWindowRateLimiter]: como
 * mucho `maxFallos` marcas por cuenta, y un barrido quita las que ya no
 * tienen ni fallos vivos ni racha.
 */
export class BloqueoPorCuenta {
  private readonly fallos = new Map<string, number[]>();
  /** Bloqueos seguidos de cada cuenta y hasta cuándo dura el último. */
  private readonly rachas = new Map<string, { bloqueos: number; hasta: number }>();
  private llamadasDesdeBarrido = 0;

  constructor(
    private readonly maxFallos: number,
    private readonly ventanaMs: number,
    private readonly bloqueoBaseMs: number,
    private readonly bloqueoTopeMs: number,
    private readonly barrerCada = 64,
  ) {}

  /** Milisegundos que le quedan al bloqueo de `cuenta`, o 0 si puede intentarlo. */
  restante(cuenta: string, now: number = Date.now()): number {
    const hasta = this.rachas.get(cuenta)?.hasta ?? 0;
    return Math.max(0, hasta - now);
  }

  /** Apunta un fallo. Devuelve cuánto dura el bloqueo que cierra, o 0 si no cierra ninguno. */
  fallo(cuenta: string, now: number = Date.now()): number {
    if (++this.llamadasDesdeBarrido >= this.barrerCada) {
      this.llamadasDesdeBarrido = 0;
      this.sweep(now);
    }
    const vivos = (this.fallos.get(cuenta) ?? []).filter((t) => now - t < this.ventanaMs);
    vivos.push(now);
    if (vivos.length < this.maxFallos) {
      this.fallos.set(cuenta, vivos);
      return 0;
    }
    this.fallos.delete(cuenta);
    const anterior = this.rachas.get(cuenta);
    const bloqueos = anterior && now < anterior.hasta + this.bloqueoTopeMs ? anterior.bloqueos + 1 : 1;
    const dura = Math.min(this.bloqueoBaseMs * 2 ** (bloqueos - 1), this.bloqueoTopeMs);
    this.rachas.set(cuenta, { bloqueos, hasta: now + dura });
    return dura;
  }

  /** Un acierto: la cuenta empieza de cero, también la racha. */
  acierto(cuenta: string): void {
    this.fallos.delete(cuenta);
    this.rachas.delete(cuenta);
  }

  /** Quita fallos, bloqueo y racha: lo hace quien administra, al dar un PIN nuevo. */
  levantar(cuenta: string): void {
    this.acierto(cuenta);
  }

  sweep(now: number = Date.now()): void {
    for (const [cuenta, marcas] of this.fallos) {
      if (!marcas.some((t) => now - t < this.ventanaMs)) this.fallos.delete(cuenta);
    }
    for (const [cuenta, { hasta }] of this.rachas) {
      if (now >= hasta + this.bloqueoTopeMs) this.rachas.delete(cuenta);
    }
  }

  /** Cuentas recordadas, con fallos o con racha (métricas y pruebas). */
  get size(): number {
    return this.fallos.size + this.rachas.size;
  }
}

// 10 fallos en una hora cierran la cuenta. Un equipo bien configurado no
// falla nunca y una persona que teclea mal no llega a diez. El primer
// bloqueo es de 5 minutos y se dobla con cada uno seguido (5, 10, 20… min)
// hasta 24 horas, adonde se llega en el décimo. Quien adivina gasta sus
// primeros 100 intentos en unas 43 horas y de ahí sigue a 10 por día, así
// que barrer los 10 000 PIN de 4 dígitos pasa de minutos a más de dos años.
// Cada bloqueo queda en las métricas (`login.cuenta_bloqueada`).
//
// Los números se calibran con el equipo de verdad (D2): cuánto reintenta
// uno mal configurado dice si 5 minutos de entrada le bastan para que se
// note en el log antes de llegar al tope.
export const MAX_FALLOS_PIN_POR_CUENTA = 10;
export const VENTANA_FALLOS_PIN_MS = 60 * 60_000;
export const BLOQUEO_PIN_BASE_MS = 5 * 60_000;
export const BLOQUEO_PIN_TOPE_MS = 24 * 60 * 60_000;
export const deviceLoginLockout = new BloqueoPorCuenta(
  MAX_FALLOS_PIN_POR_CUENTA,
  VENTANA_FALLOS_PIN_MS,
  BLOQUEO_PIN_BASE_MS,
  BLOQUEO_PIN_TOPE_MS,
);

const LIMITADORES: Record<string, { readonly size: number }> = {
  login: loginRateLimiter,
  loginIp: loginIpRateLimiter,
  admin: adminRateLimiter,
  read: readRateLimiter,
  fleetWrite: fleetWriteRateLimiter,
  deviceLogin: deviceLoginLockout,
  avisos: avisosRateLimiter,
  avisosArmar: avisosArmarRateLimiter,
  reportes: reportesRateLimiter,
  lanzamiento: lanzamientoRateLimiter,
  busquedas: busquedasRateLimiter,
  viajes: viajesRateLimiter,
};

// La memoria de cada limitador está acotada por el barrido, pero nadie la
// veía: detrás de un túnel donde cada visitante trae una IP distinta, el
// número de claves es lo único que dice si el tráfico es el de siempre o un
// barrido desde muchas direcciones. 10 000 claves son unos pocos MB y muchas
// más IP de las que junta la demo en un minuto: pasar de ahí merece una
// línea en el log, no una alarma.
const AVISO_CLAVES = 10_000;
const yaAvisados = new Set<string>();

/**
 * Publica cuántas claves recuerda cada limitador (`ratelimit.<nombre>.claves`)
 * y avisa en el log cuando alguno pasa de [AVISO_CLAVES]. Avisa una vez por
 * subida y no en cada volcado: si se queda arriba media hora, son sesenta
 * líneas iguales que esconden las demás. Cuando baja, la siguiente subida
 * vuelve a avisar. Corre con el volcado de métricas (`index.ts`).
 */
export function registrarTamanosLimitadores(
  limitadores: Record<string, { readonly size: number }> = LIMITADORES,
  avisar: (mensaje: string) => void = console.warn,
): void {
  for (const [nombre, limitador] of Object.entries(limitadores)) {
    const claves = limitador.size;
    setMetric(`ratelimit.${nombre}.claves`, claves);
    if (claves <= AVISO_CLAVES) {
      yaAvisados.delete(nombre);
    } else if (!yaAvisados.has(nombre)) {
      yaAvisados.add(nombre);
      avisar(`[RateLimit] ${nombre} recuerda ${claves} claves (aviso desde ${AVISO_CLAVES}): mucho tráfico desde direcciones distintas`);
    }
  }
}

// Solo confiamos en X-Forwarded-For si la conexión TCP viene del túnel local
// (ngrok/cloudflared corren en loopback en este despliegue, confirmado con
// el inspector de ngrok en 127.0.0.1:4040). Si no, el cliente no puede fijar
// su propia key con una cabecera falsa.
const TRUSTED_PROXY_ADDRESSES = new Set(['127.0.0.1', '::1']);

// El servidor escucha en '::', así que una conexión IPv4 llega como IPv4
// mapeada en IPv6: '::ffff:127.0.0.1' es el mismo 127.0.0.1 de siempre. Sin
// quitar el prefijo, el túnel en loopback no se reconoce como de confianza
// —se ignora X-Forwarded-For— y todos los que entran por él comparten una
// sola clave. Solo se quita cuando lo que sigue tiene forma de IPv4: en una
// IPv6 legítima el mismo prefijo puede ir seguido de hexadecimal.
const IPV4_MAPEADA = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

function normalizarIp(direccion: string): string {
  const mapeada = IPV4_MAPEADA.exec(direccion);
  return mapeada ? mapeada[1] : direccion;
}

/** Los ocho grupos de 16 bits de una IPv6 válida (`isIPv6`), con o sin `::` y con o sin IPv4 al final. */
function gruposIpv6(direccion: string): number[] {
  const trozos = (parte: string): number[] => parte === '' ? [] : parte.split(':').flatMap((g) => {
    if (!g.includes('.')) return [parseInt(g, 16)];
    const [a, b, c, d] = g.split('.').map(Number);
    return [(a << 8) | b, (c << 8) | d];
  });
  const hueco = direccion.indexOf('::');
  if (hueco === -1) return trozos(direccion);
  const antes = trozos(direccion.slice(0, hueco));
  const despues = trozos(direccion.slice(hueco + 2));
  return [...antes, ...new Array(8 - antes.length - despues.length).fill(0), ...despues];
}

// Auditoría 2026-09, P2-2: un cliente IPv6 no tiene una dirección sino un
// /64 entero —2^64 direcciones, y el sistema operativo estrena una cada poco
// por privacidad—. Con la dirección completa de clave, cambiar de dirección
// en cada intento estrenaba cupo en todos los topes: login, lecturas,
// sockets y conexiones MQTT anónimas. El /64 es la unidad que un proveedor
// entrega a un cliente, así que es la que se cuenta. Una IPv4 mapeada, en
// cualquiera de sus dos formas, es esa IPv4: su /64 (::ffff:0:0) juntaría a
// todos los clientes IPv4 en un solo cupo.
function claveDeIp(direccion: string): string {
  const ip = normalizarIp(direccion);
  const sinZona = ip.split('%')[0];
  if (!isIPv6(sinZona)) return ip;
  const g = gruposIpv6(sinZona);
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
  }
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

export function requestKey(req: IncomingMessage, suffix = ''): string {
  // En Fly (el respaldo) no hay túnel en loopback: todo llega desde el
  // proxy de Fly por su red privada, así que la IP del socket era la del
  // proxy y TODOS los pasajeros compartían un único cupo —con 120 lecturas
  // por minuto para el país entero, el respaldo se ahogaba en cuanto la app
  // conmutaba a él. El proxy de Fly pone la IP real en Fly-Client-IP y
  // pisa la que mande el cliente; FLY_APP_NAME solo existe dentro de una
  // máquina de Fly, así que fuera de ella la cabecera no se mira.
  const flyClientIp = process.env.FLY_APP_NAME ? req.headers['fly-client-ip'] : undefined;
  if (typeof flyClientIp === 'string' && flyClientIp.trim()) {
    const ip = claveDeIp(flyClientIp.trim());
    return suffix ? `${ip}:${suffix}` : ip;
  }
  // La confianza en el túnel se decide con la dirección tal cual (sin /64):
  // '::1' es loopback, pero su /64 no lo es.
  const remota = normalizarIp(req.socket.remoteAddress ?? '');
  const trustedProxy = TRUSTED_PROXY_ADDRESSES.has(remota);
  const forwarded = trustedProxy ? req.headers['x-forwarded-for'] : undefined;
  const ip = typeof forwarded === 'string'
    ? forwarded.split(',').pop()!.trim() // último hop = el que agregó el proxy
    : remota || 'unknown';
  const clave = claveDeIp(ip);
  return suffix ? `${clave}:${suffix}` : clave;
}
