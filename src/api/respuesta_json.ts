import { ServerResponse } from 'http';
import { gzipSync } from 'zlib';

// Por debajo de esto gzip no gana: su cabecera y su cola ya son 18 bytes y un
// error o un `{"status":"ready"}` saldrían más grandes. Es el umbral que usan
// las CDN (Akamai, CloudFront ~1 KB).
const MINIMO_PARA_COMPRIMIR = 1024;

/**
 * Escribe [payload] como JSON y, si el cliente acepta gzip y el cuerpo pasa
 * de 1 KB, lo comprime. Por ngrok gratis la conexión es lenta y el JSON es
 * texto muy repetido (la flota de una empresa baja de 4,5 KB a 0,5 KB); el
 * cliente de Dart (app y panel) y el navegador mandan `Accept-Encoding:
 * gzip` y descomprimen solos.
 *
 * Síncrono a propósito: quien llama cuenta con que la respuesta ya salió al
 * volver (`headersSent` en el 413 y en el 500 de `routes.ts`), y comprimir
 * unos KB de JSON es cosa de microsegundos.
 */
export function escribirJson(res: ServerResponse, status: number, payload: unknown): void {
  const cuerpo = Buffer.from(JSON.stringify(payload), 'utf8');
  // Las cachés tienen que separar la copia en gzip de la clara aunque esta
  // respuesta salga en claro: el mismo recurso puede crecer y comprimirse.
  agregarVary(res, 'Accept-Encoding');
  const gzip = cuerpo.length >= MINIMO_PARA_COMPRIMIR && aceptaGzip(res.req?.headers['accept-encoding']);
  const enviado = gzip ? gzipSync(cuerpo) : cuerpo;
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...(gzip ? { 'Content-Encoding': 'gzip' } : {}),
    'Content-Length': enviado.length,
  });
  res.end(enviado);
}

/** Si `Accept-Encoding` admite gzip: lo nombra y no con `q=0` (RFC 9110 §12.5.3). */
export function aceptaGzip(aceptadas: string | undefined): boolean {
  return (aceptadas ?? '').split(',').some((parte) => {
    const [nombre, ...parametros] = parte.split(';').map((t) => t.trim().toLowerCase());
    if (nombre !== 'gzip') return false;
    const q = parametros.find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/** Suma [valor] al `Vary` que ya traiga la respuesta (el de CORS, `index.ts`). */
function agregarVary(res: ServerResponse, valor: string): void {
  const actual = res.getHeader('Vary');
  res.setHeader('Vary', actual ? `${String(actual)}, ${valor}` : valor);
}
