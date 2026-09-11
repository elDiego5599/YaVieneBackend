export const HTTP_PORT = parseInt(process.env.HTTP_PORT || '3000', 10);
export const WS_PATH = process.env.WS_PATH || '/ws';
export const MQTT_PORT = parseInt(process.env.MQTT_PORT || '8883', 10);
// MQTT por TCP queda solo en loopback (pruebas locales). El acceso remoto
// es por WebSocket (wss) en el mismo servidor HTTP: /mqtt.
export const MQTT_HOST = process.env.MQTT_HOST || '127.0.0.1';
export const HTTP_TLS_CERT_PATH = process.env.HTTP_TLS_CERT_PATH;
export const HTTP_TLS_KEY_PATH = process.env.HTTP_TLS_KEY_PATH;
export const MQTT_TLS_CERT_PATH = process.env.MQTT_TLS_CERT_PATH;
export const MQTT_TLS_KEY_PATH = process.env.MQTT_TLS_KEY_PATH;
export const BUS_TIMEOUT_MS = 30_000;

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

  const jwtSecret = env.JWT_SECRET ?? '';
  if (!jwtSecret.trim()) {
    errores.push('JWT_SECRET es obligatorio y no puede estar vacío: arranca con local.env cargado');
  } else if (produccion && jwtSecret.length < 32) {
    avisos.push('JWT_SECRET tiene menos de 32 caracteres; en producción conviene uno largo y aleatorio');
  }

  const adminKey = env.ADMIN_API_KEY;
  if (adminKey !== undefined && adminKey !== '' && !adminKey.trim()) {
    errores.push('ADMIN_API_KEY está definida pero solo tiene espacios');
  } else if (produccion && !adminKey) {
    errores.push('ADMIN_API_KEY es obligatoria en producción');
  } else if (produccion && adminKey && adminKey.length < 24) {
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
    } else if (produccion && !origen.startsWith('https://')) {
      errores.push(`CORS_ORIGINS: «${origen}» no es https; en producción solo se autorizan orígenes cifrados`);
    }
  }

  return { errores, avisos };
}
