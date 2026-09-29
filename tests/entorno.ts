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
process.env.YA_VIENE_SEED_DEMO = '1';
