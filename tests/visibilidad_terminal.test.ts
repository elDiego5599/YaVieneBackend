import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decidirVisibilidadTerminal,
  type EstadoVisibilidad,
  type EntradaVisibilidad,
  type PuntoRuta,
} from '../src/data/visibilidad_terminal';

const A = { lat: 10, lon: -74 };
const B = { lat: 10.01, lon: -74 };
const recta = [A, B];
const enRecta = (f: number, overrides: Partial<EntradaVisibilidad> = {}): EntradaVisibilidad => ({
  busId: 'BUS-1', routeId: 'R-1', lat: A.lat + (B.lat - A.lat) * f, lon: A.lon,
  speedKmh: 0, capturedAt: 1_000, sentido: 'ida', geometria: recta, ...overrides,
});
const estado = (visible = true, fraccion = 0.5, routeId = 'R-1', sentido: 'ida' | 'venida' = 'ida'): EstadoVisibilidad => ({
  visible, rutaId: routeId, sentido, fraccionRecorrida: fraccion,
  muestrasQuieto: 0, muestrasSalida: 0,
  ...(visible ? {} : { fraccionAlOcultar: sentido === 'venida' ? 1 - fraccion : fraccion }),
});

test('oculta una llegada solo con progreso del último 5 % y quietud confirmada', () => {
  const pasando = decidirVisibilidadTerminal(enRecta(0.97, { speedKmh: 35 }), estado(true, 0.94));
  assert.equal(pasando.visible, true, 'pasar cerca del final con movimiento no es llegar');
  const aunNoFinal = decidirVisibilidadTerminal(enRecta(0.94), estado(true, 0.93));
  const aunNoFinal2 = decidirVisibilidadTerminal(enRecta(0.94, { capturedAt: 2_500 }), aunNoFinal.estado);
  assert.equal(aunNoFinal2.visible, true, 'estar quieto dentro del radio no basta fuera del 5 % final');
  const primera = decidirVisibilidadTerminal(enRecta(0.97), estado(true, 0.94));
  assert.equal(primera.visible, true, 'una muestra quieta no basta');
  const muyPronto = decidirVisibilidadTerminal(enRecta(0.97, { capturedAt: 1_500 }), primera.estado);
  assert.equal(muyPronto.visible, true, 'no completa un segundo de quietud');
  const llegada = decidirVisibilidadTerminal(enRecta(0.97, { capturedAt: 2_100 }), muyPronto.estado);
  assert.equal(llegada.visible, false);
  assert.ok((llegada.fraccionRecorrida ?? 0) >= 0.95);
});

test('venida: el tramo final se mide en sentido contrario a la geometría', () => {
  const muestra = enRecta(0.03, { sentido: 'venida' });
  const previa = estado(true, 0.06, 'R-1', 'venida');
  const una = decidirVisibilidadTerminal(muestra, previa);
  const llegada = decidirVisibilidadTerminal({ ...muestra, capturedAt: 2_100 }, una.estado);
  assert.equal(llegada.visible, false);
  assert.ok((llegada.fraccionRecorrida ?? 1) <= 0.05);
});

test('no oculta una parada a mitad de recorrido aunque quede a pocos metros del terminal', () => {
  const terminal = { lat: 10, lon: -74 };
  const cercaATerminal = { lat: 10.0001, lon: -74.0001 };
  const geometria = [terminal, { lat: 10.01, lon: -74 }, cercaATerminal,
    { lat: 10.005, lon: -74.005 }, { lat: 10.01, lon: -74.01 }];
  const muestra: EntradaVisibilidad = {
    busId: 'BUS-2', routeId: 'R-2', lat: cercaATerminal.lat, lon: cercaATerminal.lon,
    speedKmh: 0, capturedAt: 1_000, sentido: 'ida', geometria,
  };
  const previo = estado(true, 0.6, 'R-2');
  const una = decidirVisibilidadTerminal(muestra, previo);
  const dos = decidirVisibilidadTerminal({ ...muestra, capturedAt: 3_000 }, una.estado);
  assert.ok((dos.fraccionRecorrida ?? 0) > 0.4 && (dos.fraccionRecorrida ?? 1) < 0.8);
  assert.equal(dos.visible, true);
});

test('salida: histéresis conserva oculto dentro de 120 m y lo muestra al alejarse avanzando', () => {
  const inicioOculto = decidirVisibilidadTerminal(enRecta(0), undefined);
  assert.equal(inicioOculto.visible, false);
  const borde = decidirVisibilidadTerminal(enRecta(0.001, { capturedAt: 2_000, speedKmh: 20 }), inicioOculto.estado);
  assert.equal(borde.visible, false);
  const histéresis = decidirVisibilidadTerminal(enRecta(0.10, { capturedAt: 3_000, speedKmh: 20 }), borde.estado);
  assert.equal(histéresis.visible, false, 'no reaparece entre los dos radios');
  const puntoSuelto = decidirVisibilidadTerminal(enRecta(0.20, { capturedAt: 4_000, speedKmh: 20 }), histéresis.estado);
  assert.equal(puntoSuelto.visible, false, 'un salto GPS hacia afuera tampoco basta');
  const retornoRuido = decidirVisibilidadTerminal(enRecta(0.10, { capturedAt: 4_500, speedKmh: 20 }), puntoSuelto.estado);
  assert.equal(retornoRuido.visible, false);
  const salida1 = decidirVisibilidadTerminal(enRecta(0.20, { capturedAt: 5_000, speedKmh: 20 }), retornoRuido.estado);
  const quietoAfuera = decidirVisibilidadTerminal(enRecta(0.20, { capturedAt: 5_200, speedKmh: 0 }), salida1.estado);
  assert.equal(quietoAfuera.visible, false, 'sin avance no confirma la salida');
  const sale = decidirVisibilidadTerminal(enRecta(0.21, { capturedAt: 5_400, speedKmh: 20 }), quietoAfuera.estado);
  assert.equal(sale.visible, true);
});

test('un bus oculto que llega a B y sale como venida vuelve a mostrarse al avanzar', () => {
  const llegada = decidirVisibilidadTerminal(enRecta(0.97, { speedKmh: 0 }), estado(true, 0.94));
  const llegada2 = decidirVisibilidadTerminal(enRecta(0.97, { capturedAt: 2_100, speedKmh: 0 }), llegada.estado);
  assert.equal(llegada2.visible, false);
  const parte = decidirVisibilidadTerminal(enRecta(0.98, {
    sentido: 'venida', capturedAt: 3_000, speedKmh: 25,
  }), llegada2.estado);
  assert.equal(parte.visible, false, 'la primera fijación de salida aún no basta');
  const avanza = decidirVisibilidadTerminal(enRecta(0.97, {
    sentido: 'venida', capturedAt: 3_400, speedKmh: 25,
  }), parte.estado);
  assert.equal(avanza.visible, false, 'el punto de reanclaje no cuenta como avance');
  const confirma = decidirVisibilidadTerminal(enRecta(0.88, {
    sentido: 'venida', capturedAt: 3_800, speedKmh: 25,
  }), avanza.estado);
  assert.equal(confirma.visible, false, 'una fijación fuera de 120 m aún no basta');
  const sale = decidirVisibilidadTerminal(enRecta(0.87, {
    sentido: 'venida', capturedAt: 4_200, speedKmh: 25,
  }), confirma.estado);
  assert.equal(sale.visible, true);
});

test('ruido GPS aislado dentro del terminal no oculta y al regresar a mitad de ruta sigue visible', () => {
  const medio = estado(true, 0.5);
  const salto = decidirVisibilidadTerminal(enRecta(0.97), medio);
  assert.equal(salto.visible, true);
  const regresa = decidirVisibilidadTerminal(enRecta(0.5, { capturedAt: 3_000 }), salto.estado);
  assert.equal(regresa.visible, true);
});

test('en ruta circular el progreso distingue el inicio del final aunque compartan coordenada', () => {
  const circulo: PuntoRuta[] = [A, { lat: 10.01, lon: -74 }, { lat: 10.0001, lon: -74.0001 },
    { lat: 10.01, lon: -74.01 }, A];
  const punto: EntradaVisibilidad = {
    busId: 'BUS-C', routeId: 'R-C', lat: A.lat, lon: A.lon,
    speedKmh: 0, capturedAt: 1_000, sentido: 'ida', geometria: circulo,
  };
  const inicio = decidirVisibilidadTerminal(punto);
  assert.equal(inicio.visible, false, 'quieto al inicio del recorrido circular');
  const salidaRuido = decidirVisibilidadTerminal({ ...punto, lat: 10.0018, capturedAt: 2_000, speedKmh: 20 }, inicio.estado);
  assert.equal(salidaRuido.visible, false, 'un único punto desplazado no basta');
  const saliendo = decidirVisibilidadTerminal({ ...punto, lat: 10.0025, capturedAt: 2_400, speedKmh: 20 }, salidaRuido.estado);
  assert.equal(saliendo.visible, true, 'progreso bajo creciente y fuera del radio');

  const progresoAlto = estado(false, 0.96, 'R-C');
  const llegada1 = decidirVisibilidadTerminal(punto, progresoAlto);
  assert.ok((llegada1.fraccionRecorrida ?? 0) > 0.9, 'la proyección continua el tramo final, no el inicial');
  assert.equal(llegada1.visible, false);
});

test('un bus que pasa quieto cerca de un terminal a mitad de la ruta circular no se oculta', () => {
  const circulo: PuntoRuta[] = [A, { lat: 10.01, lon: -74 }, { lat: 10.0001, lon: -74.0001 },
    { lat: 10.01, lon: -74.01 }, A];
  const muestra: EntradaVisibilidad = {
    busId: 'BUS-C2', routeId: 'R-C', lat: 10.0001, lon: -74.0001,
    speedKmh: 0, capturedAt: 1_000, sentido: 'ida', geometria: circulo,
  };
  const aMitad = estado(true, 0.5, 'R-C');
  const primera = decidirVisibilidadTerminal(muestra, aMitad);
  const segunda = decidirVisibilidadTerminal({ ...muestra, capturedAt: 3_000 }, primera.estado);
  assert.ok((segunda.fraccionRecorrida ?? 0) > 0.4 && (segunda.fraccionRecorrida ?? 1) < 0.7);
  assert.equal(segunda.visible, true);
});

test('reinicio reanuda con fracción persistida y un cambio de ruta descarta el progreso anterior', () => {
  const llegadaPersistida = estado(false, 0.97);
  const restaurado = decidirVisibilidadTerminal(enRecta(0.98), llegadaPersistida);
  assert.equal(restaurado.visible, false);
  assert.ok((restaurado.fraccionRecorrida ?? 0) > 0.95);

  const rutaNueva: EntradaVisibilidad = {
    ...enRecta(0.5), routeId: 'R-NUEVA',
    geometria: [{ lat: 10, lon: -74 }, { lat: 10.01, lon: -74 }],
  };
  const cambiado = decidirVisibilidadTerminal(rutaNueva, llegadaPersistida);
  assert.equal(cambiado.visible, true);
  assert.ok((cambiado.fraccionRecorrida ?? 0) < 0.8);
});

test('ruta, terminal, geometría o sentido ausentes fallan abiertos y explícitos', () => {
  const completa = enRecta(0);
  assert.equal(decidirVisibilidadTerminal({ ...completa, routeId: null }).motivo, 'sin_ruta');
  assert.equal(decidirVisibilidadTerminal({ ...completa, geometria: null }).motivo, 'sin_terminal');
  assert.equal(decidirVisibilidadTerminal({ ...completa, geometria: [A, { lat: 91, lon: -74 }] }).motivo, 'geometria_invalida');
  const mitadSinSentido = decidirVisibilidadTerminal(enRecta(0.5, { sentido: undefined }));
  assert.equal(mitadSinSentido.motivo, 'sentido_desconocido');
  assert.equal(mitadSinSentido.visible, true);
  const sentidoInferido = decidirVisibilidadTerminal(enRecta(0.6, { sentido: undefined, capturedAt: 2_000 }), mitadSinSentido.estado);
  assert.equal(sentidoInferido.estado.sentido, 'ida');
});

// «La terminal siempre es el primer punto del recorrido» (dueño,
// 2026-10-27): en una ruta de vuelta, el bus que se oculta al cerrar la
// vuelta está en la misma terminal donde empieza la siguiente.
test('en ruta de vuelta, el bus oculto al cerrar la vuelta reaparece al salir del primer punto', () => {
  const vuelta: PuntoRuta[] = [A, { lat: 10.01, lon: -74 }, { lat: 10.01, lon: -74.01 },
    { lat: 10, lon: -74.01 }, A];
  const punto: EntradaVisibilidad = {
    busId: 'BUS-V', routeId: 'R-V', lat: 10, lon: -74.0003,
    speedKmh: 0, capturedAt: 1_000, sentido: 'ida', geometria: vuelta,
  };
  const llega = decidirVisibilidadTerminal(punto, estado(true, 0.97, 'R-V'));
  const oculto = decidirVisibilidadTerminal({ ...punto, capturedAt: 2_100 }, llega.estado);
  assert.equal(oculto.visible, false, 'quieto al cerrar la vuelta');
  const parte = decidirVisibilidadTerminal({ ...punto, lat: 10.0015, lon: -74, capturedAt: 3_000, speedKmh: 25 }, oculto.estado);
  const sale = decidirVisibilidadTerminal({ ...punto, lat: 10.002, lon: -74, capturedAt: 3_400, speedKmh: 25 }, parte.estado);
  assert.equal(sale.visible, true, 'ya salió de la terminal en la vuelta nueva');
});
