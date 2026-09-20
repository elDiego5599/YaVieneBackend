# D10 · Hay monitoreo externo

- **Decidida**: 2026-09-12. **Toca**: backend (operación).
- **Estado**: decidida; **falta que el dueño cree la cuenta**.

## La pregunta

El backend vive en un Mac con un túnel. Si se cae de madrugada, ¿quién se
entera?

## Lo decidido

**Sí hay monitoreo externo**: un chequeo cada minuto de `/api/health` en
ngrok y en Fly, con alerta al teléfono del dueño.

## Por qué

Sin él, la respuesta a «¿quién se entera?» es «el que abra la app». En una
demo eso es el público, y en el piloto, un pasajero en un andén. Un servicio
de terceros que llama cada minuto desde fuera es lo único que comprueba lo
que de verdad importa: que el sistema **se ve desde internet**, no que el
proceso esté vivo dentro del Mac. Son dos cosas distintas y el túnel se cae
solo.

## Lo que falta

La cuenta del servicio **la crea el dueño**: aquí no se crean cuentas ni se
escriben credenciales. Hasta entonces T10.2 no se puede cerrar.

Si no llega a crearse, el valor por defecto es quedarse sin monitoreo, y eso
se anota como riesgo aceptado por escrito, no como algo que se olvidó.
