// Se carga antes de cada archivo de prueba (`--import ./tests/entorno.ts` en
// los scripts de `package.json`) y fija lo que la suite da por hecho sin
// importar el entorno de quien la corre.
//
// La suite asume la base sembrada: las pruebas de flota, de carga y de caos
// recorren las rutas de EMP-01 que pone la siembra. Desde T9.3 la siembra se
// apaga con YA_VIENE_SEED_DEMO=0 (y por defecto en producción), así que un
// operador con esa variable exportada veía caer caos_catalogo y carga y la
// corrida colgarse después. Las pruebas de la siembra apagada
// (`siembra.test.ts`) arrancan sus bases con un entorno limpio y no dependen
// de esto.
import { HOST_PRUEBAS } from './red_pruebas';

process.env.YA_VIENE_SEED_DEMO = '1';

// Los backends de la suite escuchan en 127.0.0.1 y no en '::' (el valor sin
// la variable): hay máquinas sin IPv6 —el contenedor de la nube— donde
// `listen('::')` falla con EAFNOSUPPORT y no levantaba ninguno. Todas las
// pruebas le hablan al backend por 127.0.0.1, así que en el Mac no cambia
// nada de lo que se mide. Que sin la variable se escuche en '::' lo prueba
// arranque.test.ts con un entorno limpio.
process.env.HTTP_HOST = HOST_PRUEBAS;
