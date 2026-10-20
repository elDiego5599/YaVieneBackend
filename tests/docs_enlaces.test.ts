// Los documentos de `docs/` se leen sin el repo delante: el runbook lo abre
// quien opera el Mac en mitad de una caída, y el de integración lo lee quien
// programa el equipo del bus. Un enlace roto ahí manda a alguien a buscar un
// archivo que no existe, justo cuando tiene prisa.
//
// Esta prueba recorre todos los .md de `docs/`, saca sus enlaces relativos y
// exige que cada destino exista. Y revisa que el índice de decisiones y la
// carpeta digan lo mismo en las dos direcciones: ninguna decisión sin
// enlazar, ningún enlace a una decisión que no está.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';

const docs = join(__dirname, '..', 'docs');

function markdownsDe(carpeta: string): string[] {
  return readdirSync(carpeta, { withFileTypes: true }).flatMap((entrada) => {
    const ruta = join(carpeta, entrada.name);
    if (entrada.isDirectory()) return markdownsDe(ruta);
    return entrada.name.endsWith('.md') ? [ruta] : [];
  });
}

test('docs: ningún enlace relativo apunta a un archivo que no existe', () => {
  const archivos = markdownsDe(docs);
  assert.ok(archivos.length >= 4, `se esperaban al menos 4 documentos, hay ${archivos.length}`);

  const rotos: string[] = [];
  for (const archivo of archivos) {
    const texto = readFileSync(archivo, 'utf8');
    for (const enlace of texto.matchAll(/\]\(([^)]+)\)/g)) {
      const destino = enlace[1];
      // Solo los de disco: los http(s) y los anclas de la misma página no
      // son cosa de esta prueba.
      if (/^(https?:|#|mailto:)/.test(destino)) continue;
      const [ruta] = destino.split('#');
      if (!ruta) continue;
      if (!existsSync(resolve(dirname(archivo), ruta))) {
        rotos.push(`${relative(docs, archivo)} → ${destino}`);
      }
    }
  }
  assert.deepEqual(rotos, [], `enlaces rotos: ${rotos.join(', ')}`);
});

test('docs: el índice de decisiones y la carpeta dicen lo mismo', () => {
  const carpeta = join(docs, 'decisiones');
  const indice = readFileSync(join(carpeta, 'README.md'), 'utf8');
  const enDisco = readdirSync(carpeta)
    .filter((n) => n.endsWith('.md') && n !== 'README.md')
    .sort();

  assert.ok(enDisco.length >= 12, `se esperaban las doce decisiones, hay ${enDisco.length}`);

  const sinEnlazar = enDisco.filter((nombre) => !indice.includes(`(${nombre})`));
  assert.deepEqual(sinEnlazar, [], `decisiones que el índice no menciona: ${sinEnlazar}`);

  // Y al revés: D1 a D12, cada una con su archivo. Así una decisión nueva no
  // puede entrar solo como fila de la tabla.
  for (let n = 1; n <= 12; n += 1) {
    const archivo = enDisco.find((nombre) => nombre.startsWith(`D${n}-`));
    assert.ok(archivo, `falta el archivo de la decisión D${n}`);
    assert.ok(indice.includes(`[D${n}]`), `el índice no enlaza D${n}`);
  }
});

test('docs: D13 y el backend limitan cada teléfono a un bus seguido', () => {
  const d13 = readFileSync(join(docs, 'decisiones', 'D13-avisos-push.md'), 'utf8');
  const codigo = readFileSync(join(__dirname, '..', 'src', 'data', 'avisos_push.ts'), 'utf8');

  assert.match(d13, /Cada teléfono puede tener un solo bus armado a la vez/i);
  assert.match(codigo, /MAX_AVISOS_POR_TOKEN\s*=\s*1/);
});
