import { IncomingMessage, ServerResponse } from 'http';

/** Un año: lo que piden los navegadores para tomarse HSTS en serio. */
export const HSTS_MAX_AGE_S = 365 * 24 * 60 * 60;

/**
 * Las cabeceras de seguridad de toda respuesta, en un solo sitio: la API,
 * el panel web, los preflight y el 404 pasan todos por `requestHandler`.
 * Van con `setHeader` para no quedar fuera de los `writeHead(204)` directos.
 *
 * HSTS solo cuando la petición llegó cifrada al túnel (`X-Forwarded-Proto`
 * lo pone ngrok): en el HTTP local de pruebas y del Mac no aplica, y un
 * navegador ignora HSTS que no venga por HTTPS, así que fingir la cabecera
 * no le sirve a nadie para nada.
 */
export function ponerCabecerasSeguridad(req: IncomingMessage, res: ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  if (llegoPorHttps(req)) {
    res.setHeader('Strict-Transport-Security', `max-age=${HSTS_MAX_AGE_S}`);
  }
}

function llegoPorHttps(req: IncomingMessage): boolean {
  const proto = req.headers['x-forwarded-proto'];
  // Tras varios proxies llega «https,http»: manda el primero, el del cliente.
  const primero = (Array.isArray(proto) ? proto[0] : proto)?.split(',')[0]?.trim().toLowerCase();
  return primero === 'https';
}
