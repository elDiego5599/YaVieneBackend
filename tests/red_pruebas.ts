// Lo que las pruebas saben de la red de la máquina que las corre. No es un
// archivo de pruebas (no acaba en .test.ts): lo importan los que lo necesitan.
import { createServer } from 'node:net';

/**
 * Dónde escuchan los backends que levanta la suite. tests/entorno.ts lo pone
 * en HTTP_HOST para los que heredan el entorno; los que arrancan con un
 * entorno limpio lo pasan a mano. El backend de verdad escucha en '::' (sin
 * la variable), y eso lo prueba arranque.test.ts por separado: aquí se
 * trata de que la suite entera corra también donde no hay IPv6.
 */
export const HOST_PRUEBAS = '127.0.0.1';

let sondeo: Promise<boolean> | undefined;

/**
 * Si esta máquina puede escuchar en '::'. En el contenedor de la nube el
 * núcleo viene sin IPv6 y `listen('::')` falla con EAFNOSUPPORT; en el Mac y
 * en Fly sí hay. Se pregunta una vez por proceso.
 */
export function hayIpv6(): Promise<boolean> {
  sondeo ??= new Promise((resolve) => {
    const servidor = createServer();
    servidor.once('error', () => resolve(false));
    servidor.listen(0, '::', () => servidor.close(() => resolve(true)));
  });
  return sondeo;
}
