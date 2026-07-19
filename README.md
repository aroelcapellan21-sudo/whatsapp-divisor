# Divisor para WhatsApp

App web (sin backend) para preparar contenido para WhatsApp:

- **Modo Video**: divide un video en partes de duración fija y superpone un mensaje distinto en cada parte.
- **Modo Fotos**: sube varias fotos y arma:
  - **Fotos individuales** con mensaje superpuesto (instantáneo, solo canvas).
  - **Video / diapositivas**: agrupa fotos en clips con transición (corte, fundido o zoom) y mensaje.

Todo corre **dentro del navegador** (no hay servidor, no se sube nada a ningún lado). El motor de video es [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm), cargado en tiempo de ejecución desde cdnjs.

## Estructura

```
index.html        estructura de la página
assets/style.css   estilos
assets/app.js      toda la lógica (modo video + modo fotos)
```

## Probarlo en local

No se puede abrir con doble clic (`file://`) de forma confiable porque el navegador
restringe módulos/workers en ese esquema. Hay que servirlo por http, por ejemplo:

```bash
cd whatsapp-divisor
python3 -m http.server 8080
# abrir http://localhost:8080 en el navegador
```

## Publicarlo con GitHub Pages (para probarlo desde el celular con una URL real)

1. Crear un repo nuevo en GitHub (público) y subir estos 3 archivos/carpeta
   (`index.html`, `assets/`, `README.md`), manteniendo la misma estructura.
2. En el repo: **Settings → Pages → Source: "Deploy from a branch"**, rama `main`, carpeta `/ (root)`.
3. Esperar 1-2 minutos y va a quedar publicado en:
   `https://<tu-usuario>.github.io/<nombre-del-repo>/`
4. Abrir esa URL desde el celular (Chrome/Safari) para probarla.

## Estado conocido / cosas para revisar

- El modo Video y "Fotos individuales" fueron los más probados.
- El modo "Video / diapositivas" (fotos) puede fallar o tardar mucho, sobre todo con
  la transición "Zoom" o con muchas fotos por parte — está pendiente de diagnóstico.
- Si el motor de video (ffmpeg.wasm) tarda más de 45s en cargar, o una parte tarda
  más de 90-120s en procesarse, la app corta con un error visible en vez de quedarse
  colgada (ver `withTimeout` en `assets/app.js`).
