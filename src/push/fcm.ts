// Envío de mensajes push por Firebase Cloud Messaging (API HTTP v1).
//
// Sin el SDK de Admin a propósito: lo único que se usa de él es firmar un JWT
// con la cuenta de servicio, cambiarlo por un token de acceso y hacer un POST,
// y `jsonwebtoken` ya está en el proyecto. El SDK son decenas de paquetes más
// para `npm audit` y para el despliegue.
//
// La cuenta de servicio es el JSON que da la consola de Firebase (Configuración
// del proyecto → Cuentas de servicio → Generar nueva clave privada). Vive
// fuera del repo (`.gitignore`) y llega por YA_VIENE_FCM_CREDENCIALES con su
// ruta. Sin la variable, el push queda apagado: la app sigue avisando
// mientras esté abierta y `POST /api/avisos` responde 503.
//
// Solo Android: iOS necesita la cuenta de Apple para la clave de APNs.
import { readFileSync } from 'node:fs';
import jwt from 'jsonwebtoken';

export interface CredencialesFcm {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri: string;
}

/** Lo que pasó con un envío, que decide qué se hace con la fila del aviso. */
export type ResultadoEnvio = 'enviado' | 'token_invalido' | 'reintentar';

const ALCANCE = 'https://www.googleapis.com/auth/firebase.messaging';
const API_FCM = 'https://fcm.googleapis.com';
const TIEMPO_MAXIMO_MS = 10_000;
/** El token de acceso dura una hora; se renueva un minuto antes. */
const MARGEN_TOKEN_MS = 60_000;

/**
 * Códigos con los que FCM dice que el token del teléfono ya no sirve: la app
 * se desinstaló o se borraron sus datos (UNREGISTERED), el token es de otro
 * proyecto (SENDER_ID_MISMATCH) o no es un token (INVALID_ARGUMENT; el resto
 * del mensaje es fijo y lo prueba la suite, así que lo inválido es el token).
 * Reintentar con esos tokens no llega nunca.
 */
const CODIGOS_TOKEN_INVALIDO = new Set(['UNREGISTERED', 'SENDER_ID_MISMATCH', 'INVALID_ARGUMENT']);

function esLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]';
}

/**
 * Lee y revisa la cuenta de servicio. Lanza con un mensaje que dice qué falta,
 * nunca con el contenido del archivo: la clave privada no sale en un log.
 */
export function leerCredencialesFcm(ruta: string): CredencialesFcm {
  let datos: unknown;
  try {
    datos = JSON.parse(readFileSync(ruta, 'utf8'));
  } catch {
    throw new Error(`no se pudo leer ${ruta} como JSON`);
  }
  const campos = ['project_id', 'client_email', 'private_key', 'token_uri'] as const;
  const objeto = (typeof datos === 'object' && datos !== null ? datos : {}) as Record<string, unknown>;
  for (const campo of campos) {
    const valor = objeto[campo];
    if (typeof valor !== 'string' || !valor.trim()) {
      throw new Error(`a ${ruta} le falta «${campo}»: ¿es la cuenta de servicio de Firebase?`);
    }
  }
  const tokenUri = new URL(objeto.token_uri as string);
  // El JWT firmado viaja a esta dirección: en claro solo hacia esta misma
  // máquina, que es donde las pruebas ponen su servidor falso.
  if (tokenUri.protocol !== 'https:' && !esLoopback(tokenUri.hostname)) {
    throw new Error(`token_uri de ${ruta} no es https`);
  }
  return {
    project_id: objeto.project_id as string,
    client_email: objeto.client_email as string,
    private_key: objeto.private_key as string,
    token_uri: objeto.token_uri as string,
  };
}

export class EmisorFcm {
  private acceso: { token: string; hasta: number } | null = null;
  private pidiendo: Promise<string> | null = null;

  constructor(
    private readonly credenciales: CredencialesFcm,
    private readonly api: string = API_FCM,
  ) {}

  /**
   * Token de acceso de OAuth, guardado hasta un minuto antes de que venza.
   * Si varios envíos lo piden a la vez, comparten la misma petición.
   */
  private tokenDeAcceso(ahora: number): Promise<string> {
    if (this.acceso && ahora < this.acceso.hasta) return Promise.resolve(this.acceso.token);
    if (this.pidiendo) return this.pidiendo;
    this.pidiendo = this.pedirToken(ahora).finally(() => {
      this.pidiendo = null;
    });
    return this.pidiendo;
  }

  private async pedirToken(ahora: number): Promise<string> {
    const { client_email: email, private_key: clave, token_uri: tokenUri } = this.credenciales;
    const iat = Math.floor(ahora / 1000);
    const afirmacion = jwt.sign(
      { iss: email, scope: ALCANCE, aud: tokenUri, iat, exp: iat + 3600 },
      clave,
      { algorithm: 'RS256' },
    );
    const respuesta = await fetch(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: afirmacion,
      }).toString(),
      signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS),
    });
    if (!respuesta.ok) throw new Error(`token de acceso: HTTP ${respuesta.status}`);
    const cuerpo = (await respuesta.json()) as { access_token?: unknown; expires_in?: unknown };
    if (typeof cuerpo.access_token !== 'string') throw new Error('token de acceso: respuesta sin access_token');
    const segundos = typeof cuerpo.expires_in === 'number' ? cuerpo.expires_in : 3600;
    this.acceso = { token: cuerpo.access_token, hasta: ahora + segundos * 1000 - MARGEN_TOKEN_MS };
    return cuerpo.access_token;
  }

  /**
   * Manda un mensaje solo de datos y de prioridad alta: la app lo recibe
   * aunque esté cerrada y arma ella la notificación, con el mismo canal y el
   * mismo identificador que cuando avisa sola (así nunca salen dos). Diez
   * minutos de vida: un «tu bus está cerca» que llega más tarde ya miente.
   */
  async enviar(token: string, datos: Record<string, string>, ahora: number = Date.now()): Promise<ResultadoEnvio> {
    let acceso: string;
    try {
      acceso = await this.tokenDeAcceso(ahora);
    } catch (error) {
      console.warn(`[Push] No hay token de acceso: ${(error as Error).message}`);
      return 'reintentar';
    }
    let respuesta: Response;
    try {
      respuesta = await fetch(`${this.api}/v1/projects/${this.credenciales.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${acceso}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: { token, data: datos, android: { priority: 'HIGH', ttl: '600s' } },
        }),
        signal: AbortSignal.timeout(TIEMPO_MAXIMO_MS),
      });
    } catch (error) {
      console.warn(`[Push] FCM no respondió: ${(error as Error).message}`);
      return 'reintentar';
    }
    if (respuesta.ok) return 'enviado';
    if (respuesta.status === 401) {
      // El token de acceso se revocó o caducó antes de tiempo: el siguiente
      // intento pide otro.
      this.acceso = null;
      return 'reintentar';
    }
    const codigo = await codigoDeError(respuesta);
    if (CODIGOS_TOKEN_INVALIDO.has(codigo)) return 'token_invalido';
    console.warn(`[Push] FCM respondió ${respuesta.status} ${codigo}`);
    return 'reintentar';
  }
}

/**
 * El código de error de FCM: el `errorCode` de su detalle si viene (es el
 * que distingue UNREGISTERED, que llega con el estado genérico NOT_FOUND) y
 * si no, el estado.
 */
async function codigoDeError(respuesta: Response): Promise<string> {
  try {
    const cuerpo = (await respuesta.json()) as {
      error?: { status?: unknown; details?: Array<{ errorCode?: unknown }> };
    };
    const detalle = cuerpo.error?.details?.find((d) => typeof d.errorCode === 'string')?.errorCode;
    if (typeof detalle === 'string') return detalle;
    return typeof cuerpo.error?.status === 'string' ? cuerpo.error.status : '';
  } catch {
    return '';
  }
}

/**
 * El emisor que pide el entorno, o null si el push está apagado.
 * YA_VIENE_FCM_API apunta a otro servidor (el falso de las pruebas) y solo
 * vale fuera de producción. `validateConfig` ya revisó el archivo al
 * arrancar.
 */
export function emisorDesdeEntorno(env: NodeJS.ProcessEnv = process.env): EmisorFcm | null {
  const ruta = env.YA_VIENE_FCM_CREDENCIALES;
  if (!ruta) return null;
  const api = env.NODE_ENV !== 'production' && env.YA_VIENE_FCM_API ? env.YA_VIENE_FCM_API : API_FCM;
  return new EmisorFcm(leerCredencialesFcm(ruta), api);
}

let emisor: EmisorFcm | null | undefined;

/** El emisor de este proceso, creado la primera vez que se pide. */
export function emisorPush(): EmisorFcm | null {
  if (emisor === undefined) emisor = emisorDesdeEntorno();
  return emisor;
}
