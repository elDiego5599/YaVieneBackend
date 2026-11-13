# D21. Los puntos de recarga salen de una fuente pública citada o dicen «Ejemplo»

- **Decidida**: 2026-11-12. **Toca**: `ya_viene_core`, `app_pasajero`. El
  backend no cambia: el archivo viaja dentro de la app.
- **Estado**: decidida, falta confirmar la licencia de los datos del AMB.

## La pregunta

El mapa del pasajero puede enseñar dónde recargar la tarjeta del bus. ¿De
dónde salen los puntos, y qué se hace cuando no hay de dónde?

## Lo decidido

1. **Cada punto lleva su fuente**: nombre, URL y fecha de consulta
   (`FuenteCitada`). Sin fuente, el punto se rotula «Ejemplo» (`FuenteEjemplo`)
   y la ficha dice que no es un lugar real, como la flota demo (D8).
2. **Fuente de hoy**: el mapa «Puntos para recargas SIBUS» del Área
   Metropolitana de Barranquilla, enlazado desde https://sibusoficial.ambq.gov.co/
   y consultado el 2026-11-11. Se bajó su KML público y se convirtió con
   `app_pasajero/tool/puntos_recarga_desde_kml.py` (solo librería estándar) a
   `assets/data/puntos_recarga.json`: 1.416 puntos. No se copió de Google
   Maps ni se inventó ninguno.
3. **Limpieza**: se descartaron los puntos sin coordenadas (Van 1 a 3), uno
   fuera del área metropolitana y uno de nombre dudoso (DONDE ABDON). La
   fuente no trae horarios, así que la ficha no los muestra.
4. **Capa apagada por defecto.** Son 1.416 puntos y, sin pedirlos, solo
   taparían los buses. Puntos sin nombre en el mapa (regla del producto: ni
   sitios ni negocios pintados); el nombre vive en la ficha.
5. **Cerca** es hasta 1 km en línea recta. La píldora cuenta los de ese
   radio, o dice «No hay puntos de recarga cerca».
6. **«Cómo llegar»** abre Mapas de Apple (iPhone) o Google Maps (Android) a
   pie, con la coordenada del punto. La app no calcula la ruta.

## Por qué

- Un dato de recarga inventado manda a una persona a un sitio que no existe.
  Con fuente y fecha se puede verificar, y con «Ejemplo» nadie lo confunde.
- Copiar un mapa privado es un riesgo legal y un dato que no podemos
  actualizar; el del AMB es el oficial del sistema.
- Dentro de la app no hay endpoint nuevo, ni datos personales, ni coste.

## Pendiente

- **Licencia**: la página del AMB no declara una licencia de uso del KML.
  Hay que preguntarle al AMB (junto a la PQRS de D2) y, mientras, el dato
  se muestra siempre con su fuente. Ver `FALTANTES.md`.
- 34 puntos comparten coordenadas con otro: se dejaron, la fuente los trae
  así.
- Refrescar el archivo es volver a correr el conversor con un KML nuevo.
