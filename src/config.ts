import { isIP } from 'node:net';
import { leerCredencialesFcm } from './push/fcm';
import { erroresDeCorreo } from './buzon/correo';

export const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3000', 10);
/**
 * Dónde escucha el HTTP. Por defecto '::': en doble pila acepta IPv4 e IPv6
 * a la vez (ver el comentario de `server.listen` en index.ts), y así se
 * queda en el Mac y en Fly. HTTP_HOST existe para las máquinas sin IPv6,
 * donde `listen('::')` falla con EAFNOSUPPORT: el contenedor de la nube en
 * el que corre la suite. Las pruebas escuchan en 127.0.0.1 (tests/entorno.ts).
 */
export function hostHttp(env: NodeJS.ProcessEnv = process.env): string {
  return env.HTTP_HOST || '::';
}
export const HTTP_HOST = hostHttp();
export const WS_PATH = process.env.WS_PATH || '/ws';
export const MQTT_PORT = parseInt(process.env.MQTT_PORT || '8883', 10);
// MQTT por TCP queda solo en loopback (pruebas locales). El acceso remoto
// es por WebSocket (wss) en el mismo servidor HTTP: /mqtt.
export const MQTT_HOST = process.env.MQTT_HOST || '127.0.0.1';
export const HTTP_TLS_CERT_PATH = process.env.HTTP_TLS_CERT_PATH;
export const HTTP_TLS_KEY_PATH = process.env.HTTP_TLS_KEY_PATH;
export const MQTT_TLS_CERT_PATH = process.env.MQTT_TLS_CERT_PATH;
export const MQTT_TLS_KEY_PATH = process.env.MQTT_TLS_KEY_PATH;

/**
 * Orígenes de navegador autorizados a llamar a la API (CORS), separados por
 * coma. Los clientes nativos (apps Flutter) no usan CORS y no se ven
 * afectados; esto solo gobierna qué páginas web pueden leer respuestas.
 * Sin la variable no se emite ningún header ACAO: ningún navegador cruzado
 * puede leer la API hasta que se autoricen orígenes explícitos.
 */
export const CORS_ORIGINS: string[] = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Revisa la configuración antes de arrancar. Hasta ahora solo se comprobaba
 * que JWT_SECRET existiera, y el resto de errores pasaba en silencio:
 *
 * - JWT_SECRET con solo espacios pasaba la guardia y firmaba tokens con un
 *   secreto trivial.
 * - Un certificado TLS sin su clave (o al revés) hacía que el servidor
 *   arrancara en HTTP plano sin decir nada, creyendo quien lo desplegó que
 *   iba cifrado. Lo mismo con el MQTT.
 * - Un origen CORS mal escrito (`https://sitio.co/`, con barra final) no
 *   coincide nunca con la cabecera Origin del navegador, y `*` no significa
 *   «todos» aquí sino un origen literal que nadie manda: la web quedaba sin
 *   acceso y nadie sabía por qué.
 * - Un puerto no numérico acababa en `listen(NaN)`.
 *
 * Devuelve errores (el arranque se detiene) y avisos (se imprimen y sigue).
 * Recibe el entorno como parámetro para poder probarlo sin arrancar nada.
 * Producción es `NODE_ENV=production` (lo pone el Dockerfile de Fly); el
 * arranque local con ngrok no la define y se revisa con criterio de
 * desarrollo, para no romper la demo.
 */
export function validateConfig(
  env: NodeJS.ProcessEnv = process.env,
): { errores: string[]; avisos: string[] } {
  const errores: string[] = [];
  const avisos: string[] = [];
  const produccion = env.NODE_ENV === 'production';
  // El backend del Mac detrás de ngrok da la cara a internet pero no es
  // producción: serlo abriría la red local (red_local.ts) y apagaría la
  // flota demo. YA_VIENE_EXPUESTO=1 (en local.env) le pone solo las
  // guardias de secretos y de CORS que un servidor expuesto necesita
  // (auditoría 2026-09, P2-4).
  const expuesto = produccion || env.YA_VIENE_EXPUESTO === '1';

  const jwtSecret = env.JWT_SECRET ?? '';
  if (!jwtSecret.trim()) {
    errores.push('JWT_SECRET es obligatorio y no puede estar vacío: arranca con local.env cargado');
  } else if (expuesto && jwtSecret.length < 32) {
    // Era un aviso, y un aviso se pierde en el log mientras el servidor
    // sigue firmando: con un secreto corto, quien vea un token puede probar
    // secretos sin conexión hasta dar con él y firmarse uno de admin.
    errores.push('JWT_SECRET tiene menos de 32 caracteres: en producción tiene que ser largo y aleatorio (64 recomendado)');
  }

  const adminKey = env.ADMIN_API_KEY;
  if (adminKey !== undefined && adminKey !== '' && !adminKey.trim()) {
    errores.push('ADMIN_API_KEY está definida pero solo tiene espacios');
  } else if (expuesto && !adminKey) {
    errores.push('ADMIN_API_KEY es obligatoria en producción');
  } else if (expuesto && adminKey && adminKey.length < 24) {
    avisos.push('ADMIN_API_KEY tiene menos de 24 caracteres; en producción conviene una larga y aleatoria');
  }

  for (const nombre of ['HTTP_PORT', 'MQTT_PORT']) {
    const valor = env[nombre];
    if (valor === undefined || valor === '') continue;
    const puerto = Number(valor);
    if (!Number.isInteger(puerto) || puerto < 1 || puerto > 65535) {
      errores.push(`${nombre} debe ser un puerto entre 1 y 65535 (llegó «${valor}»)`);
    }
  }

  // Solo una IP literal: un nombre (`localhost`) depende de cómo resuelva
  // cada máquina, que es justo el lío que '::' vino a cerrar. Y en producción
  // el proxy de Fly llega por la red privada: escuchando en loopback el
  // backend arranca sano y no le llega una sola petición.
  const httpHost = env.HTTP_HOST;
  if (httpHost !== undefined && httpHost !== '') {
    if (isIP(httpHost) === 0) {
      errores.push(`HTTP_HOST debe ser una IP (::, 0.0.0.0, 127.0.0.1…); llegó «${httpHost}»`);
    } else if (produccion && LOOPBACK_HOSTS.has(httpHost)) {
      errores.push(`HTTP_HOST=${httpHost} en producción deja el API fuera del alcance del proxy: sin la variable escucha en ::`);
    }
  }

  const httpTls = [env.HTTP_TLS_CERT_PATH, env.HTTP_TLS_KEY_PATH].filter(Boolean).length;
  if (httpTls === 1) {
    errores.push('HTTP_TLS_CERT_PATH y HTTP_TLS_KEY_PATH van juntas: con una sola el servidor arrancaría sin TLS');
  }
  // Por el HTTP pasan la contraseña del panel, el PIN del conductor y los
  // tokens: en claro los lee cualquiera en el camino. En producción el
  // servidor arrancaba sin TLS sin decir nada. Ahora hace falta una de dos:
  // el par de rutas TLS propio, o declarar con HTTP_TLS_EXTERNO=1 que el
  // cifrado lo termina un proxy delante (el de Fly con force_https, o el
  // túnel de ngrok) y a este proceso solo le llega tráfico desde ese proxy.
  // Es una variable explícita a propósito: servir sin TLS propio tiene que
  // ser una decisión escrita en el despliegue, no un olvido. El arranque
  // local con ngrok no es producción y no se ve afectado.
  if (produccion && httpTls === 0 && env.HTTP_TLS_EXTERNO !== '1') {
    errores.push('En producción el HTTP necesita TLS: HTTP_TLS_CERT_PATH y HTTP_TLS_KEY_PATH, o HTTP_TLS_EXTERNO=1 si lo termina un proxy delante (Fly, ngrok)');
  }
  const mqttTlsCount = [env.MQTT_TLS_CERT_PATH, env.MQTT_TLS_KEY_PATH].filter(Boolean).length;
  if (mqttTlsCount === 1) {
    errores.push('MQTT_TLS_CERT_PATH y MQTT_TLS_KEY_PATH van juntas: con una sola el MQTT arrancaría sin TLS');
  }

  const mqttHost = env.MQTT_HOST || '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(mqttHost) && mqttTlsCount !== 2) {
    const mensaje = `MQTT_HOST=${mqttHost} expone el MQTT por TCP fuera de esta máquina sin TLS`;
    if (produccion) errores.push(mensaje);
    else avisos.push(mensaje);
  }

  // Fuera de producción el API solo atiende a esta máquina (red_local.ts).
  // Abrirlo a la red es legítimo —probar desde un teléfono en la misma Wi-Fi
  // sin ngrok—, pero lo que viaje por ahí va en claro: que quede escrito en
  // el log del arranque, no que se olvide encendido.
  if (!produccion && env.HTTP_ALLOW_REMOTE === '1') {
    avisos.push('HTTP_ALLOW_REMOTE=1: el API atiende a toda la red local en HTTP plano, sin pasar por ngrok ni por TLS');
  }

  const origenes = (env.CORS_ORIGINS || '').split(',').map((o) => o.trim()).filter(Boolean);
  for (const origen of origenes) {
    let valido = false;
    try {
      valido = new URL(origen).origin === origen;
    } catch {
      valido = false;
    }
    if (!valido) {
      errores.push(`CORS_ORIGINS: «${origen}» no es un origen (esquema://host[:puerto], sin barra final ni comodines)`);
    } else if (expuesto && !origen.startsWith('https://')) {
      errores.push(`CORS_ORIGINS: «${origen}» no es https; en producción solo se autorizan orígenes cifrados`);
    }
  }

  // Los buses simulados registran conductores con un PIN y luego inician
  // sesión con él: hasta ahora el script traía «1234» por omisión. Con la
  // flota encendida, el PIN tiene que venir del entorno (local.env, o un
  // secreto en Fly: `fly secrets set PIN=…`, docs/runbook.md) — si falta,
  // es mejor no arrancar que levantar una flota con una credencial escrita
  // en el código.
  if (flotaDemoHabilitada(env) && !env.PIN) {
    errores.push(
      'PIN: la flota demo está encendida y el simulador necesita el PIN con el que registra e inicia sesión; define PIN= en el entorno (ya no hay «1234» por omisión)',
    );
  }

  // La flota demo recorre el catálogo de EMP-01 y EMP-03 (`flota_demo.ts`): sin la
  // siembra, en una base nueva no hay rutas y arranca sin un solo bus.
  if (flotaDemoHabilitada(env) && !siembraDemoHabilitada(env)) {
    avisos.push('flota demo encendida sin siembra (YA_VIENE_SEED_DEMO=0): en una base nueva no hay rutas de EMP-01 ni de EMP-03 que recorrer');
  }

  if (produccion && flotaDemoHabilitada(env)) {
    avisos.push('flota demo ENCENDIDA en producción (YA_VIENE_FLOTA_DEMO=1): los buses simulados publican en el mismo canal que los reales');
  }

  // Avisos con la app cerrada (D13). Una ruta mal escrita o un archivo que
  // no es la cuenta de servicio dejarían el push apagado sin decir nada
  // hasta el primer aviso: mejor no arrancar. El mensaje dice qué falta,
  // nunca lo que trae el archivo. Sin la variable el push está apagado a
  // propósito (Fly de respaldo, iOS sin cuenta de Apple) y lo dice el log
  // de arranque de index.ts, no un aviso.
  const credencialesFcm = env.YA_VIENE_FCM_CREDENCIALES;
  if (credencialesFcm) {
    try {
      leerCredencialesFcm(credencialesFcm);
    } catch (error) {
      errores.push(`YA_VIENE_FCM_CREDENCIALES: ${(error as Error).message}`);
    }
  }
  if (produccion && env.YA_VIENE_FCM_API) {
    avisos.push('YA_VIENE_FCM_API se ignora en producción: el push va siempre a fcm.googleapis.com');
  }

  // El buzón (D14). Sin la cuenta de correo los reportes esperan en la cola
  // y lo dice el log de arranque; con media cuenta, o una dirección mal
  // escrita, el buzón fallaría en cada vuelta: mejor no arrancar.
  errores.push(...erroresDeCorreo(env).map((e) => `Buzón: ${e}`));
  if (produccion && env.YA_VIENE_SMTP) {
    avisos.push('YA_VIENE_SMTP se ignora en producción: el buzón va siempre a smtp.gmail.com');
  }

  return { errores, avisos };
}

/**
 * Si arrancan los buses simulados. Antes estaban encendidos siempre que
 * nadie escribiera YA_VIENE_FLOTA_DEMO=0, también en producción: el día que
 * el backend lleve buses de verdad, un despliegue sin la variable mezclaba
 * posiciones inventadas con las reales en el mismo canal. Ahora en
 * producción vienen apagados y encenderlos es una línea escrita en el
 * despliegue (fly.toml). En desarrollo —el backend de ngrok— siguen
 * encendidos por defecto, que es lo que se enseña.
 */
export function flotaDemoHabilitada(env: NodeJS.ProcessEnv = process.env): boolean {
  const valor = env.YA_VIENE_FLOTA_DEMO ?? (env.NODE_ENV === 'production' ? '0' : '1');
  return valor !== '0';
}

/**
 * Si una base nueva nace con Sobusa (`EMP-01`) y su catálogo de rutas. La
 * siembra vivía dentro de las migraciones 9, 12 y 16 y corría en toda base
 * nueva: un despliegue para otra empresa arrancaba con Sobusa y sus seis
 * rutas en el selector del pasajero (T9.3, YV-13). Misma regla que la flota
 * demo: en desarrollo sí por defecto, en producción solo con
 * YA_VIENE_SEED_DEMO=1 escrito en el despliegue. Solo decide en bases que
 * aún no la tienen: las migraciones ya aplicadas no se tocan.
 */
export function siembraDemoHabilitada(env: NodeJS.ProcessEnv = process.env): boolean {
  const valor = env.YA_VIENE_SEED_DEMO ?? (env.NODE_ENV === 'production' ? '0' : '1');
  return valor !== '0';
}
