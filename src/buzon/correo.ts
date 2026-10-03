// Envío por correo de los reportes del buzón (D14) al Gmail del equipo.
//
// SMTP a mano y sin `nodemailer`, por lo mismo que el push va sin el SDK de
// Firebase (`push/fcm.ts`): lo que se usa es una conversación de siete
// comandos sobre TLS, y `node:tls` ya la hace. Un paquete más es un paquete
// más para `npm audit` y para el despliegue.
//
// Gmail por el puerto 465 (TLS desde el primer byte) con una «contraseña de
// aplicación»: la cuenta de Google con verificación en dos pasos la da en
// Seguridad → Contraseñas de aplicaciones (docs/runbook.md). Llega por
// YA_VIENE_CORREO_USUARIO y YA_VIENE_CORREO_CLAVE, en local.env y nunca en el
// repo. Sin ellas los reportes se guardan y salen cuando se configure.
//
// Nada de lo que escribe el pasajero va en una cabecera ni en un comando: el
// asunto es fijo y el cuerpo viaja en base64. Así no hay inyección de
// cabeceras posible, y como ninguna línea de base64 empieza por punto, el
// cuerpo nunca corta el DATA antes de tiempo.
import { connect as conectarTcp, Socket } from 'node:net';
import { connect as conectarTls } from 'node:tls';

export interface ConfigCorreo {
  host: string;
  puerto: number;
  tls: boolean;
  usuario: string;
  clave: string;
  destino: string;
}

export interface MensajeCorreo {
  /** Identificador único: va en el Message-ID. */
  id: string;
  /** Fijo, escrito en el código: nunca texto del pasajero. */
  asunto: string;
  texto: string;
}

const GMAIL = { host: 'smtp.gmail.com', puerto: 465 };
const TIEMPO_MAXIMO_MS = 20_000;

/**
 * Una dirección sin nada que pueda romper un comando SMTP (`<`, `>`,
 * espacios, saltos de línea). No pretende validar el RFC entero: las dos
 * direcciones las escribe el dueño en local.env.
 */
const DIRECCION = /^[^\s@<>()",;:\\[\]]+@[^\s@<>()",;:\\[\]]+\.[^\s@<>()",;:\\[\]]+$/;

export function esDireccion(valor: string): boolean {
  return DIRECCION.test(valor);
}

function esLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

/**
 * Lo que se revisa al arrancar (`validateConfig`): devuelve errores sin
 * enseñar nunca la clave.
 */
export function erroresDeCorreo(env: NodeJS.ProcessEnv): string[] {
  const errores: string[] = [];
  const usuario = env.YA_VIENE_CORREO_USUARIO?.trim();
  const clave = env.YA_VIENE_CORREO_CLAVE?.trim();
  if (Boolean(usuario) !== Boolean(clave)) {
    errores.push('YA_VIENE_CORREO_USUARIO y YA_VIENE_CORREO_CLAVE van juntas: con una sola el buzón no puede mandar');
  }
  if (usuario && !esDireccion(usuario)) {
    errores.push(`YA_VIENE_CORREO_USUARIO no es una dirección de correo («${usuario}»)`);
  }
  const destino = env.YA_VIENE_CORREO_DESTINO?.trim();
  if (destino && !esDireccion(destino)) {
    errores.push(`YA_VIENE_CORREO_DESTINO no es una dirección de correo («${destino}»)`);
  }
  const prueba = env.YA_VIENE_SMTP;
  if (prueba && env.NODE_ENV !== 'production') {
    let valido = false;
    try {
      const url = new URL(prueba);
      valido = url.protocol === 'smtp:' && esLoopback(url.hostname) && url.port !== '';
    } catch {
      valido = false;
    }
    // En claro solo hacia esta misma máquina: es el servidor falso de las
    // pruebas, y por ahí viaja la clave.
    if (!valido) errores.push('YA_VIENE_SMTP solo admite smtp://127.0.0.1:<puerto> (el servidor falso de las pruebas)');
  }
  return errores;
}

/**
 * La configuración que pide el entorno, o null si el correo está apagado.
 * La contraseña de aplicación de Google se muestra en cuatro grupos con
 * espacios; aquí se le quitan, se haya pegado como se haya pegado.
 * YA_VIENE_SMTP apunta al servidor falso de las pruebas y solo vale fuera de
 * producción. `validateConfig` ya revisó todo al arrancar.
 */
export function configCorreoDesdeEntorno(env: NodeJS.ProcessEnv = process.env): ConfigCorreo | null {
  const usuario = env.YA_VIENE_CORREO_USUARIO?.trim();
  const clave = env.YA_VIENE_CORREO_CLAVE?.replace(/\s/g, '');
  if (!usuario || !clave) return null;
  const destino = env.YA_VIENE_CORREO_DESTINO?.trim() || usuario;
  if (env.YA_VIENE_SMTP && env.NODE_ENV !== 'production') {
    const url = new URL(env.YA_VIENE_SMTP);
    return { host: url.hostname, puerto: Number(url.port), tls: false, usuario, clave, destino };
  }
  return { ...GMAIL, tls: true, usuario, clave, destino };
}

function base64(texto: string): string {
  return Buffer.from(texto, 'utf8').toString('base64');
}

/**
 * El correo entero, cabeceras y cuerpo, con saltos CRLF. El cuerpo va en
 * base64 partido a 76 columnas (RFC 2045) y el asunto como palabra
 * codificada (RFC 2047) para que la tilde llegue tal cual.
 */
export function armarMensaje(config: ConfigCorreo, mensaje: MensajeCorreo, fecha: Date = new Date()): string {
  const dominio = config.usuario.split('@')[1];
  const cuerpo = base64(mensaje.texto).match(/.{1,76}/g) ?? [''];
  return [
    `From: Ya Viene <${config.usuario}>`,
    `To: <${config.destino}>`,
    `Subject: =?UTF-8?B?${base64(mensaje.asunto)}?=`,
    `Date: ${fecha.toUTCString()}`,
    `Message-ID: <${mensaje.id}@${dominio}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    ...cuerpo,
  ].join('\r\n');
}

/**
 * La conversación con el servidor: escribe un comando y espera su
 * respuesta. Una respuesta termina en la línea cuyo código va seguido de un
 * espacio («250 OK»); las de varias líneas llevan guion («250-…») en las
 * anteriores.
 */
function conversacion(socket: Socket): (comando: string | null, esperados: number[], paso: string) => Promise<void> {
  let bufer = '';
  let error: Error | null = null;
  let despertar: (() => void) | null = null;
  const avisar = (): void => {
    const d = despertar;
    despertar = null;
    d?.();
  };
  socket.setEncoding('utf8');
  socket.on('data', (trozo: string) => {
    bufer += trozo;
    avisar();
  });
  socket.on('error', (e: Error) => {
    error ??= new Error(`sin conexión con el servidor de correo (${e.message})`);
    avisar();
  });
  socket.on('close', () => {
    error ??= new Error('el servidor de correo cerró la conexión');
    avisar();
  });
  socket.on('timeout', () => {
    error ??= new Error('el servidor de correo no respondió a tiempo');
    socket.destroy();
    avisar();
  });

  async function respuesta(): Promise<number> {
    for (;;) {
      const lineas = bufer.split('\r\n');
      for (let i = 0; i < lineas.length - 1; i++) {
        const codigo = /^(\d{3})(?: |$)/.exec(lineas[i]);
        if (codigo) {
          bufer = lineas.slice(i + 1).join('\r\n');
          return Number(codigo[1]);
        }
      }
      if (error) throw error;
      await new Promise<void>((listo) => {
        despertar = listo;
      });
    }
  }

  return async (comando, esperados, paso) => {
    if (comando !== null) socket.write(`${comando}\r\n`);
    const codigo = await respuesta();
    // Solo el paso y el código: el texto de un 535 puede repetir lo que se
    // le mandó, y lo que se le mandó en AUTH es la clave.
    if (!esperados.includes(codigo)) throw new Error(`${paso}: el servidor de correo respondió ${codigo}`);
  };
}

/**
 * Manda un correo. Se cumple cuando el servidor lo aceptó (250 al final del
 * DATA) y se rechaza con un mensaje que dice el paso y el código, nunca la
 * clave. Un 535 en AUTH es la contraseña de aplicación mal puesta.
 */
export async function enviarCorreo(
  config: ConfigCorreo,
  mensaje: MensajeCorreo,
  tiempoMaximoMs: number = TIEMPO_MAXIMO_MS,
): Promise<void> {
  const socket = config.tls
    ? conectarTls({ host: config.host, port: config.puerto, servername: config.host })
    : conectarTcp({ host: config.host, port: config.puerto });
  socket.setTimeout(tiempoMaximoMs);
  const paso = conversacion(socket);
  try {
    await paso(null, [220], 'saludo');
    await paso('EHLO yaviene', [250], 'EHLO');
    await paso(`AUTH PLAIN ${base64(`\0${config.usuario}\0${config.clave}`)}`, [235], 'AUTH');
    await paso(`MAIL FROM:<${config.usuario}>`, [250], 'MAIL FROM');
    await paso(`RCPT TO:<${config.destino}>`, [250, 251], 'RCPT TO');
    await paso('DATA', [354], 'DATA');
    await paso(`${armarMensaje(config, mensaje)}\r\n.`, [250], 'mensaje');
    socket.end('QUIT\r\n');
  } catch (error) {
    socket.destroy();
    throw error;
  }
}
