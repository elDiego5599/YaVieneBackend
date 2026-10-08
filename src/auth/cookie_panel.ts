import { IncomingHttpHeaders } from 'http';
import { CORS_ORIGINS } from '../config';
import { ADMIN_TOKEN_TTL_S } from './tokens';

/**
 * La sesión del panel cuando corre en el navegador.
 *
 * En el escritorio el token vive en el llavero y viaja como `Bearer`. En el
 * navegador tendría que vivir en el almacenamiento de la página, y ahí
 * cualquier script inyectado se lleva la llave de toda la flota. Por eso en
 * web el token va en esta cookie: HttpOnly (la página no la lee), Secure y
 * SameSite=Strict (otro sitio no la hace viajar). Strict exige que el panel
 * se sirva desde el mismo sitio que la API; ngrok-free.dev está en la
 * Public Suffix List, así que dos subdominios suyos son sitios distintos.
 */
export const COOKIE_PANEL = 'yv_panel';

/**
 * Si la petición viene de una página del panel: una autorizada en
 * CORS_ORIGINS (esa lista es de orígenes del panel web y nada más: uno que
 * entre ahí puede iniciar la sesión del panel y escribir con su cookie), o
 * una del mismo origen que la API, que es el panel servido en /panel/
 * (`api/panel_web.ts`): este servidor no da ninguna otra página. El
 * navegador manda Origin también en el mismo origen, y ni él ni otra página
 * pueden cambiar el Host. Se compara host y puerto, no el esquema: detrás
 * de ngrok el backend recibe http y el Origin dice https.
 */
export function esOrigenDelPanel(headers: IncomingHttpHeaders): boolean {
  const origen = headers.origin;
  if (typeof origen !== 'string') return false;
  return CORS_ORIGINS.includes(origen) || mismoOrigen(origen, headers.host);
}

function mismoOrigen(origen: string, host: string | undefined): boolean {
  if (!host) return false;
  try {
    const url = new URL(origen);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.host === host.toLowerCase();
  } catch {
    return false; // «null» y lo que no es una URL
  }
}

/** El token de la cookie del panel, o null si la petición no la trae. */
export function leerCookiePanel(headers: IncomingHttpHeaders): string | null {
  for (const par of (headers.cookie ?? '').split(';')) {
    const igual = par.indexOf('=');
    if (igual < 0) continue;
    if (par.slice(0, igual).trim() === COOKIE_PANEL) {
      return par.slice(igual + 1).trim() || null;
    }
  }
  return null;
}

/** Path=/: una cookie tiene un solo camino, y la usan la API y el socket. */
function cookie(valor: string, maxAge: number): string {
  return `${COOKIE_PANEL}=${valor}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

/** Dura lo mismo que el token que lleva, nunca más. */
export function cookieDeSesion(token: string): string {
  return cookie(token, ADMIN_TOKEN_TTL_S);
}

export function cookieBorrada(): string {
  return cookie('', 0);
}
