/** Lo más que se deja ver de un texto que manda un cliente. */
export const MAX_TEXTO_LOG = 120;

/**
 * Un texto que viene de fuera (topic MQTT, nombre de evento del socket),
 * listo para el log: entre comillas, con saltos y caracteres invisibles
 * escapados (un `\n` en el topic fingiría una línea de log nueva, y un
 * `\u202E` le daría la vuelta) y cortado, para que nadie llene el disco.
 */
export function textoParaLog(texto: string): string {
  const corto = texto.length > MAX_TEXTO_LOG ? texto.slice(0, MAX_TEXTO_LOG) : texto;
  const seguro = JSON.stringify(corto).replace(
    /[\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return texto.length > MAX_TEXTO_LOG ? `${seguro.slice(0, -1)}…" (${texto.length} caracteres)` : seguro;
}
