# D12 · No se instala `google/artemis` antes del pitch

- **Preguntada por el dueño**: 2026-09-18. **Toca**: herramienta, ningún repo.
- **Estado**: decidida (no instalar). No bloquea ninguna tarea.

## La pregunta

¿Conviene instalar `google/artemis` para probar la app?

## Qué es

Un servidor MCP de Google (Apache-2.0) que maneja un Android con lenguaje
natural —abre la app, toca, escribe, mira la pantalla— apoyándose en `adb`,
`scrcpy` y FFmpeg.

## Lo que aportaría

Las pruebas que hoy se hacen con el teléfono en la mano podrían dictarse en
vez de hacerse a dedo. Nada de lo que ya está automatizado lo necesita: las
pruebas de `app_pasajero` no tocan un dispositivo.

## Lo que cuesta

- Es **solo Android**, y la regla del proyecto obliga a probar en Android
  **e** iOS: la mitad del trabajo manual se queda igual.
- Su `start.sh` instala herramientas por su cuenta y escribe configuración
  de MCP y reglas **globales** en los editores, o sea fuera de este
  proyecto.
- Es un repositorio joven, con decenas de incidencias abiertas y cambios sin
  fusionar.

## Lo decidido

**No antes del pitch.** Si después se quiere, instalarlo a mano —sin
`start.sh`—, apuntando el MCP solo a este proyecto, y usarlo como ayuda para
las pruebas manuales, **nunca** como algo de lo que dependa la CI: un agente
que mira la pantalla no da el mismo resultado dos veces, y una prueba que a
veces miente es peor que ninguna.
