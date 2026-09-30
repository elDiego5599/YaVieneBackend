# Aforo del bus: VACÍO / MEDIO / LLENO

Prototipo que le dice al pasajero cómo va el bus que espera. Mira la imagen
de las cámaras del bus, la clasifica en **VACÍO**, **MEDIO** o **LLENO** y
emite un JSONL por cámara; `fusion.py` junta las dos cámaras en un estado.
Todavía no está conectado al backend ni a la app.

| Archivo | Qué hace |
|---|---|
| `modelo.py` | Clases, arquitectura, preprocesado y formato del peso. Lo único que comparten entrenamiento e inferencia. |
| `aforo.py` | Inferencia en vivo: video o RTSP → estado cada N segundos. |
| `fusion.py` | Dos cámaras → un estado del bus. |
| `entrenamiento/` | Sacar fotos, repartirlas, entrenar y calibrar. Paso a paso en su [README](entrenamiento/README.md). |
| `tests/` | `npm run test:aforo` desde la raíz del backend. Corren sin torch. |

## Por qué un clasificador y no un detector de personas

La primera versión contaba cabezas con YOLO11 y comparaba el conteo con la
capacidad del bus. Se descartó por tres razones:

1. **Oclusión.** En un bus lleno la gente se tapa entre sí. El detector
   cuenta de menos justo cuando más importa, y el error crece con el aforo.
2. **La pregunta tiene tres respuestas, no un número.** Al pasajero no le
   sirve «23 personas»; le sirve saber si cabe. Un clasificador aprende
   directamente cómo se ve un bus lleno: el pasillo tapado, la gente de pie
   pegada.
3. **El sesgo se controla con un número.** Con probabilidades por clase, se
   fija cuánta evidencia hace falta para decir «lleno» (ver abajo). Con un
   conteo el sesgo queda escondido en la oclusión.

## Por qué EfficientNet

- **Mucha exactitud por cada cálculo.** EfficientNet escala a la vez
  profundidad, ancho y resolución con una sola regla («compound scaling»).
  B0 tiene unos 5,3 M de parámetros y 0,39 GFLOPs por foto, y en ImageNet
  supera a redes varias veces más pesadas.
- **No necesita GPU para funcionar.** Medido en el Mac del backend (Apple
  M4, torch 2.14, B0 a 224 px, una foto): **6,2 ms en MPS** y **78,5 ms en
  CPU**. Con una foto cada 2 s por cámara, una CPU atiende decenas de
  cámaras. La RTX 5070 de la torre se usa para **entrenar**, no hace falta
  para servir.
- **Aprende con pocas fotos.** Parte de los pesos de ImageNet y solo ajusta
  las tres clases. Con pocos cientos de fotos por clase ya da una señal
  útil. Es lo que pasa al comienzo: el dataset lo grabamos nosotros.
- **Ya funcionó en una tarea parecida.** El dueño la usó para clasificar
  retinopatía diabética en fondo de ojo: pocas clases, ordenadas por
  gravedad, pocos datos etiquetados y un error que cuesta más que el otro.
  Aquí es igual: VACÍO < MEDIO < LLENO, y decir «lleno» de más cuesta plata.
- **Licencia limpia.** torchvision es BSD-3. Ultralytics (YOLO) es AGPL-3.0:
  usarlo en un servicio comercial obliga a abrir el código o a pagar la
  licencia empresarial.
- **Escala sin cambiar código.** Si B0 se queda corto en val, se prueba
  `--arch efficientnet_b2` (260 px) o `efficientnet_v2_s` (384 px). El
  resto del flujo no cambia.

**Alternativas que se miraron.**
- *DenseNet-121*: exactitud parecida en transfer learning, pero con unas 7 veces
  el cálculo por foto (2,9 GFLOPs) y más memoria. No gana nada aquí.
- *ResNet-50*: más pesada que B0 y peor en ImageNet.
- *Plan B si faltan datos*: congelar DINOv2 y entrenar solo una cabeza
  lineal. Las rutas de entrenamiento e inferencia ya aíslan la arquitectura
  en `modelo.py`.

## Tira pa abajo

Decir «lleno» de un bus con espacio le quita pasajeros a la empresa, porque la
gente lo deja pasar. Por eso un estado alto necesita más evidencia que uno
bajo. `decidir` en `aforo.py` mira la probabilidad **acumulada** de arriba
abajo:

- **LLENO** si P(lleno) ≥ `UMBRAL_LLENO` (0,80);
- si no, **MEDIO** si P(medio) + P(lleno) ≥ `UMBRAL_MEDIO` (0,60);
- si no, **VACÍO**.

Los dos umbrales pasan de 0,5. Cuando la red duda entre dos estados, gana
el más bajo.

Además:

- Se promedian las probabilidades de las últimas `--ventana` fotos (5 por
  defecto), no los estados, para que el estado no parpadee.
- La fusión de dos cámaras se queda con el estado más bajo.

**Los umbrales 0,80 y 0,60 son provisionales.** Hay que calibrarlos con
`entrenamiento/evaluar.py --barrer` sobre `val` y fotos reales. El barrido
busca el par con mejor macro-F1 entre los que dejan la **sobreestimación**
(predicho > real) por debajo de `--objetivo-sobre`, que es 5 % por defecto.

## Fusión de las dos cámaras

`fusionar(a, b)` devuelve `(estado, confianza, outlier)`:

| Caso | Estado | Confianza | Outlier |
|---|---|---|---|
| Iguales | ese | alta | no |
| Difieren | el más bajo | media | solo si es VACÍO contra LLENO (cámara tapada, sucia o mal apuntada) |
| Solo una cámara | la que hay | baja | no |

## De dónde salen las imágenes

Igual que el GPS, las imágenes no las genera Ya Viene. Las empresas ya ven
sus cámaras en tiempo real en la plataforma de su proveedor de flota, y
`aforo.py --source` acepta cualquier RTSP o video que esa plataforma
exponga. No hay equipo nuevo en el bus. El contador de puerta queda
descartado mientras no se sepa si el bus lo trae y si está conectado.

## Privacidad (Ley 1581)

La imagen de un pasajero es un dato personal.

- `aforo.py` procesa cada foto en memoria y la descarta. Al JSONL solo
  salen el estado y las probabilidades.
- Las fotos del dataset y los pesos (`dataset/`, `runs/`, `*.pt`) están en
  `.gitignore` y nunca entran al repo.
- Las fotos de entrenamiento se graban con autorización de la empresa y
  se guardan solo en la máquina que entrena.

## Instalar

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

En la torre con la RTX 5070, los pasos de CUDA están en `requirements.txt`.

Si la descarga de los pesos de ImageNet falla con `CERTIFICATE_VERIFY_FAILED`,
el Python de python.org en macOS no trae certificados. Hay dos salidas:

- correr una vez `Install Certificates.command`, que está en la carpeta de
  Python en Aplicaciones;
- o `pip install certifi` y exportar
  `SSL_CERT_FILE=$(python -c "import certifi;print(certifi.where())")`.
