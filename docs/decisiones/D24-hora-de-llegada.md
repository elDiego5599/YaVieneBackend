# D24. La hora de llegada es un rango, junto a la distancia

**Fecha:** 13 de noviembre de 2026 (la decidió el dueño el 11)  
**Afecta:** core, app pasajero; en el backend, un campo de la posición pública.

## Decisión

La app dice a qué hora llega el bus como un **rango** («Llega de 3:42 a
3:47 p. m.»), siempre junto a la distancia y nunca en su lugar. La regla del
producto pasa de «distancia, no ETA» a «distancia siempre; la hora, un rango
honesto a su lado».

El rango sale de lo que de verdad avanzaron los buses de esa ruta mientras
la app los veía (`RitmoDeRuta`, core), no de un horario ni de una velocidad
supuesta:

- Cada bus se mide por minutos: lo que avanzó por la ruta en al menos 60 s
  seguidos de posiciones.
- Un minuto por debajo de 0,5 m/s es un bus parqueado y no cuenta; uno por
  encima de 25 m/s es un salto del GPS y tampoco. Un bus sin señal o con
  más de un minuto callado corta su minuto: no se promedia lo que no se vio.
- Lo de hace más de 20 minutos se olvida.
- El rango va del ritmo de la mitad rápida de esos minutos al de la mitad
  lenta, cada uno como metros entre segundos.
- **Con menos de seis minutos vistos no dice nada**, y la pantalla queda
  como antes, solo con la distancia.

Solo se dice de lo que hace un bus: cuándo llega a donde se toma y cuándo
llega a donde uno se baja. No se inventa un tiempo de caminata.

Con la flota de ejemplo el rango lleva la etiqueta «Simulación» (D8): la
posición pública trae `simulado`, que sale de `buses.is_demo`, y basta un
bus de ejemplo entre los medidos para rotularlo.

## Por qué

La distancia sola obliga a la persona a hacer la cuenta, y la hace peor que
el teléfono. Un minuto exacto promete lo que nadie puede cumplir con el
tráfico de Barranquilla; un rango sacado de los buses que acaban de pasar
por ahí dice lo que se sabe y con cuánta duda. Y callar cuando no hay datos
es más honesto que una cifra de relleno.

## Lo que no cubre

- **Trancón total.** Un bus detenido en un trancón se ve igual que uno
  parqueado: no suma, y el rango sigue con el ritmo de antes hasta que a
  los 20 minutos se calla.
- **La app recién abierta.** Los seis minutos se juntan entre todos los
  buses de la ruta, así que con seis buses andando tarda un minuto; con uno
  solo, seis.
- **El tramo que falta.** El ritmo es el de toda la ruta, no el del tramo
  que le queda al bus: una ruta con un extremo lento y otro rápido da un
  rango más ancho, no uno equivocado.

## Lo que falta

Las medidas (60 s, seis minutos, mitades, 20 minutos) están puestas con
criterio y se calibran con buses reales en el piloto. La web y el aviso por
push del servidor siguen solo con la distancia.
