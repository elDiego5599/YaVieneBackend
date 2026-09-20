# D1 · Fly es espejo de la demo ahora, respaldo real en el piloto

- **Decidida**: 2026-09-12. **Toca**: backend.
- **Estado**: vigente.

## La pregunta

El backend vive en un Mac, detrás de un túnel de ngrok. Fly es el respaldo
para cuando ese Mac no esté. ¿Qué enseña Fly: la flota simulada o los buses
de verdad?

## Lo que había

Fly corría la flota demo sin que nadie lo hubiera pedido: `fly.toml` no
definía `YA_VIENE_FLOTA_DEMO`, el `Dockerfile` pone `NODE_ENV=production` y
el backend la encendía por defecto en ese caso. Y tiene su propia SQLite,
sin los administradores que se crean en local: un panel que entra al Mac no
puede entrar a Fly.

## Lo decidido

Dos etapas, no una:

- **Ahora (pitch)**: Fly es un **espejo de la demo**. `YA_VIENE_FLOTA_DEMO`
  queda escrito explícitamente en `fly.toml`, y las dos apps muestran que
  están contra el respaldo. Que se vea la flota simulada deja de ser un
  accidente y pasa a ser lo que se quiere.
- **Antes del piloto**: Fly pasa a **respaldo real**: sin demo, con el mismo
  catálogo y los mismos administradores, y el equipo GPS publicando también
  allí. Esa segunda etapa depende de [D2](D2-equipo-gps.md).

## Por qué no la otra

Un respaldo real hoy no tendría a quién respaldar: no hay buses reales
publicando. Sincronizar catálogo y credenciales entre dos bases para que el
respaldo enseñe lo mismo que el principal es trabajo que solo tiene sentido
cuando hay algo real que reflejar, y hacerlo antes significa mantenerlo
antes.

Lo que sí era inaceptable era el estado anterior: un respaldo que enseña
buses inventados **sin decirlo** es peor que no tener respaldo. Quien se
cayera al respaldo durante una demo estaría enseñando una simulación
creyendo que enseña el piloto.

## Lo que se hizo

T2.4 (rama espejo demo) y el indicador de respaldo de T2.3 en las dos apps.
La regla de no desplegar en Fly hasta el día antes de presentar sigue
valiendo para la demo que se va a mostrar.
