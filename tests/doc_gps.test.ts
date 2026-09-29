// El documento de integración del equipo GPS (docs/integracion-gps.md) es lo
// único que va a leer quien programe el hardware del bus: si dice un número
// que el código ya no usa, el equipo se configura mal y sus posiciones se
// rechazan sin que nadie entienda por qué.
//
// Esta prueba no lee el documento buscando prosa bonita: saca del código los
// motivos de rechazo y los límites, y exige que cada uno esté escrito ahí.
// Un motivo nuevo en payload.ts o en physics.ts rompe esto hasta que se
// documente, que es exactamente cuando hay que documentarlo.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import {
  MAX_CAPTURE_CLOCK_SKEW_MS,
  MAX_PAST_CAPTURE_MS,
  MAX_SPEED_KMH,
} from '../src/security/physics';
import { ZONA } from '../src/security/zona';
import { MAX_MQTT_ANONIMAS_POR_IP, MAX_PAQUETE_MQTT, MQTT_CONNECT_TIMEOUT_MS } from '../src/mqtt/guardia';

const raiz = join(__dirname, '..');
const doc = readFileSync(join(raiz, 'docs', 'integracion-gps.md'), 'utf8');

/** Los motivos tal como el equipo los lee en el ack, sacados del código. */
function motivosDe(archivo: string): string[] {
  const fuente = readFileSync(join(raiz, 'src', archivo), 'utf8');
  // Solo los literales de `reason:`, no cualquier mayúscula suelta del
  // archivo: así un nombre de constante no se cuela como si fuera un motivo.
  const encontrados = fuente.match(/reason: '([A-Z_]+)'/g) ?? [];
  return [...new Set(encontrados.map((m) => m.replace(/^reason: '|'$/g, '')))];
}

test('doc GPS: todos los motivos de rechazo están documentados', () => {
  const motivos = [
    ...motivosDe('security/payload.ts'),
    ...motivosDe('security/physics.ts'),
    ...motivosDe('index.ts'),
  ];
  // Que la extracción funcione: si el patrón deja de encontrar nada, la
  // prueba pasaría vacía y no estaría comprobando absolutamente nada.
  assert.ok(motivos.length >= 13, `se esperaban al menos 13 motivos, salieron ${motivos.length}`);

  const faltan = [...new Set(motivos)].filter((motivo) => !doc.includes(`\`${motivo}\``));
  assert.deepEqual(faltan, [], `motivos sin documentar en docs/integracion-gps.md: ${faltan}`);
});

test('doc GPS: los límites que dice el documento son los del código', () => {
  // Cada número va acompañado de su unidad en el documento, que es como lo
  // va a leer quien configure el equipo.
  assert.ok(doc.includes(`${MAX_SPEED_KMH} km/h`), 'falta el tope de velocidad');
  assert.ok(
    doc.includes(`${MAX_CAPTURE_CLOCK_SKEW_MS / 1000} s`),
    'falta la tolerancia de reloj hacia adelante',
  );
  assert.ok(
    doc.includes(`${MAX_PAST_CAPTURE_MS / 60000} min`),
    'falta la ventana de reenvío hacia atrás',
  );
  // Los de la conexión (auditoría 2026-09, P1-1): un equipo que no los
  // conozca se queda fuera sin entender por qué.
  assert.ok(doc.includes(`pasar de ${MAX_PAQUETE_MQTT / 1024} KB`), 'falta el tope de paquete MQTT');
  assert.ok(doc.includes(`dentro de ${MQTT_CONNECT_TIMEOUT_MS / 1000} s`), 'falta el plazo del CONNECT');
  assert.ok(
    doc.includes(`${MAX_MQTT_ANONIMAS_POR_IP} conexiones abiertas sin autenticar`),
    'falta el tope de conexiones anónimas por IP',
  );
  for (const numero of [ZONA.latMin, ZONA.latMax, ZONA.lonMin, ZONA.lonMax]) {
    assert.ok(doc.includes(String(numero)), `la zona del documento no dice ${numero}`);
  }
});

test('doc GPS: los topics son los que el broker autoriza', () => {
  const broker = readFileSync(join(raiz, 'src', 'mqtt', 'broker.ts'), 'utf8');
  // Las plantillas del código llevan `${payload.companyId}`; el documento
  // las escribe con nombres legibles. Se comparan por la forma del topic.
  assert.ok(broker.includes('/bus/${payload.busId}/posicion'), 'cambió el topic de posición');
  assert.ok(broker.includes('/bus/${auth.busId}/ack'), 'cambió el topic de ack');
  assert.ok(doc.includes('empresa/<companyId>/bus/<busId>/posicion'));
  assert.ok(doc.includes('empresa/<companyId>/bus/<busId>/ack'));
});
