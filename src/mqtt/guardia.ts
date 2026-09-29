// Guardia del MQTT antes de autenticar (auditoría 2026-09, P1-1).
//
// El parser de aedes (`mqtt-packet`) junta en memoria el paquete entero que
// anuncia la cabecera, hasta 256 MB, y eso pasa antes del CONNECT: sin
// token, un cliente de `/mqtt` subió el backend de 106 a 275 MB en 8 s. El
// `maxPayload` de `ws` no lo impedía porque acota cada mensaje WebSocket, no
// el paquete MQTT, que puede venir en cien mensajes seguidos. Aquí se lee
// solo la cabecera fija de cada paquete (tipo + largo restante) y se corta
// en cuanto uno anuncia más del tope, sin esperar a que llegue.
//
// Sin dependencias del broker para poder probarlo sin levantar nada.

/**
 * Largo máximo de un paquete MQTT. Lo más grande que manda el equipo del bus
 * es el CONNECT, con el JWT de contraseña (unos 400 bytes); una posición es
 * un JSON de menos de 1 KB (`docs/integracion-gps.md`). 16 KB deja margen de
 * sobra y acota lo que un anónimo puede hacer guardar.
 */
export const MAX_PAQUETE_MQTT = 16 * 1024;

/**
 * Tope de cada mensaje WebSocket en `/mqtt`. `ws` junta el mensaje entero
 * antes de entregarlo, así que es lo máximo que una conexión retiene antes
 * de que la guardia lo mida. Cuatro paquetes del tope: un cliente que junta
 * varios en un mismo mensaje sigue cabiendo.
 */
export const MAX_MENSAJE_WS_MQTT = 4 * MAX_PAQUETE_MQTT;

/**
 * Plazo para que llegue el CONNECT (aedes trae 30 s). El equipo lo manda en
 * cuanto abre el WebSocket; 10 s cubren una red móvil lenta, y una conexión
 * muda deja de ocupar sitio tres veces antes.
 */
export const MQTT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Cuántas conexiones de `/mqtt` puede tener una dirección abiertas sin
 * autenticar a la vez. La clave es la del limitador del HTTP (`requestKey`):
 * detrás de ngrok o de Fly es la IP del visitante, y una IPv6 cuenta por su
 * /64. Un equipo pasa por este
 * estado lo que tarda su CONNECT en ir y volver, así que 20 deja sitio a
 * muchos buses detrás de la misma IP de un operador móvil reconectando a la
 * vez; los que no caben reintentan solos. Las conexiones ya autenticadas no
 * cuentan. YA_VIENE_MAX_MQTT_ANONIMAS_IP lo cambia, como
 * YA_VIENE_MAX_SOCKETS_IP en el socket.
 */
export const MAX_MQTT_ANONIMAS_POR_IP = (() => {
  const n = Number(process.env.YA_VIENE_MAX_MQTT_ANONIMAS_IP);
  return Number.isInteger(n) && n >= 1 ? n : 20;
})();

/**
 * Sigue el flujo de bytes de una conexión MQTT paquete a paquete y dice si
 * alguno anuncia más de `tope`. Solo lee la cabecera fija; el cuerpo lo
 * cuenta y lo salta sin guardarlo. Los trozos pueden partir un paquete por
 * cualquier byte, también a mitad del largo.
 */
export class MedidorPaquetesMqtt {
  private estado: 'tipo' | 'largo' | 'cuerpo' = 'tipo';
  private largo = 0;
  private multiplicador = 1;
  private bytesDeLargo = 0;
  private restante = 0;

  constructor(private readonly tope = MAX_PAQUETE_MQTT) {}

  /**
   * `false` en cuanto un paquete anuncia más del tope o trae un largo mal
   * formado (más de 4 bytes, MQTT 3.1.1 §2.2.3). Tras un `false` la
   * conexión se cierra y el medidor no se vuelve a usar.
   */
  medir(trozo: Uint8Array): boolean {
    let i = 0;
    while (i < trozo.length) {
      if (this.estado === 'cuerpo') {
        const salto = Math.min(this.restante, trozo.length - i);
        this.restante -= salto;
        i += salto;
        if (this.restante === 0) this.estado = 'tipo';
        continue;
      }
      const byte = trozo[i++];
      if (this.estado === 'tipo') {
        this.estado = 'largo';
        this.largo = 0;
        this.multiplicador = 1;
        this.bytesDeLargo = 0;
        continue;
      }
      this.largo += (byte & 0x7f) * this.multiplicador;
      this.multiplicador *= 128;
      this.bytesDeLargo++;
      if (this.largo > this.tope) return false;
      if (byte & 0x80) {
        if (this.bytesDeLargo === 4) return false;
        continue;
      }
      this.restante = this.largo;
      this.estado = this.restante > 0 ? 'cuerpo' : 'tipo';
    }
    return true;
  }
}

/** Cupo por clave: cuántas cosas tiene abiertas cada dirección, con tope. */
export class CupoPorClave {
  private readonly enUso = new Map<string, number>();

  constructor(private readonly tope: number) {}

  /** Toma un sitio para `clave`; `false` si ya está en el tope. */
  tomar(clave: string): boolean {
    const n = this.enUso.get(clave) ?? 0;
    if (n >= this.tope) return false;
    this.enUso.set(clave, n + 1);
    return true;
  }

  soltar(clave: string): void {
    const n = this.enUso.get(clave) ?? 0;
    if (n <= 1) this.enUso.delete(clave);
    else this.enUso.set(clave, n - 1);
  }

  cuantas(clave: string): number {
    return this.enUso.get(clave) ?? 0;
  }
}
