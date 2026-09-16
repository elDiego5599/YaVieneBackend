import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
  Dos cosas que no se ven leyendo un workflow y que no deberían volver a
  pasar:

  1. Sin un bloque `permissions:`, el token que GitHub le presta a la corrida
     lleva los permisos por omisión del repositorio —que incluyen escritura—,
     y ese token se lo pasa a código de terceros.
  2. `uses: algo@v5` trae lo que el dueño de esa acción tenga puesto hoy en
     esa etiqueta. Una etiqueta se mueve; un commit no. Clavado al SHA, lo que
     corre mañana es lo mismo que se revisó hoy, y subirlo es un cambio
     visible en el repositorio y no un silencio. Al lado del SHA va la versión
     legible, que también se exige aquí: sin ella nadie sabe qué está clavado
     sin ir a preguntárselo a GitHub.

  Se lee el texto tal cual, sin analizador de YAML: no hay dependencia que
  agregar y lo que se exige es visible en el archivo.
*/

const carpeta = join(process.cwd(), '.github', 'workflows');
const workflows = readdirSync(carpeta).filter((n) => n.endsWith('.yml') || n.endsWith('.yaml'));

test('hay workflows que revisar', () => {
  assert.ok(workflows.length > 0, `ningún workflow en ${carpeta}`);
});

for (const nombre of workflows) {
  const texto = readFileSync(join(carpeta, nombre), 'utf8');

  test(`${nombre}: declara los permisos del token`, () => {
    assert.match(texto, /^permissions:$/m, 'falta el bloque `permissions:` en la raíz');
    assert.match(texto, /^ {2}contents: read$/m, 'los permisos deben dar solo lectura de contenidos');
  });

  test(`${nombre}: cada acción va clavada a un commit`, () => {
    const usos = [...texto.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)(?:\s+#\s*(\S+))?\s*$/gm)];
    assert.ok(usos.length > 0, 'ningún `uses:`: ¿cambió el formato del archivo?');
    for (const [, accion, version] of usos) {
      assert.match(accion, /@[0-9a-f]{40}$/, `${accion} no está clavado a un SHA de 40 caracteres`);
      assert.match(version ?? '', /^v\d/, `${accion} no dice al lado qué versión es ese commit`);
    }
  });
}
