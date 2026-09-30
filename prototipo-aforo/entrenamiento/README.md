# Cómo sacar el dataset, entrenar y calibrar

Entrenar va mejor en la torre (RTX 5070, CUDA); en el Mac también corre, con
MPS y más lento. La inferencia (`aforo.py`) no necesita GPU. El porqué de
EfficientNet y de la regla «tira pa abajo» está en el
[README del prototipo](../README.md).

Los comandos van desde `prototipo-aforo/entrenamiento/`. En Windows cambia
`/` por `\`.

## 0. Instalar (una vez, con internet)

    pip install -r ../requirements.txt
    # Torre: añade --extra-index-url https://download.pytorch.org/whl/cu128
    python -c "import torch; print(torch.cuda.get_device_capability())"   # torre: (12, 0)

La primera corrida baja los pesos de ImageNet (unos 20 MB) a `~/.cache/torch`.

## 1. Grabar (en los buses, con autorización de la empresa)

- Hay dos cámaras por bus: la frontal, que mira hacia atrás, y la trasera,
  que mira hacia adelante. Graba cada una por separado.
- Por cámara, graba 2 a 5 minutos de cada escenario: vacío, medio y lleno,
  de día y de noche, y con varios buses. Sirve más poco video de muchas
  situaciones que mucho de una sola.
- Nombra cada video por cámara, bus y hora (`frontal_bus12_0930.mp4`), no
  por estado. El nombre es la **sesión** y mantiene juntas sus fotos al
  repartir.
- Meta: **300 o más fotos útiles por clase**, en al menos 3 sesiones por
  clase. LLENO es la más difícil de conseguir; búscala en la hora pico.

## 2. Extraer fotos

    python extraer_frames.py --video frontal_bus12_0930.mp4 --salida dataset/crudo --cada-segundos 3

## 3. Etiquetar: mover cada foto a su carpeta

    dataset/etiquetado/vacio/    dataset/etiquetado/medio/
    dataset/etiquetado/lleno/    dataset/etiquetado/descartadas/

La regla se mide contra el aforo del bus (`CAPACIDAD_POR_TIPOLOGIA` en
`src/data/fleet_admin.ts`: sentados más de pie):

- **VACÍO**: quedan puestos libres. Va a menos del 40 % del aforo, más o menos.
- **MEDIO**: los puestos están llenos y hay gente de pie, pero el pasillo
  todavía se ve.
- **LLENO**: el pasillo está tapado y no se ve el fondo. Va al 85 % del aforo
  o más.
- **descartadas/**: fotos negras, movidas o en las que dudas. No entran al
  entrenamiento. Mejor descartar que etiquetar mal.

Si una foto queda entre dos estados, ponle **el más bajo**: es el mismo
sesgo que usa el modelo.

## 4. Repartir sin fuga

    python split_dataset.py --origen dataset/etiquetado --destino dataset/partido

El reparto queda en 70 % train, 15 % val y 15 % test, **por sesión**:

- las fotos de un video nunca quedan partidas entre grupos;
- el reparto se estratifica por clase;
- si una clase tiene menos de 3 sesiones, sale un aviso.

## 5. Entrenar

    python train.py --datos dataset/partido

Los valores por defecto son B0, 30 épocas, 3 de calentamiento y paciencia 8.

- Guarda `runs/aforo/<fecha>/best.pt` y `metricas.json`.
- La mejor época es la de mayor macro-F1 en val; si empatan, gana la de
  menos sobreestimación.
- Si val se queda muy por debajo de train, el modelo sobreajusta: hace falta
  más variedad de buses y horas, no más épocas.
- Si B0 se queda corto con datos suficientes, prueba
  `--arch efficientnet_b2`.

## 6. Calibrar los umbrales (en val) y medir (en test)

    python evaluar.py --modelo ../runs/aforo/<fecha>/best.pt --datos dataset/partido/val --barrer
    python evaluar.py --modelo ../runs/aforo/<fecha>/best.pt --datos dataset/partido/test \
        --umbral-lleno <el del barrido> --umbral-medio <el del barrido>

El barrido elige los umbrales con mejor macro-F1 entre los que dejan la
**sobreestimación**, es decir, decir más gente de la que hay, en 5 % o menos
(`--objetivo-sobre`).

Test se mira **una sola vez**, al final. Si lo usas para ajustar, deja de
medir la verdad.

Los umbrales finales se pasan a `aforo.py`, o se escriben en `UMBRAL_LLENO` y
`UMBRAL_MEDIO` con el número del barrido en un comentario.

## 7. Probar en video

    python ../aforo.py --source prueba.mp4 --modelo ../runs/aforo/<fecha>/best.pt \
        --umbral-lleno 0.85 --umbral-medio 0.65 --save-jsonl frontal.jsonl
    python ../fusion.py --a frontal.jsonl --b trasera.jsonl

## Llevarlo a la torre (Windows, RTX 5070)

1. Copia la carpeta `prototipo-aforo/` con USB o `scp`, **sin** `dataset/` ni
   `runs/` si ya los tienes allá. Descomprímela en `C:\yaviene\`.
2. Instala Python 3.11 o más reciente de python.org, marcando «Add to PATH»,
   y el driver NVIDIA al día.
3. Instala los requisitos con el índice cu128 (paso 0) y comprueba que salga
   `(12, 0)`.
4. Pasos 2 a 6. Para bajar el peso al Mac basta con `best.pt`, que pesa
   unos 16 MB con B0.
5. Nada de esto se instala en el backend vivo ni lo toca.
