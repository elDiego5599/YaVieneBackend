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
process.env.YA_VIENE_SEED_BUSQUEDAS_DEMO = '0';

// Los backends de la suite escuchan en 127.0.0.1 y no en '::' (el valor sin
// la variable): hay máquinas sin IPv6 —el contenedor de la nube— donde
// `listen('::')` falla con EAFNOSUPPORT y no levantaba ninguno. Todas las
// pruebas le hablan al backend por 127.0.0.1, así que en el Mac no cambia
// nada de lo que se mide. Que sin la variable se escuche en '::' lo prueba
// arranque.test.ts con un entorno limpio.
process.env.HTTP_HOST = HOST_PRUEBAS;

// Las guardias de un backend expuesto (YA_VIENE_EXPUESTO=1, o NODE_ENV=
// production) exigen secretos de 32+ caracteres, y los backends de la suite
// heredan este entorno con secretos de prueba cortos: con cualquiera de las
// dos exportada en la consola —la primera vive en local.env— caían 38
// pruebas. Las que miden esas guardias le pasan su entorno a validateConfig
// o al hijo que arrancan, no lo leen de aquí.
delete process.env.YA_VIENE_EXPUESTO;
delete process.env.NODE_ENV;

// La cuenta de servicio de FCM (D13) puede vivir en local.env. Un backend de
// la suite que la herede mandaría pushes de verdad a los teléfonos de quien
// tenga un aviso armado contra el servidor vivo. Las pruebas del push le
// pasan su propia cuenta falsa y su servidor falso.
delete process.env.YA_VIENE_FCM_CREDENCIALES;
delete process.env.YA_VIENE_FCM_API;

// Lo mismo con la cuenta de correo del buzón (D14): un backend de la suite
// que la herede mandaría reportes de prueba al Gmail del equipo. Las pruebas
// del buzón le pasan su cuenta falsa y su servidor SMTP falso.
delete process.env.YA_VIENE_CORREO_USUARIO;
delete process.env.YA_VIENE_CORREO_CLAVE;
delete process.env.YA_VIENE_CORREO_DESTINO;
delete process.env.YA_VIENE_SMTP;
