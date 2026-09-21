# Cómo sacar el dataset y entrenar (torre con RTX 5070, Windows)

Todo corre en la torre. Este Mac no tiene NVIDIA: aquí solo se escribe código.

## 0. Instalar (una vez, con internet)

    pip install -r ..\requirements.txt
    python -c "import torch; print(torch.cuda.get_device_capability())"
    # Esperado: (12, 0). Si no, actualiza torch antes de seguir.

## 1. Grabar (tú, en los buses)

- 2 cámaras por bus: frontal→atrás y trasera→adelante. Graba **por separado**.
- Por cámara: 2-5 min de cada escenario que puedas: vacío, medio, lleno,
  día y noche. Mejor poco video de MUCHAS situaciones que mucho de una sola.
- Meta realista: **300-800 fotos útiles** entre ambas vistas. Con menos de
  ~200 el fine-tune apenas se mueve; con 500+ el salto se nota.

## 2. Extraer + pre-etiquetar (ahorra ~70% del trabajo)

    python extraer_frames.py --video frontal_lleno.mp4 --salida dataset\crudo --cada-segundos 3
    python autoetiquetar.py --fotos dataset\crudo --salida dataset\pre --conf 0.30

## 3. Corregir a mano (el paso que no se puede automatizar)

Sube los `.jpg` + `.txt` a **Roboflow** (gratis, en navegador): borra falsos
positivos y encierra a los sentados que el COCO no vio. Caja ajustada a
cabeza-hombros visible, ni muy grande ni puntual. Incluye buses VACÍOS
(fotos sin cajas): también enseñan.

## 4. Repartir + entrenar

    python split_dataset.py --origen dataset\etiquetado --destino dataset
    :: apunta train:/val: de data.yaml a dataset\images\train y \val
    python train.py --data data.yaml --epochs 100

Mira `results.png` y la matriz de confusión de `runs/aforo/bus_*/`:
mAP50 > 0.7 en val = listo para el piloto. Si hay overfitting (train alto,
val bajo), más variedad de escenarios, no más épocas.

## 5. Probar el peso en el script de inferencia

    python ..\aforo_yolo11.py --source prueba.mp4 --modelo runs\aforo\bus_<fecha>\weights\best.pt

## Decisiones del piloto (ya habladas)

- **1 foto/min por cámara**: 20 buses × 2 = 40 fotos/min ≈ 1.2 s de GPU.
  Tranquilo; si quieres, baja a 30 s sin despeinar la tarjeta. Escalonar
  los buses para no mandar las 40 a la vez.
- **Fusión de las 2 cámaras (`../fusion.py`): estados, NO conteos.** Cada
  cámara publica su estado suavizado; si coinciden sale ese (confianza
  alta); si difieren sale el MÁS ALTO (confianza media, conservador: nunca
  se promete espacio). No se suman (cuentan doble el centro) ni se
  promedian (subcuentan y colapsan si una cámara se tapa).
- **Outliers**: si |conteoA - conteoB| > 10 (`DIF_MAXIMA`), `outlier=True`
  para revisión operativa (cámara tapada/sucia/caída). El bus sigue
  publicando con la cámara sana: una cámara en negro no tumba la lectura.
- **Umbrales por tipología**: <5 / 5-15 / >15 son placeholders. Calibra un
  juego para buseta y otro para padrón comparando lectura del sistema vs
  conteo manual en 50 fotos. Se calibra contra LO QUE MIDE el sistema (el
  máximo), no contra el total real: el sesgo se absorbe ahí.
- **Estados, no conteo exacto**: el detector cuenta, los umbrales deciden.
  No entrenes un clasificador VACÍO/MEDIO/LLENO: pierdes las cajas (la
  prueba visual del panel) y necesitas rehacerlo por cada tipología.

## Llevarlo a la torre (Windows, RTX 5070)

1. Copia `prototipo-aforo.zip` (USB o `scp`) y descomprime en `C:\yaviene\`.
2. Instala Python 3.11+ de python.org (marca Add to PATH) y el driver
   NVIDIA actualizado.
3. `cd C:\yaviene\prototipo-aforo` y `pip install -r requirements.txt`.
4. Verifica: `python -c "import torch; print(torch.cuda.get_device_capability())"`
   Esperado `(12, 0)`. Si no sale, actualiza torch antes de seguir.
5. Prueba en seco: `python aforo_yolo11.py --source prueba.mp4`
   (cualquier video sirve para ver el banner; el conteo real pide un
   interior de bus).
6. Dataset: pasos 1-4 de arriba. En `data.yaml` pon tus rutas `C:/...`.
7. Nada de esto se instala en el Mac ni toca el backend vivo.
