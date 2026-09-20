# D3 · El pasajero no tiene cuenta

- **Decidida**: 2026-09-12. **Toca**: `app_pasajero`, web.
- **Estado**: vigente.

## La pregunta

¿Hay que registrarse para ver por dónde viene el bus?

## Lo que había

El router de la app exigía `AuthStatus.verified` para llegar al mapa, al
onboarding y a los avisos. Detrás había Firebase. Y el backend **no validaba
nada de Firebase**: cero referencias. La cuenta era un muro sin nada al otro
lado.

## Lo decidido

**Se quita el muro.** El mapa y los avisos funcionan sin cuenta. Se van el
inicio de sesión, el registro y Firebase de `app_pasajero` si no le queda
otro uso, y con él `google-services.json`.

## Por qué

Una cuenta se justifica si guarda algo del otro lado. Aquí no guardaba nada:
los avisos se calculan y se guardan **en el teléfono**, como dice
`privacidad.html`. Lo único que hacía el registro era pedir un dato personal
para devolver un servicio que no lo necesita, y poner una pantalla entre el
usuario y lo único que vino a hacer.

Y arrastraba obligaciones reales: con cuentas, las tiendas exigen poder
borrarlas desde la app y pedir consentimiento en el registro.

## Qué cambió con ella

- **T5.1** (borrar cuenta) y **T5.3** (consentimiento de registro) dejan de
  ser obligatorias: no hay cuentas que borrar ni registro que autorizar.
- **T5.2** sigue: la privacidad va enlazada en la app igual.
- **T5.7**: las fichas de tienda declaran que no se recogen datos personales.
- `privacidad.html` y `terminos.html` se reescriben sin correo ni nombre.

## Lo que queda pendiente

Quitar el muro dejó al pasajero entrando directo al mapa. Falta revisar si
el recorrido completo —la primera instalación, la aceptación de las
políticas de uso— quedó bien sin él; está anotado como pendiente y no forma
parte de esta decisión.
