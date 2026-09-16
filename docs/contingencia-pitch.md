# Contingencia del pitch — la grabación y qué decir

Para el caso peor: durante la presentación no hay red. Ni el wifi del sitio, ni
el punto de acceso del teléfono, ni datos. El túnel no sirve, Fly tampoco —está
al otro lado de la misma red que falta— y no hay nada que reiniciar. Entonces se
enseña una grabación hecha antes, con el sistema de verdad, y se dice lo que dice
este documento.

La grabación no es un adorno: es la única parte de la demo que no depende de la
red del sitio. Se hace con tiempo, no el mismo día.

Lo demás —túnel caído, backend caído, base que no abre— está en
[`runbook.md`](runbook.md) y tiene arreglo en el momento. Esto es solo para
cuando no hay nada que arreglar.

## Qué se graba

Una sola pasada de la demo real, de tres a cuatro minutos, con las dos pantallas:
el teléfono con la app del pasajero y el Mac con el panel de control. No hace
falta que salgan a la vez: es más fácil grabar el Mac (panel) y el teléfono por
separado y enseñar la que toque.

El orden, que es el mismo de la demo en vivo:

1. **El panel, ya abierto y en «En línea»**. Se ve la flota moviéndose. Se deja
   correr unos segundos: lo que convence es que las posiciones cambien solas.
2. **El pasajero abre la app**. Entra directo al mapa, sin cuenta ni inicio de
   sesión.
3. **Elige empresa y ruta**: Sobusa → `R-106`, «Calle 72 - Uninorte». Es la ruta
   de la demo, la única cuyos buses van a 400 ms; en las demás el movimiento se
   ve más a saltos.
4. **Toca el mapa** para poner su punto de espera, y luego **toca un bus**.
   Salen los dos de la ruta: `B-055` viene hacia el punto y `B-042` ya pasó.
   Conviene tocar `B-055`.
5. **La tarjeta del bus**: el número grande con la distancia («850», «m de ti»)
   bajando sola mientras el bus se acerca. Distancia, no tiempo estimado: eso es
   deliberado y vale la pena decirlo en voz alta mientras se graba.
6. **Armar el aviso** con «Avisarme cuando esté cerca». Si el bus ya está a menos
   de un kilómetro el botón sale bloqueado y dice «El bus ya está cerca»: por eso
   se toca `B-055` cuando todavía viene lejos.
7. **Volver al panel** y mostrar el mismo bus ahí, con su placa. Es la frase que
   cierra: las dos pantallas están viendo lo mismo, al mismo tiempo.

Si además se quiere enseñar que el sistema aguanta un golpe, se graba aparte una
pasada de `bash demo-crash-recovery.sh` (está en `YaViene`): mata el backend, lo
levanta y enseña que las apps vuelven solas. Dura menos de un minuto. Va en un
archivo aparte, no pegado al anterior: en vivo casi nunca hay tiempo para los
dos.

## Antes de grabar

```bash
cd /Users/diegoangarita/YaViene/YaViene && bash check-demo.sh
```

Tiene que salir todo en verde: túnel, buses publicando y base recibiendo
posiciones frescas. Grabar con un bus caído deja una grabación con un bus quieto
que a los cinco minutos dice «Sin señal», y esa grabación no sirve.

También, antes de empezar:

- Silenciar las notificaciones del Mac y del teléfono (No molestar). Un mensaje
  entrante en mitad de la grabación la obliga a repetirse.
- Batería del teléfono por encima del 50 %, o enchufado: el aviso de batería baja
  sale encima de todo.
- En el teléfono, cerrar lo que haya abierto: la grabación se hace de una sola
  pasada y no se edita.

## Cómo se graba

**El Mac (el panel).** macOS graba la pantalla desde la terminal:

```bash
mkdir -p ~/Movies/YaViene
/usr/sbin/screencapture -v -k -x ~/Movies/YaViene/panel-$(date +%Y%m%d).mov
```

`-v` graba vídeo, `-k` muestra los clics —se ve dónde se toca— y `-x` quita los
sonidos del sistema. Se detiene con `Ctrl+C` en esa misma terminal. La primera
vez macOS pide permiso de Grabación de pantalla para la terminal; concederlo y
repetir el comando. Con `-V 240` se le pone un tope de segundos, por si se
escapa. Si se prefiere no usar la terminal, `Cmd+Shift+5` hace lo mismo con
ratón.

**El teléfono (el pasajero).** Con el grabador de pantalla del propio teléfono:
en Android está en el panel de ajustes rápidos, y en iPhone en el centro de
control. Aquí no hay `adb` ni `scrcpy` instalados, así que el camino por cable
solo existe para iPhone: QuickTime Player → Archivo → Nueva grabación de
película → como fuente, el iPhone conectado. Grabar en el teléfono y pasar el
archivo después es más simple y no depende de ningún cable.

## Dónde queda

`~/Movies/YaViene/` en el Mac, **fuera de los tres repos**: son archivos de
decenas de megas y no tienen por qué viajar en un `git push`.

Y el día de la presentación, la grabación tiene que estar en **dos sitios que no
necesiten red**:

- en el Mac, en esa carpeta;
- en el teléfono que se lleva, en su galería.

Nada de enlaces a la nube: si falta la red, un enlace es un papel mojado. Se
comprueba abriendo el archivo con el wifi apagado, el día anterior.

## Qué decir si toca usarla

Se dice de frente, sin disimular. La frase corta primero, mientras se abre la
grabación:

> «No tenemos red aquí. Esto que van a ver está grabado esta semana con el
> sistema funcionando; es exactamente lo que hace, sin recortes.»

Después, mientras corre, se narra lo mismo que se habría narrado en vivo: la
distancia que baja sola, el aviso que se arma, el panel viendo el mismo bus. Y al
terminar, la explicación de por qué esto no es un problema del producto:

> «El sistema vive en un servidor con su propia conexión; lo que falló aquí es la
> red de esta sala. Si quieren, al salir lo abrimos con datos del teléfono y lo
> ven en vivo en un minuto.»

Y esa última oferta se cumple: en cuanto haya una red, el punto de acceso del
teléfono basta —el dominio del túnel no cambia al cambiar de red, así que no hay
que recompilar ni reinstalar nada.

Qué no decir: que «se cayó el servidor» (no se cayó), que «nunca pasa» (no se
sabe), ni pedir disculpas tres veces. Una vez, y seguir.

## Qué no hacer en vivo

- No reiniciar ngrok ni el backend delante de la gente para ver si vuelve: se
  tarda más en explicar lo que se está tecleando que en pasar a la grabación.
- No reinstalar ni recompilar las apps. La dirección va grabada dentro del
  binario; cambiarla es volver a compilar, y eso son minutos.
- No probar el punto de acceso del teléfono por primera vez ahí. Se prueba antes
  (ver «Que el Mac se levante solo» en el runbook).

## Lo que esta contingencia no cubre

- **La grabación en sí todavía no existe**: este documento dice cómo hacerla, qué
  tiene que salir en ella y qué decir. Grabarla necesita el teléfono, el panel y
  una pasada real de la demo, así que la hace el dueño (T10.4).
- Un fallo del propio equipo —el Mac que no enciende, el teléfono que muere— no
  lo arregla ninguna grabación guardada solo ahí. Por eso van dos copias, en dos
  aparatos distintos.
- Que el sitio no tenga proyector o no acepte el cable: eso se pregunta antes, no
  se resuelve aquí.
