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
 * Si la petición viene de una página autorizada en CORS_ORIGINS. Esa lista
 * es de orígenes del panel web y nada más: uno que entre ahí puede iniciar
 * la sesión del panel y escribir con su cookie.
 */
export function esOrigenDelPanel(headers: IncomingHttpHeaders): boolean {
  const origen = headers.origin;
  return typeof origen === 'string' && CORS_ORIGINS.includes(origen);
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
