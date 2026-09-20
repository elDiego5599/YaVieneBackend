# D11 · Las librerías se revisan cada mes

- **Decidida**: 2026-09-12. **Toca**: los tres repos.
- **Estado**: política vigente.

## La pregunta

¿Cuándo se sube una librería? ¿Cuando avisa una vulnerabilidad, cuando algo
se rompe, o cada tanto?

## Lo decidido

**Revisión mensual**: `npm audit` y `flutter pub outdated` en los tres
repos, las menores en un lote y **las mayores una por una**, cada una con la
verificación completa y sus compilaciones.

## Por qué

Las dos alternativas fallan de forma conocida. Subir solo cuando avisa una
vulnerabilidad deja el proyecto meses atrás, y entonces el salto obligado es
de varias mayores a la vez, justo cuando hay prisa. Subir todo lo que salga
convierte cada semana en una cacería de regresiones ajenas.

Las mayores van de una en una porque una mayor **cambia la interfaz a
propósito**: si se suben tres juntas y algo se rompe, no se sabe cuál fue.

## Lo que la política deja fuera a propósito

Una mayor puede quedarse sin subir si el costo no se justifica, siempre que
quede escrito por qué. Hoy están así, entre otras: Riverpod 3 (reescribir
todos los proveedores de las dos apps), y las que tocan permisos nativos
—`geolocator`, `permission_handler`— que se prueban en teléfono y no a
ciegas. `maplibre_gl` no sube porque el dueño lo pidió.

Rige para T8.2 y para T9.5 a T9.7.
