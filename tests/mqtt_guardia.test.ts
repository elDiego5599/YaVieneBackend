// El medidor de paquetes y el cupo por dirección de `src/mqtt/guardia.ts`,
// sin levantar el backend. Lo que se prueba contra el servidor de verdad está
// en mqtt_abuso.test.ts; aquí van los bordes que ahí no se ven: paquetes
// partidos en cualquier byte, varios en un mismo trozo, el tope exacto y el
// largo mal formado.
import assert from 'node:assert/strict';
import test from 'node:test';

import mqttPacket from 'mqtt-packet';

import { CupoPorClave, MAX_PAQUETE_MQTT, MedidorPaquetesMqtt } from '../src/mqtt/guardia';

/** Un paquete MQTT con `largo` bytes de cuerpo (PUBLISH con cuerpo de relleno). */
function paqueteDe(largo: number): Buffer {
  const varint: number[] = [];
  let n = largo;
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    varint.push(byte);
  } while (n > 0);
  return Buffer.concat([Buffer.from([0x30, ...varint]), Buffer.alloc(largo, 0x41)]);
}

/** Lo que manda el equipo del bus: CONNECT con el JWT, PUBLISH de posición, PINGREQ. */
function sesionReal(): Buffer {
  return Buffer.concat([
    mqttPacket.generate({
      cmd: 'connect', protocolId: 'MQTT', protocolVersion: 4, clean: true, keepalive: 30,
      clientId: 'equipo-bus-001', username: '', password: Buffer.from('e'.repeat(420)),
    }),
    mqttPacket.generate({
      cmd: 'publish', topic: 'empresa/EMP-01/bus/BUS-SKR201/posicion', qos: 0, retain: false, dup: false,
      payload: Buffer.from(JSON.stringify({
        protocolVersion: 1, sequence: 1, capturedAt: 1_767_225_600_000, lat: 10.98, lon: -74.8, speedKmh: 32,
      })),
    }),
    mqttPacket.generate({ cmd: 'pingreq' }),
  ]);
}

test('guardia: una sesión real pasa entera, de un golpe o byte a byte', () => {
  const datos = sesionReal();
  assert.equal(new MedidorPaquetesMqtt().medir(datos), true);
  const medidor = new MedidorPaquetesMqtt();
  for (const byte of datos) assert.equal(medidor.medir(Buffer.from([byte])), true);
});

test('guardia: el tope exacto pasa y un byte más no', () => {
  assert.equal(new MedidorPaquetesMqtt().medir(paqueteDe(MAX_PAQUETE_MQTT)), true);
  assert.equal(new MedidorPaquetesMqtt().medir(paqueteDe(MAX_PAQUETE_MQTT + 1)), false);
});

test('guardia: corta con la cabecera, sin esperar el cuerpo', () => {
  // CONNECT que anuncia ~200 MB: basta con los cinco bytes de la cabecera.
  assert.equal(new MedidorPaquetesMqtt().medir(Buffer.from([0x10, 0xff, 0xff, 0xff, 0x5f])), false);
  // Y aunque el largo llegue partido: en cuanto la cuenta pasa del tope,
  // antes de terminar de leer el largo.
  const medidor = new MedidorPaquetesMqtt();
  assert.equal(medidor.medir(Buffer.from([0x10, 0xff])), true, '127 todavía cabe');
  assert.equal(medidor.medir(Buffer.from([0xff])), true, '16 383 todavía cabe');
  assert.equal(medidor.medir(Buffer.from([0x01])), false, '32 767 ya no');
});

test('guardia: un paquete grande detrás de varios buenos, en el mismo trozo', () => {
  const trozo = Buffer.concat([sesionReal(), paqueteDe(MAX_PAQUETE_MQTT + 1).subarray(0, 8)]);
  assert.equal(new MedidorPaquetesMqtt().medir(trozo), false);
});

test('guardia: un largo de más de 4 bytes es un paquete mal formado', () => {
  // 0x80 0x80 0x80 0x80: cuatro bytes con continuación y valor 0; el quinto
  // no existe en MQTT (§2.2.3).
  assert.equal(new MedidorPaquetesMqtt(Number.MAX_SAFE_INTEGER).medir(Buffer.from([0x30, 0x80, 0x80, 0x80, 0x80, 0x01])), false);
});

test('guardia: paquetes sin cuerpo (PINGREQ, DISCONNECT) no descuadran la cuenta', () => {
  const medidor = new MedidorPaquetesMqtt(10);
  assert.equal(medidor.medir(Buffer.from([0xc0, 0x00, 0xe0, 0x00, 0xc0, 0x00])), true);
  assert.equal(medidor.medir(paqueteDe(10)), true);
  assert.equal(medidor.medir(paqueteDe(11)), false);
});

test('guardia: el cupo cuenta por dirección y suelta lo que se cierra', () => {
  const cupo = new CupoPorClave(2);
  assert.equal(cupo.tomar('1.1.1.1'), true);
  assert.equal(cupo.tomar('1.1.1.1'), true);
  assert.equal(cupo.tomar('1.1.1.1'), false, 'la tercera de la misma dirección no');
  assert.equal(cupo.tomar('2.2.2.2'), true, 'otra dirección tiene su propio cupo');
  cupo.soltar('1.1.1.1');
  assert.equal(cupo.cuantas('1.1.1.1'), 1);
  assert.equal(cupo.tomar('1.1.1.1'), true);
  cupo.soltar('1.1.1.1');
  cupo.soltar('1.1.1.1');
  cupo.soltar('1.1.1.1');
  assert.equal(cupo.cuantas('1.1.1.1'), 0, 'soltar de más no deja la cuenta en negativo');
});
