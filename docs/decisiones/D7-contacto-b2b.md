# D7 · El contacto de empresas es por WhatsApp

- **Decidida**: 2026-09-12. **Toca**: `YaVieneWeb`.
- **Estado**: vigente.

## La pregunta

La página de empresas tiene un formulario de contacto. ¿Manda a un endpoint
propio o abre WhatsApp?

## Lo decidido

**WhatsApp, definitivo.** No se toca nada salvo dejarlo escrito en el
código.

## Por qué

Un endpoint propio significa un servicio que recibe correos de desconocidos,
los guarda en algún sitio, se protege de bots y no se cae. Es un sistema
entero para un puñado de mensajes al mes que hoy llegan a un teléfono que ya
está encendido.

Una consecuencia concreta: al no haber endpoint, **no hay que abrirle un
`connect-src`** a nada en la política de seguridad de contenido de la web.
La página no hace ninguna petición saliente, y eso es una superficie de
ataque que no existe.

## Lo que se hizo

T3.16 rama WhatsApp: solo el comentario que lo explica en
`contact-form.ts:69`. Ni endpoint ni `connect-src`.
