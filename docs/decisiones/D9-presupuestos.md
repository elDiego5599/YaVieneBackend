# D9 · Las metas de rendimiento son las de T7.1

- **Decidida**: 2026-09-12. **Toca**: los tres repos.
- **Estado**: vigente.

## La pregunta

«Va rápido» no se puede verificar. ¿Contra qué números se mide?

## Lo decidido

Esta tabla. Toda la Fase 7 mide contra ella:

| Métrica | Presupuesto |
|---|---|
| Pasajero, cuadro p95 (montaje + pintado) en el Android más modesto de la matriz, 30 buses en la ruta | ≤ 16 ms |
| Pasajero, arranque en frío hasta el primer bus, por ngrok | ≤ 3 s |
| Latencia captura → teléfono p95, por ngrok | ≤ 1,5 s |
| Panel, cuadro p95 con 300 buses | ≤ 16 ms |
| Backend, ingesta → emisión p95 con 300 buses a 1 Hz | ≤ 50 ms |
| Web móvil (Lighthouse, perfil móvil) | LCP ≤ 2,5 s · CLS ≤ 0,1 · TBT ≤ 200 ms |
| Batería Android, 60 min con aviso armado y pantalla apagada | ≤ 4 % |

## Por qué estos números

Los 16 ms son los 60 cuadros por segundo de la pantalla: pasarse de ahí es
lo que se ve como tirones. Los de la web son los umbrales «buenos» de
Lighthouse, que son los que va a usar cualquiera que mida la página por su
cuenta. El resto salen de lo que el producto promete: un mapa que se mira de
pie en un andén, con el teléfono en la mano y datos móviles.

## Lo que ya se midió

La carga del backend está muy por debajo de su meta: con 1000 buses, p95 de
captura a pasajero de 105 ms, y el piso de esos 105 ms es la ventana de
agrupación de 100 ms del socket, no el trabajo del servidor.

Los presupuestos de peso de la web ya corren en su CI y fallan la
construcción si alguien la engorda.

## Lo que falta

Casi todo lo demás necesita teléfonos en la mano: la matriz de dispositivos,
la batería y el perfilado. No se miden a ciegas.
