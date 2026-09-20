# D2 · Qué equipo GPS y qué protocolo

- **Preguntada**: 2026-09-12. **Toca**: backend (Fase 4 entera).
- **Estado**: **abierta**. No depende del dueño desde el 2026-09-18.

## La pregunta

El GPS es hardware montado en el bus. ¿Cuál? De eso depende si publica el
contrato de Ya Viene directamente o si hace falta un traductor en medio.

## Lo que hay hoy

Un solo camino de ingesta: `POST /api/auth/login` con línea y PIN devuelve
un JWT de 24 horas sin refresco, y con ese token el equipo entra por MQTT
sobre WSS publicando JSON propio. Está escrito en
[`integracion-gps.md`](../integracion-gps.md) y es lo que usa el simulador
de la demo.

## Las salidas

- **a) El equipo es programable** (MQTT sobre TLS o WSS, JSON): se le da una
  credencial de dispositivo y publica el contrato tal cual. Es la Fase 4
  como está escrita.
- **b) Es un tracker comercial con protocolo propio**: hace falta una
  pasarela que traduzca y publique como si fuera un dispositivo. Proyecto
  aparte, fuera del pitch.

## Por qué sigue abierta

El dueño mandó un PQRS al Área Metropolitana de Barranquilla el 2026-09-18 y
la respuesta tiene un plazo legal de unos 30 días hábiles. **No hay nada que
hacer aquí mientras tanto, y tampoco lo hay del lado del dueño**: quien
tiene que contestar es el AMB.

## Qué pasa mientras

El pitch va con el simulador por el camino actual, que es el mismo que
usaría un equipo programable. **No hay piloto con buses reales hasta que
esto se responda**: sin saber qué equipo es, cualquier credencial que se
provisione es una suposición.
