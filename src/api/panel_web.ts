import fs from 'fs';
import { IncomingMessage, ServerResponse } from 'http';
import path from 'path';
import zlib from 'zlib';

/**
 * El panel web (la build de `app_control`, `tool/compilar-panel-web.sh
 * --base-href /panel/`) servido en /panel/, en el mismo origen que la API.
 * Así la cookie SameSite=Strict del panel viaja sin depender de la Public
 * Suffix List (`auth/cookie_panel.ts`) y el login no necesita CORS.
 *
 * Solo se sirven archivos que están dentro de la carpeta, sin enlaces que
 * salgan de ella, sin ocultos y sin listar carpetas; todo lo demás es 404.
 * Cada respuesta lleva la CSP que el script dejó en `csp.txt`; las demás
 * cabeceras de seguridad las pone `index.ts` a todo.
 */
export const RUTA_PANEL = '/panel/';

// Flutter web trae además `.symbols`, `.frag`, `.bin` y NOTICES: van como
// octet-stream, que con nosniff el navegador no interpreta.
const TIPOS: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Lo que gana con gzip. Por ngrok gratis el panel baja a unos 140 KB/s y
// main.dart.js más el wasm de CanvasKit son 9 MB (3,2 comprimidos); las
// imágenes y woff2 ya vienen comprimidas.
const COMPRIMIBLES = new Set(['.html', '.js', '.mjs', '.json', '.wasm', '.css', '.svg', '.ttf', '.otf', '.txt']);

export type ServirPanel = (req: IncomingMessage, res: ServerResponse) => boolean;

/**
 * El manejador de /panel/ para la build de [dir], o uno que no toca nada si
 * no hay carpeta (sin YA_VIENE_PANEL_WEB el panel no existe y /panel da el
 * 404 de la API). Una carpeta sin `index.html` o sin `csp.txt` no arranca:
 * sin su CSP el panel no se sirve.
 */
export function panelWeb(dir: string | undefined): ServirPanel {
  if (!dir) return () => false;
  let raiz: string;
  try {
    raiz = fs.realpathSync(dir);
  } catch {
    throw new Error(`YA_VIENE_PANEL_WEB: «${dir}» no existe`);
  }
  for (const necesario of ['index.html', 'csp.txt']) {
    if (!fs.statSync(path.join(raiz, necesario), { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`YA_VIENE_PANEL_WEB: a «${dir}» le falta ${necesario}; compílalo con tool/compilar-panel-web.sh`);
    }
  }
  const csp = fs.readFileSync(path.join(raiz, 'csp.txt'), 'utf8').trim();

  return (req, res) => {
    const ruta = (req.url ?? '').split('?')[0];
    if (ruta === '/panel') {
      res.writeHead(301, { Location: RUTA_PANEL });
      res.end();
      return true;
    }
    if (!ruta.startsWith(RUTA_PANEL)) return false;

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return true;
    }
    const archivo = dentroDe(raiz, ruta.slice(RUTA_PANEL.length) || 'index.html');
    const datos = archivo ? fs.statSync(archivo, { throwIfNoEntry: false }) : undefined;
    if (!archivo || !datos?.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No encontrado');
      return true;
    }

    // Los nombres de la build no llevan hash (main.dart.js es siempre
    // main.dart.js): se revalida siempre y el ETag ahorra la descarga.
    const extension = path.extname(archivo).toLowerCase();
    const comprimible = COMPRIMIBLES.has(extension);
    const gzip = comprimible && pideGzip(req.headers['accept-encoding']);
    const etag = `W/"${datos.size}-${Math.trunc(datos.mtimeMs)}${gzip ? '-gz' : ''}"`;
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('ETag', etag);
    if (comprimible) res.setHeader('Vary', 'Accept-Encoding');
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304);
      res.end();
      return true;
    }
    res.writeHead(200, {
      'Content-Type': TIPOS[extension] ?? 'application/octet-stream',
      ...(gzip ? { 'Content-Encoding': 'gzip' } : { 'Content-Length': datos.size }),
    });
    if (req.method === 'HEAD') {
      res.end();
      return true;
    }
    const lectura = fs.createReadStream(archivo).on('error', () => res.destroy());
    if (!gzip) {
      lectura.pipe(res);
      return true;
    }
    lectura.pipe(zlib.createGzip().on('error', () => res.destroy())).pipe(res);
    return true;
  };
}

/** Si `Accept-Encoding` admite gzip: lo nombra y no con `q=0`. */
function pideGzip(aceptadas: string | undefined): boolean {
  return (aceptadas ?? '').split(',').some((parte) => {
    const [nombre, ...parametros] = parte.split(';').map((t) => t.trim().toLowerCase());
    if (nombre !== 'gzip') return false;
    const q = parametros.find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });
}

/**
 * La ruta real de [relativa] si cae dentro de [raiz], o null. Se decodifica
 * una sola vez (así `%2e%2e` es `..`, y `%252e` se queda en un nombre que no
 * existe); ningún tramo puede empezar con punto (ni `..` ni ocultos), ni
 * haber barra invertida, NUL o una barra al final; y la ruta real —después
 * de seguir enlaces— tiene que seguir dentro.
 */
function dentroDe(raiz: string, relativa: string): string | null {
  let limpia: string;
  try {
    limpia = decodeURIComponent(relativa);
  } catch {
    return null;
  }
  if (/[\\\0]/.test(limpia) || limpia.endsWith('/')) return null;
  if (limpia.split('/').some((tramo) => tramo === '' || tramo.startsWith('.'))) return null;
  try {
    const real = fs.realpathSync(path.join(raiz, limpia));
    return real.startsWith(raiz + path.sep) ? real : null;
  } catch {
    return null;
  }
}
