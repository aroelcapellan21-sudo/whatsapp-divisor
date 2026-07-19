  // ============================================================
  // shared helpers
  // ============================================================
  const errorBanner = document.getElementById('errorBanner');
  function showError(msg){ errorBanner.textContent = msg; errorBanner.style.display = 'block'; }
  function clearError(){ errorBanner.style.display = 'none'; }

  function formatTime(s){
    s = Math.max(0, Math.round(s));
    const m = Math.floor(s/60), sec = s%60;
    return String(m).padStart(2,'0') + ':' + String(sec).padStart(2,'0');
  }

  function getWrappedLines(ctx, text, maxWidth){
    const words = text.split(/\s+/);
    const lines = []; let current = '';
    for (const word of words){
      const test = current ? current + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && current){ lines.push(current); current = word; }
      else current = test;
    }
    if (current) lines.push(current);
    return lines;
  }

  async function toBlobURL(url, mimeType){
    const res = await fetch(url);
    if (!res.ok) throw new Error('No se pudo descargar ' + url);
    const buf = await res.arrayBuffer();
    return URL.createObjectURL(new Blob([buf], { type: mimeType }));
  }

  function extOf(name){
    const m = /\.([a-zA-Z0-9]+)$/.exec(name || '');
    return m ? m[1].toLowerCase() : 'mp4';
  }

  function withTimeout(promise, ms, message){
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))
    ]);
  }

  // ---- shared ffmpeg engine (used by video mode AND photo slideshow mode) ----
  let ffmpegInstance = null;
  let ffmpegLoadPromise = null;
  let activeProgressCb = null;

  async function getFFmpeg(){
    if (ffmpegInstance) return ffmpegInstance;
    if (!ffmpegLoadPromise){
      ffmpegLoadPromise = (async () => {
        const FF_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/ffmpeg/0.12.15/esm';
        const CORE_BASE = 'https://cdnjs.cloudflare.com/ajax/libs/ffmpeg-core/0.12.10/esm';
        const { FFmpeg } = await import(`${FF_BASE}/index.js`);
        const inst = new FFmpeg();
        inst.on('progress', ({ progress }) => {
          if (activeProgressCb) activeProgressCb(Math.max(0, Math.min(1, progress)));
        });
        const [classWorkerURL, coreURL, wasmURL] = await Promise.all([
          toBlobURL(`${FF_BASE}/worker.js`, 'text/javascript'),
          toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
          toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
        ]);
        await inst.load({ classWorkerURL, coreURL, wasmURL });
        ffmpegInstance = inst;
        return inst;
      })();
    }
    return ffmpegLoadPromise;
  }

  // ============================================================
  // mode switch
  // ============================================================
  const modeVideoBtn = document.getElementById('modeVideoBtn');
  const modePhotoBtn = document.getElementById('modePhotoBtn');
  const videoModeEl = document.getElementById('videoMode');
  const photoModeEl = document.getElementById('photoMode');
  modeVideoBtn.addEventListener('click', () => {
    modeVideoBtn.classList.add('active'); modePhotoBtn.classList.remove('active');
    videoModeEl.classList.remove('hidden'); photoModeEl.classList.add('hidden');
    clearError();
  });
  modePhotoBtn.addEventListener('click', () => {
    modePhotoBtn.classList.add('active'); modeVideoBtn.classList.remove('active');
    photoModeEl.classList.remove('hidden'); videoModeEl.classList.add('hidden');
    clearError();
  });

  // ============================================================
  // VIDEO MODE (split into timed parts + overlay caption)
  // ============================================================
  (function videoModeInit(){
    const state = { file:null, url:null, duration:0, segments:[] };
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('fileInput');
    const videoShell = document.getElementById('videoShell');
    const preview = document.getElementById('preview');
    const videoMeta = document.getElementById('videoMeta');
    const durationCard = document.getElementById('durationCard');
    const segSecondsInput = document.getElementById('segSeconds');
    const recalcBtn = document.getElementById('recalcBtn');
    const segSummary = document.getElementById('segSummary');
    const segmentsCard = document.getElementById('segmentsCard');
    const segmentList = document.getElementById('segmentList');
    const generateCard = document.getElementById('generateCard');
    const generateBtn = document.getElementById('generateBtn');
    const resetBtn = document.getElementById('resetBtn');
    const engineStatus = document.getElementById('engineStatus');

    dropzone.addEventListener('click', () => fileInput.click());
    ['dragover','dragenter'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.add('drag'); }));
    ['dragleave','drop'].forEach(evt => dropzone.addEventListener(evt, e => { e.preventDefault(); dropzone.classList.remove('drag'); }));
    dropzone.addEventListener('drop', e => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) handleFile(f); });
    fileInput.addEventListener('change', e => { const f = e.target.files[0]; if (f) handleFile(f); });

    function handleFile(file){
      if (!file.type.startsWith('video/')){ showError('Elegí un archivo de video.'); return; }
      clearError();
      if (state.url) URL.revokeObjectURL(state.url);
      state.file = file;
      state.url = URL.createObjectURL(file);
      preview.src = state.url;
      videoShell.classList.remove('hidden');
      preview.onloadedmetadata = () => {
        state.duration = preview.duration;
        videoMeta.textContent = `Duración total: ${formatTime(state.duration)} · ${preview.videoWidth}×${preview.videoHeight}`;
        document.getElementById('stepNum1').classList.add('done');
        durationCard.classList.remove('hidden');
        segSecondsInput.value = Math.min(30, Math.floor(state.duration)) || 30;
        computeSegments();
        resetBtn.classList.remove('hidden');
      };
    }

    recalcBtn.addEventListener('click', computeSegments);

    function computeSegments(){
      const seg = Math.max(1, parseInt(segSecondsInput.value, 10) || 30);
      const total = state.duration;
      const arr = []; let t = 0, idx = 1;
      while (t < total - 0.05){
        const end = Math.min(t + seg, total);
        arr.push({ index: idx, start: t, end: end, caption:'', status:'pendiente', blobUrl:null });
        t = end; idx++;
      }
      state.segments = arr;
      document.getElementById('stepNum2').classList.add('done');
      const last = arr[arr.length-1];
      segSummary.textContent = `${arr.length} parte${arr.length===1?'':'s'} · última parte: ${formatTime(last ? last.end - last.start : 0)}`;
      renderSegmentList();
      segmentsCard.classList.remove('hidden');
      generateCard.classList.remove('hidden');
    }

    function renderSegmentList(){
      segmentList.innerHTML = '';
      state.segments.forEach((seg, i) => {
        const card = document.createElement('div');
        card.className = 'part';
        card.innerHTML = `
          <div class="part-head">
            <span class="tc">Parte ${seg.index} · ${formatTime(seg.start)}–${formatTime(seg.end)}</span>
            <span class="status-tag" data-status="${i}">${seg.status}</span>
          </div>
          <textarea placeholder="Mensaje para esta parte (opcional)" data-caption="${i}"></textarea>
          <div class="progress-track" data-track="${i}"><div class="progress-fill" data-fill="${i}"></div></div>
          <div class="progress-label" data-label="${i}"></div>
          <div class="result hidden" data-result="${i}"></div>
        `;
        segmentList.appendChild(card);
      });
      segmentList.querySelectorAll('textarea[data-caption]').forEach(ta => {
        ta.addEventListener('input', e => {
          const i = parseInt(e.target.getAttribute('data-caption'), 10);
          state.segments[i].caption = e.target.value;
        });
      });
    }

    function setStatus(i, status){
      state.segments[i].status = status;
      const tag = segmentList.querySelector(`[data-status="${i}"]`);
      if (tag){ tag.textContent = status; tag.className = 'status-tag ' + (status==='procesando'?'processing':status==='listo'?'done':status==='error'?'error':''); }
    }
    function setProgress(i, pct){
      const track = segmentList.querySelector(`[data-track="${i}"]`);
      const fill = segmentList.querySelector(`[data-fill="${i}"]`);
      const label = segmentList.querySelector(`[data-label="${i}"]`);
      if (!track || !fill) return;
      track.classList.add('show'); fill.style.width = pct + '%';
      if (pct >= 100) fill.classList.add('done');
      if (label) label.textContent = pct + '%';
    }

    function drawCaption(ctx, canvas, text){
      const fontSize = Math.max(18, Math.min(46, Math.round(canvas.width * 0.045)));
      ctx.font = `700 ${fontSize}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const maxWidth = canvas.width * 0.86;
      const lines = getWrappedLines(ctx, text, maxWidth);
      const lineHeight = fontSize * 1.3, paddingV = fontSize * 0.8;
      const barHeight = lines.length * lineHeight + paddingV * 2;
      const marginBottom = canvas.height * 0.07;
      const barY = canvas.height - barHeight - marginBottom;
      const grad = ctx.createLinearGradient(0, barY, 0, barY + barHeight + marginBottom);
      grad.addColorStop(0, 'rgba(0,0,0,0)'); grad.addColorStop(0.3, 'rgba(0,0,0,0.6)'); grad.addColorStop(1, 'rgba(0,0,0,0.6)');
      ctx.fillStyle = grad; ctx.fillRect(0, barY, canvas.width, barHeight + marginBottom);
      ctx.fillStyle = '#ffffff'; ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 6;
      let ty = barY + paddingV + lineHeight/2;
      for (const line of lines){ ctx.fillText(line, canvas.width/2, ty); ty += lineHeight; }
      ctx.shadowBlur = 0;
    }

    function buildCaptionPNG(width, height, text){
      return new Promise((resolve) => {
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0,0,width,height);
        if (text && text.trim()) drawCaption(ctx, canvas, text);
        canvas.toBlob(blob => resolve(blob), 'image/png');
      });
    }

    async function processSegment(ffmpeg, seg, inputName, w, h){
      const outName = `out_${seg.index}.mp4`;
      let pngName = null;
      if (seg.caption && seg.caption.trim()){
        const pngBlob = await buildCaptionPNG(w, h, seg.caption);
        pngName = `cap_${seg.index}.png`;
        await ffmpeg.writeFile(pngName, new Uint8Array(await pngBlob.arrayBuffer()));
      }
      const duration = Math.max(0.05, seg.end - seg.start);
      let args;
      if (pngName){
        args = ['-ss', String(seg.start), '-t', String(duration.toFixed(3)), '-i', inputName, '-i', pngName,
          '-filter_complex', '[0:v][1:v]overlay=0:0:format=auto[v]', '-map', '[v]', '-map', '0:a?',
          '-c:v','libx264','-preset','ultrafast','-crf','26','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart', outName];
      } else {
        args = ['-ss', String(seg.start), '-t', String(duration.toFixed(3)), '-i', inputName,
          '-c:v','libx264','-preset','ultrafast','-crf','26','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-movflags','+faststart', outName];
      }
      activeProgressCb = (p) => setProgress(seg.index - 1, Math.round(p * 100));
      await ffmpeg.exec(args);
      activeProgressCb = null;
      const data = await ffmpeg.readFile(outName);
      const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      try { await ffmpeg.deleteFile(outName); } catch(e){}
      if (pngName){ try { await ffmpeg.deleteFile(pngName); } catch(e){} }
      return url;
    }

    generateBtn.addEventListener('click', async () => {
      clearError();
      generateBtn.disabled = true;
      const originalLabel = generateBtn.textContent;
      try{
        if (!ffmpegInstance){ engineStatus.classList.add('show'); generateBtn.textContent = 'Cargando motor…'; }
        const ffmpeg = await withTimeout(getFFmpeg(), 45000, 'El motor de video tardó demasiado en cargar (puede ser la conexión o un bloqueo del navegador).');
        engineStatus.classList.remove('show');
        generateBtn.textContent = 'Generando…';
        const w = preview.videoWidth, h = preview.videoHeight;
        const inputName = 'input.' + extOf(state.file.name);
        await ffmpeg.writeFile(inputName, new Uint8Array(await state.file.arrayBuffer()));
        for (const seg of state.segments){
          const i = seg.index - 1;
          setStatus(i, 'procesando'); setProgress(i, 0);
          try{
            const url = await withTimeout(processSegment(ffmpeg, seg, inputName, w, h), 90000, 'Esta parte tardó demasiado en procesarse.');
            if (seg.blobUrl) URL.revokeObjectURL(seg.blobUrl);
            seg.blobUrl = url;
            setStatus(i, 'listo'); setProgress(i, 100);
            const resultEl = segmentList.querySelector(`[data-result="${i}"]`);
            resultEl.classList.remove('hidden');
            resultEl.innerHTML = `<video class="result-video" src="${url}" controls playsinline></video><a href="${url}" download="parte-${seg.index}.mp4">Descargar parte ${seg.index}</a>`;
          } catch(err){ console.error(err); setStatus(i, 'error'); }
        }
        document.getElementById('stepNum3').classList.add('done');
        document.getElementById('stepNum4').classList.add('done');
        generateBtn.textContent = 'Listo — generar de nuevo';
      } catch(err){
        console.error(err); engineStatus.classList.remove('show');
        showError(err && err.message ? err.message : 'No se pudo cargar el motor de video. Revisá tu conexión e intentá de nuevo.');
        generateBtn.textContent = originalLabel;
      } finally { generateBtn.disabled = false; }
    });

    resetBtn.addEventListener('click', () => {
      state.segments.forEach(s => { if (s.blobUrl) URL.revokeObjectURL(s.blobUrl); });
      if (state.url) URL.revokeObjectURL(state.url);
      location.reload();
    });
  })();

  // ============================================================
  // PHOTO MODE (individual images OR slideshow video, with styles + transitions)
  // ============================================================
  (function photoModeInit(){
    const PALETTE = [
      {hex:'#5b5bd6'}, {hex:'#111318'}, {hex:'#f5f1e8'}, {hex:'#1f9d55'}, {hex:'#d1453b'}
    ];

    const pstate = { photos: [], outputMode:'individual', groupSize:1, photoDuration:2.5, transition:'corte', style:'classic', color:'#5b5bd6', parts: [] };

    const photoDropzone = document.getElementById('photoDropzone');
    const photoInput = document.getElementById('photoInput');
    const photoThumbs = document.getElementById('photoThumbs');
    const photoOutputCard = document.getElementById('photoOutputCard');
    const modeIndividualBtn = document.getElementById('modeIndividualBtn');
    const modeSlideshowBtn = document.getElementById('modeSlideshowBtn');
    const outputModeHint = document.getElementById('outputModeHint');
    const slideshowOptions = document.getElementById('slideshowOptions');
    const groupSizeInput = document.getElementById('groupSize');
    const photoDurationInput = document.getElementById('photoDuration');
    const transitionSelect = document.getElementById('transitionSelect');
    const recalcPhotoBtn = document.getElementById('recalcPhotoBtn');
    const photoGroupSummary = document.getElementById('photoGroupSummary');
    const photoStyleCard = document.getElementById('photoStyleCard');
    const styleSelect = document.getElementById('styleSelect');
    const colorSwatches = document.getElementById('colorSwatches');
    const photoPartsCard = document.getElementById('photoPartsCard');
    const photoPartList = document.getElementById('photoPartList');
    const photoGenerateCard = document.getElementById('photoGenerateCard');
    const photoGenerateBtn = document.getElementById('photoGenerateBtn');
    const photoResetBtn = document.getElementById('photoResetBtn');
    const photoEngineStatus = document.getElementById('photoEngineStatus');

    // color swatches
    PALETTE.forEach((c, i) => {
      const sw = document.createElement('div');
      sw.className = 'swatch' + (c.hex === pstate.color ? ' selected' : '');
      sw.style.background = c.hex;
      sw.addEventListener('click', () => {
        pstate.color = c.hex;
        colorSwatches.querySelectorAll('.swatch').forEach(s => s.classList.remove('selected'));
        sw.classList.add('selected');
      });
      colorSwatches.appendChild(sw);
    });

    photoDropzone.addEventListener('click', () => photoInput.click());
    ['dragover','dragenter'].forEach(evt => photoDropzone.addEventListener(evt, e => { e.preventDefault(); photoDropzone.classList.add('drag'); }));
    ['dragleave','drop'].forEach(evt => photoDropzone.addEventListener(evt, e => { e.preventDefault(); photoDropzone.classList.remove('drag'); }));
    photoDropzone.addEventListener('drop', e => { handlePhotoFiles(e.dataTransfer.files); });
    photoInput.addEventListener('change', e => { handlePhotoFiles(e.target.files); });

    function handlePhotoFiles(fileList){
      const files = Array.from(fileList || []).filter(f => f.type.startsWith('image/'));
      if (!files.length) return;
      clearError();
      files.forEach(file => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          pstate.photos.push({ file, url, width: img.naturalWidth, height: img.naturalHeight });
          renderThumbs();
          photoOutputCard.classList.remove('hidden');
          photoResetBtn.classList.remove('hidden');
          document.getElementById('pStepNum1').classList.add('done');
          computePhotoParts();
        };
        img.onerror = () => { showError('No se pudo cargar una de las fotos.'); };
        img.src = url;
      });
    }

    function renderThumbs(){
      photoThumbs.innerHTML = '';
      pstate.photos.forEach((p, i) => {
        const div = document.createElement('div');
        div.className = 'thumb';
        div.innerHTML = `<img src="${p.url}"><span class="badge">${i+1}</span><button class="rm" data-rm="${i}">×</button>`;
        photoThumbs.appendChild(div);
      });
      photoThumbs.querySelectorAll('[data-rm]').forEach(btn => {
        btn.addEventListener('click', () => {
          const i = parseInt(btn.getAttribute('data-rm'), 10);
          URL.revokeObjectURL(pstate.photos[i].url);
          pstate.photos.splice(i, 1);
          renderThumbs();
          computePhotoParts();
        });
      });
    }

    modeIndividualBtn.addEventListener('click', () => {
      pstate.outputMode = 'individual';
      modeIndividualBtn.classList.add('active'); modeSlideshowBtn.classList.remove('active');
      slideshowOptions.classList.add('hidden');
      outputModeHint.textContent = 'Cada foto lleva su mensaje y se descarga como imagen suelta. No necesita descargar ningún motor, es instantáneo.';
      computePhotoParts();
    });
    modeSlideshowBtn.addEventListener('click', () => {
      pstate.outputMode = 'slideshow';
      modeSlideshowBtn.classList.add('active'); modeIndividualBtn.classList.remove('active');
      slideshowOptions.classList.remove('hidden');
      outputModeHint.textContent = 'Se arma un video por cada parte, con las fotos en cadena y el mensaje superpuesto.';
      computePhotoParts();
    });
    recalcPhotoBtn.addEventListener('click', computePhotoParts);

    function computePhotoParts(){
      if (!pstate.photos.length) return;
      document.getElementById('pStepNum2').classList.add('done');
      const arr = [];
      if (pstate.outputMode === 'individual'){
        pstate.photos.forEach((p, i) => arr.push({ index:i+1, photos:[p], caption:'', status:'pendiente', kind:'image', resultUrl:null }));
        photoGroupSummary.textContent = '';
      } else {
        const size = Math.max(1, parseInt(groupSizeInput.value, 10) || 1);
        pstate.groupSize = size;
        pstate.photoDuration = Math.max(0.5, parseFloat(photoDurationInput.value) || 2.5);
        pstate.transition = transitionSelect.value;
        let idx = 1;
        for (let i = 0; i < pstate.photos.length; i += size){
          arr.push({ index: idx++, photos: pstate.photos.slice(i, i+size), caption:'', status:'pendiente', kind:'video', resultUrl:null });
        }
        photoGroupSummary.textContent = `${arr.length} parte${arr.length===1?'':'s'} de hasta ${size} foto${size===1?'':'s'} cada una`;
      }
      pstate.parts = arr;
      renderPartList();
      photoStyleCard.classList.remove('hidden');
      photoPartsCard.classList.remove('hidden');
      photoGenerateCard.classList.remove('hidden');
    }

    function renderPartList(){
      photoPartList.innerHTML = '';
      pstate.parts.forEach((part, i) => {
        const label = part.kind === 'image' ? `Foto ${part.index}` : `Parte ${part.index} · ${part.photos.length} foto${part.photos.length===1?'':'s'}`;
        const card = document.createElement('div');
        card.className = 'part';
        card.innerHTML = `
          <div class="part-head">
            <div class="part-head-left"><img class="part-thumb" src="${part.photos[0].url}"><span class="tc">${label}</span></div>
            <span class="status-tag" data-pstatus="${i}">${part.status}</span>
          </div>
          <textarea placeholder="Mensaje para esta parte (opcional)" data-pcaption="${i}"></textarea>
          <div class="progress-track" data-ptrack="${i}"><div class="progress-fill" data-pfill="${i}"></div></div>
          <div class="progress-label" data-plabel="${i}"></div>
          <div class="result hidden" data-presult="${i}"></div>
        `;
        photoPartList.appendChild(card);
      });
      photoPartList.querySelectorAll('textarea[data-pcaption]').forEach(ta => {
        ta.addEventListener('input', e => {
          const i = parseInt(e.target.getAttribute('data-pcaption'), 10);
          pstate.parts[i].caption = e.target.value;
        });
      });
    }

    function setPStatus(i, status){
      pstate.parts[i].status = status;
      const tag = photoPartList.querySelector(`[data-pstatus="${i}"]`);
      if (tag){ tag.textContent = status; tag.className = 'status-tag ' + (status==='procesando'?'processing':status==='listo'?'done':status==='error'?'error':''); }
    }
    function setPProgress(i, pct){
      const track = photoPartList.querySelector(`[data-ptrack="${i}"]`);
      const fill = photoPartList.querySelector(`[data-pfill="${i}"]`);
      const label = photoPartList.querySelector(`[data-plabel="${i}"]`);
      if (!track || !fill) return;
      track.classList.add('show'); fill.style.width = pct + '%';
      if (pct >= 100) fill.classList.add('done');
      if (label) label.textContent = pct + '%';
    }

    // ---- styled caption drawing (3 shapes x 5 colors) ----
    function idealTextColor(hex){
      const c = hex.replace('#','');
      const r = parseInt(c.substring(0,2),16), g = parseInt(c.substring(2,4),16), b = parseInt(c.substring(4,6),16);
      const lum = (0.299*r + 0.587*g + 0.114*b) / 255;
      return lum > 0.6 ? '#111318' : '#ffffff';
    }
    function hexToRgba(hex, alpha){
      const c = hex.replace('#','');
      const r = parseInt(c.substring(0,2),16), g = parseInt(c.substring(2,4),16), b = parseInt(c.substring(4,6),16);
      return `rgba(${r},${g},${b},${alpha})`;
    }
    function roundRect(ctx, x, y, w, h, r){
      ctx.beginPath();
      ctx.moveTo(x+r, y);
      ctx.arcTo(x+w, y, x+w, y+h, r);
      ctx.arcTo(x+w, y+h, x, y+h, r);
      ctx.arcTo(x, y+h, x, y, r);
      ctx.arcTo(x, y, x+w, y, r);
      ctx.closePath();
    }

    function drawStyledCaption(ctx, canvas, text){
      if (!text || !text.trim()) return;
      const style = pstate.style, colorHex = pstate.color;
      const textColor = idealTextColor(colorHex);
      const fontSize = Math.max(18, Math.min(52, Math.round(canvas.width * 0.05)));
      ctx.font = `700 ${fontSize}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      const maxWidth = canvas.width * 0.82;
      const lines = getWrappedLines(ctx, text, maxWidth);
      const lineHeight = fontSize * 1.3;

      if (style === 'ribbon'){
        const paddingV = fontSize * 0.7;
        const barHeight = lines.length * lineHeight + paddingV * 2;
        const barY = canvas.height * 0.06;
        ctx.fillStyle = colorHex;
        ctx.fillRect(0, barY, canvas.width, barHeight);
        ctx.fillStyle = textColor;
        let ty = barY + paddingV + lineHeight/2;
        for (const line of lines){ ctx.fillText(line, canvas.width/2, ty); ty += lineHeight; }
      } else if (style === 'chip'){
        const paddingV = fontSize * 0.55, paddingH = fontSize * 0.9;
        let maxLineW = 0;
        lines.forEach(l => { maxLineW = Math.max(maxLineW, ctx.measureText(l).width); });
        const chipW = Math.min(canvas.width * 0.86, maxLineW + paddingH * 2);
        const chipH = lines.length * lineHeight + paddingV * 2;
        const chipX = (canvas.width - chipW) / 2;
        const chipY = canvas.height * 0.72 - chipH / 2;
        const r = Math.min(chipH/2, 26);
        roundRect(ctx, chipX, chipY, chipW, chipH, r);
        ctx.fillStyle = hexToRgba(colorHex, 0.94);
        ctx.fill();
        ctx.fillStyle = textColor;
        let ty = chipY + paddingV + lineHeight/2;
        for (const line of lines){ ctx.fillText(line, canvas.width/2, ty); ty += lineHeight; }
      } else {
        const paddingV = fontSize * 0.8;
        const barHeight = lines.length * lineHeight + paddingV * 2;
        const marginBottom = canvas.height * 0.06;
        const barY = canvas.height - barHeight - marginBottom;
        ctx.fillStyle = hexToRgba(colorHex, 0.78);
        ctx.fillRect(0, barY, canvas.width, barHeight + marginBottom);
        ctx.fillStyle = textColor;
        let ty = barY + paddingV + lineHeight/2;
        for (const line of lines){ ctx.fillText(line, canvas.width/2, ty); ty += lineHeight; }
      }
    }

    function capDim(w, h, maxSide){
      if (w <= maxSide && h <= maxSide) return { w, h };
      const scale = maxSide / Math.max(w, h);
      return { w: Math.round(w*scale/2)*2, h: Math.round(h*scale/2)*2 };
    }

    // ---- individual image export (canvas only, no ffmpeg) ----
    async function processImagePart(part){
      return new Promise((resolve, reject) => {
        const photo = part.photos[0];
        const img = new Image();
        img.onload = () => {
          const dims = capDim(img.naturalWidth, img.naturalHeight, 1600);
          const canvas = document.createElement('canvas');
          canvas.width = dims.w; canvas.height = dims.h;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, dims.w, dims.h);
          drawStyledCaption(ctx, canvas, part.caption);
          canvas.toBlob(blob => {
            if (!blob) return reject(new Error('No se pudo generar la imagen'));
            resolve(URL.createObjectURL(blob));
          }, 'image/jpeg', 0.92);
        };
        img.onerror = reject;
        img.src = photo.url;
      });
    }

    // ---- slideshow video export (ffmpeg) ----
    async function processSlideshowPart(ffmpeg, part){
      const first = part.photos[0];
      const dims = capDim(first.width, first.height, 1280);
      const W = dims.w, H = dims.h;
      const k = part.photos.length;
      const Dp = pstate.photoDuration;
      const fps = 25;
      const FD = Math.min(0.5, Dp * 0.3);

      const inputNames = [];
      for (let i = 0; i < k; i++){
        const name = `p${part.index}_${i}.` + extOf(part.photos[i].file.name || 'jpg');
        await ffmpeg.writeFile(name, new Uint8Array(await part.photos[i].file.arrayBuffer()));
        inputNames.push(name);
      }

      let pngName = null;
      if (part.caption && part.caption.trim()){
        const canvas = document.createElement('canvas');
        canvas.width = W; canvas.height = H;
        const ctx = canvas.getContext('2d');
        ctx.clearRect(0,0,W,H);
        drawStyledCaption(ctx, canvas, part.caption);
        const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
        pngName = `cap_${part.index}.png`;
        await ffmpeg.writeFile(pngName, new Uint8Array(await blob.arrayBuffer()));
      }

      const args = [];
      for (const name of inputNames){ args.push('-loop','1','-t', String(Dp), '-i', name); }
      if (pngName) args.push('-i', pngName);

      const chains = [];
      const labels = [];
      for (let i = 0; i < k; i++){
        let chain;
        if (pstate.transition === 'zoom'){
          const frames = Math.max(2, Math.round(Dp * fps));
          // zoompan emits `d` frames for EVERY input frame it receives; since the
          // -loop 1 -t Dp input keeps delivering frames for the whole duration,
          // without trimming here it multiplies into thousands of extra frames
          // (minutes of video) and hangs/times out. Cut hard at the first cycle.
          chain = `[${i}:v]scale=${W*2}:${H*2}:force_original_aspect_ratio=increase,crop=${W*2}:${H*2},zoompan=z='min(zoom+0.0015,1.3)':d=${frames}:s=${W}x${H}:fps=${fps},trim=end_frame=${frames},setpts=PTS-STARTPTS,setsar=1`;
        } else {
          chain = `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},setsar=1`;
          if (pstate.transition === 'fundido'){
            if (i > 0) chain += `,fade=t=in:st=0:d=${FD}`;
            if (i < k-1) chain += `,fade=t=out:st=${(Dp-FD).toFixed(3)}:d=${FD}`;
          }
        }
        chain += `[v${i}]`;
        chains.push(chain);
        labels.push(`[v${i}]`);
      }
      chains.push(`${labels.join('')}concat=n=${k}:v=1:a=0[vcat]`);
      let filterComplex = chains.join(';');
      let mapLabel = '[vcat]';
      if (pngName){
        filterComplex += `;[vcat][${k}:v]overlay=0:0:format=auto[vout]`;
        mapLabel = '[vout]';
      }

      const outName = `slideshow_${part.index}.mp4`;
      args.push('-filter_complex', filterComplex, '-map', mapLabel,
        '-c:v','libx264','-preset','ultrafast','-crf','26','-pix_fmt','yuv420p','-r', String(fps),
        '-movflags','+faststart', outName);

      activeProgressCb = (p) => setPProgress(part.index - 1, Math.round(p * 100));
      await ffmpeg.exec(args);
      activeProgressCb = null;

      const data = await ffmpeg.readFile(outName);
      const url = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' }));
      try { await ffmpeg.deleteFile(outName); } catch(e){}
      for (const name of inputNames){ try { await ffmpeg.deleteFile(name); } catch(e){} }
      if (pngName){ try { await ffmpeg.deleteFile(pngName); } catch(e){} }
      return url;
    }

    photoGenerateBtn.addEventListener('click', async () => {
      clearError();
      photoGenerateBtn.disabled = true;
      const originalLabel = photoGenerateBtn.textContent;
      const needsEngine = pstate.parts.some(p => p.kind === 'video');
      try{
        let ffmpeg = null;
        if (needsEngine){
          if (!ffmpegInstance){ photoEngineStatus.classList.add('show'); photoGenerateBtn.textContent = 'Cargando motor…'; }
          ffmpeg = await withTimeout(getFFmpeg(), 45000, 'El motor de video tardó demasiado en cargar (puede ser la conexión o un bloqueo del navegador).');
          photoEngineStatus.classList.remove('show');
        }
        photoGenerateBtn.textContent = 'Generando…';

        for (const part of pstate.parts){
          const i = part.index - 1;
          setPStatus(i, 'procesando'); setPProgress(i, 0);
          try{
            const url = part.kind === 'image'
              ? await withTimeout(processImagePart(part), 20000, 'Esta foto tardó demasiado en procesarse.')
              : await withTimeout(processSlideshowPart(ffmpeg, part), 120000, 'Esta parte tardó demasiado en procesarse (probá con "Corte seco" o menos fotos por parte).');
            if (part.resultUrl) URL.revokeObjectURL(part.resultUrl);
            part.resultUrl = url;
            setPStatus(i, 'listo'); setPProgress(i, 100);
            const resultEl = photoPartList.querySelector(`[data-presult="${i}"]`);
            resultEl.classList.remove('hidden');
            if (part.kind === 'image'){
              resultEl.innerHTML = `<img class="result-img" src="${url}"><a href="${url}" download="foto-${part.index}.jpg">Descargar foto ${part.index}</a>`;
            } else {
              resultEl.innerHTML = `<video class="result-video" src="${url}" controls playsinline></video><a href="${url}" download="parte-${part.index}.mp4">Descargar parte ${part.index}</a>`;
            }
          } catch(err){ console.error(err); setPStatus(i, 'error'); }
        }
        document.getElementById('pStepNum4').classList.add('done');
        document.getElementById('pStepNum5').classList.add('done');
        photoGenerateBtn.textContent = 'Listo — generar de nuevo';
      } catch(err){
        console.error(err); photoEngineStatus.classList.remove('show');
        showError(err && err.message ? err.message : 'No se pudo cargar el motor de video. Revisá tu conexión e intentá de nuevo.');
        photoGenerateBtn.textContent = originalLabel;
      } finally { photoGenerateBtn.disabled = false; }
    });

    photoResetBtn.addEventListener('click', () => {
      pstate.photos.forEach(p => URL.revokeObjectURL(p.url));
      pstate.parts.forEach(p => { if (p.resultUrl) URL.revokeObjectURL(p.resultUrl); });
      location.reload();
    });
  })();
