# Ya Viene Backend

Backend en tiempo real para la app Ya Viene. Recibe posiciones GPS via **MQTT** (desde la app del conductor) y las retransmite via **WebSocket** (Socket.io) a los pasajeros.

## Arquitectura

Conductor (MQTT) → Broker Aedes → Node.js Bridge → Socket.io → Pasajero (WebSocket)

## Inicio rápido

```bash
npm install
npm run build
npm start
```

Para desarrollo con hot-reload:
```bash
npm run dev
```

Servidor corre en `http://localhost:3000`.

## Endpoints REST

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/health` | Health check |
| GET | `/api/companies` | Lista de empresas |
| GET | `/api/companies/:id/routes` | Rutas de una empresa |
| GET | `/api/routes/:routeId/positions` | Posiciones actuales de una ruta |
| GET | `/api/buses/:busId` | Posición de un bus específico |
| POST | `/api/gps` | Enviar posición GPS (alternativa a MQTT) |
| POST | `/api/drivers/register` | Registrar conductor |

## WebSocket (Socket.io)

Conectar en `http://localhost:3000/ws`.

### Eventos

| Evento | Dirección | Payload |
|--------|-----------|---------|
| `subscribe:route` | Cliente → Servidor | `routeId: string` |
| `unsubscribe:route` | Cliente → Servidor | `routeId: string` |
| `positions:batch` | Servidor → Cliente | `{ routeId, buses: BusPosition[] }` |
| `bus:position` | Servidor → Cliente | `BusPosition` |
| `driver:register` | Cliente → Servidor | `{ phoneNumber, name, routeId }` |
| `driver:registered` | Servidor → Cliente | `{ phoneNumber, routeId }` |

## MQTT

Conectar en `mqtt://localhost:8883`. Publicar en `gps/{phoneNumber}` con JSON:

```json
{
  "busId": "BUS-001",
  "lat": 10.9650,
  "lon": -74.8010,
  "heading": 45,
  "speedKmh": 35
}
```
