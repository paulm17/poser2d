import { resizeCrop } from './crop.js';
export function initExportSystem(stage, THREE, onSend, beforeCapture = () => {}) {
  const exportPanel   = document.getElementById('export-panel');
  const exportMask    = document.getElementById('export-mask');
  const exportFrame   = document.getElementById('export-frame');
  const frameToolbar  = document.getElementById('export-frame-toolbar');
  const resizeHandles = document.querySelectorAll('.export-resize-handle');
  const annotLayer    = document.getElementById('annotation-layer');
  const annotList     = document.getElementById('annotation-list');
  const presetSelect  = document.getElementById('export-preset');
  const bgSelect      = document.getElementById('export-bg');
  const colorPicker   = document.getElementById('annotation-color');
  const btnAddText    = document.getElementById('btn-add-text');
  const btnAddArrow   = document.getElementById('btn-add-arrow');
  const btnDoExport   = document.getElementById('btn-do-export');
  const uiOverlay     = document.getElementById('ui-overlay');
  const editorHUDs = ['camera-hud', 'mannequin-pos-hud'].map(id => document.getElementById(id));
  const propertiesPanel = document.getElementById('properties-panel');
  let exportActive = false;
  let propertiesPanelWasHidden = false;
  const ratioPresets = {
    '16:9': [16, 9],
    '9:16': [9, 16],
    '1:1': [1, 1],
  };
  const frameRect = { x: 0, y: 0, width: 0, height: 0 };
  let frameDrag = null;
  let frameResize = null;
  let cameraFrame = null;

  // Track all annotation objects
  const annotations = []; // { id, type, el, data }
  let selectedAnnotId = null;
  let annoCounter = 0;

  // ── Frame sizing ────────────────────────────────────────────────────────────
  function getAspectRatio() {
    const [ratioW, ratioH] = ratioPresets[presetSelect.value] || ratioPresets['16:9'];
    return ratioW / ratioH;
  }

  function getCanvasRect() {
    return stage.renderer.domElement.getBoundingClientRect();
  }

  function clampFrame() {
    const canvasRect = getCanvasRect();
    frameRect.width = Math.min(Math.max(frameRect.width, 8), canvasRect.width);
    frameRect.height = Math.min(Math.max(frameRect.height, 8), canvasRect.height);

    const maxX = canvasRect.right - frameRect.width;
    const maxY = canvasRect.bottom - frameRect.height;

    frameRect.x = Math.min(Math.max(frameRect.x, canvasRect.left), maxX);
    frameRect.y = Math.min(Math.max(frameRect.y, canvasRect.top), maxY);
  }

  function applyFrameRect() {
    exportFrame.style.left = `${Math.round(frameRect.x)}px`;
    exportFrame.style.top = `${Math.round(frameRect.y)}px`;
    exportFrame.style.width = `${Math.round(frameRect.width)}px`;
    exportFrame.style.height = `${Math.round(frameRect.height)}px`;
    exportFrame.style.transform = '';
  }

  function updateFrameSize(resetPosition = false) {
    if (!exportActive) return;
    const canvasRect = getCanvasRect();
    const aspect = getAspectRatio();
    const availableWidth = Math.max(320, Math.min(canvasRect.width - 48, window.innerWidth - 380));
    const availableHeight = Math.max(240, canvasRect.height - 120);
    const widthFromHeight = availableHeight * aspect;
    const heightFromWidth = availableWidth / aspect;
    const width = Math.round(Math.min(availableWidth, widthFromHeight));
    const height = Math.round(Math.min(availableHeight, heightFromWidth));
    const previousCenterX = frameRect.x + frameRect.width / 2;
    const previousCenterY = frameRect.y + frameRect.height / 2;

    frameRect.width = width;
    frameRect.height = height;

    if (resetPosition || (!frameRect.x && !frameRect.y)) {
      frameRect.x = canvasRect.left + Math.max(24, (Math.min(canvasRect.width, availableWidth) - width) / 2);
      frameRect.y = canvasRect.top + Math.max(24, (canvasRect.height - height) / 2);
    } else {
      frameRect.x = previousCenterX - width / 2;
      frameRect.y = previousCenterY - height / 2;
    }

    clampFrame();
    applyFrameRect();
    // Fit once to the preset frame; subsequent corner drags crop this view.
    cameraFrame = { x: (frameRect.x - canvasRect.left) / canvasRect.width,
      y: (frameRect.y - canvasRect.top) / canvasRect.height,
      width: frameRect.width / canvasRect.width, height: frameRect.height / canvasRect.height };
  }

  document.getElementById('btn-export').addEventListener('click', () => {
    exportActive = true;
    exportPanel.classList.remove('hidden');
    exportMask.classList.remove('hidden');
    propertiesPanelWasHidden = propertiesPanel.classList.contains('hidden');
    uiOverlay.classList.add('hidden');
    editorHUDs.forEach(panel => panel.classList.add('export-hidden'));
    propertiesPanel.classList.add('hidden');
    updateFrameSize(true);
    if (stage.controls) stage.controls.enabled = false;
  });

  const closeExport = () => {
    if (!exportActive) return;
    exportActive = false;
    exportPanel.classList.add('hidden');
    exportMask.classList.add('hidden');
    uiOverlay.classList.remove('hidden');
    editorHUDs.forEach(panel => panel.classList.remove('export-hidden'));
    if (!propertiesPanelWasHidden) propertiesPanel.classList.remove('hidden');
    frameDrag = null;
    frameResize = null;
    if (stage.controls) stage.controls.enabled = true;
  };

  document.getElementById('btn-close-export').addEventListener('click', closeExport);
  window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && exportActive) closeExport();
  });
  presetSelect.addEventListener('change', () => updateFrameSize(false));
  let previousCanvas = getCanvasRect();
  window.addEventListener('resize', () => {
    const next = getCanvasRect();
    if (exportActive && previousCanvas.width && previousCanvas.height) {
      frameRect.x = next.left + (frameRect.x - previousCanvas.left) * next.width / previousCanvas.width;
      frameRect.y = next.top + (frameRect.y - previousCanvas.top) * next.height / previousCanvas.height;
      frameRect.width *= next.width / previousCanvas.width;
      frameRect.height *= next.height / previousCanvas.height;
      clampFrame(); applyFrameRect();
    }
    previousCanvas = next;
  });

  frameToolbar.addEventListener('pointerdown', e => {
    if (!exportActive) return;
    frameDrag = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      frameX: frameRect.x,
      frameY: frameRect.y,
    };
    frameToolbar.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  });

  resizeHandles.forEach(handle => handle.addEventListener('pointerdown', e => {
    if (!exportActive) return;
    frameResize = {
      corner: handle.dataset.corner,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      width: frameRect.width,
      height: frameRect.height,
      x: frameRect.x,
      y: frameRect.y,
    };
    handle.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }));

  window.addEventListener('pointermove', e => {
    if (frameDrag && e.pointerId === frameDrag.pointerId) {
      frameRect.x = frameDrag.frameX + (e.clientX - frameDrag.startX);
      frameRect.y = frameDrag.frameY + (e.clientY - frameDrag.startY);
      clampFrame();
      applyFrameRect();
    }

    if (frameResize && e.pointerId === frameResize.pointerId) {
      Object.assign(frameRect, resizeCrop(frameResize, frameResize.corner,
        e.clientX - frameResize.startX, e.clientY - frameResize.startY, getCanvasRect()));
      applyFrameRect();
    }
  });

  const finishPointer = e => {
    if (frameDrag && e.pointerId === frameDrag.pointerId) frameDrag = null;
    if (frameResize && e.pointerId === frameResize.pointerId) frameResize = null;
  };
  window.addEventListener('pointerup', finishPointer);
  window.addEventListener('pointercancel', finishPointer);

  // ── Annotation helpers ──────────────────────────────────────────────────────
  function getFrameScale() {
    return 1;
  }

  function applyTransform(el, data) {
    el.style.left = data.x + 'px';
    el.style.top  = data.y + 'px';
    el.style.transform = `rotate(${data.rot}deg) scale(${data.sx}, ${data.sy})`;
    el.style.transformOrigin = 'top left';
  }

  function makeDraggable(el, data) {
    let down = false, sx, sy;
    const abort = new AbortController();
    el.disposeDrag = () => abort.abort();
    el.addEventListener('pointerdown', e => {
      if (e.target.classList.contains('anno-resize-handle')) return;
      down = true; sx = e.clientX; sy = e.clientY;
      e.stopPropagation();
      selectAnnotation(data.id);
    });
    document.addEventListener('pointermove', e => {
      if (!down) return;
      const scale = getFrameScale();
      data.x += (e.clientX - sx) / scale;
      data.y += (e.clientY - sy) / scale;
      sx = e.clientX; sy = e.clientY;
      applyTransform(el, data);
      refreshTransformControls(data.id);
    }, { signal: abort.signal });
    document.addEventListener('pointerup', () => { down = false; }, { signal: abort.signal });
  }

  // ── Add Text ─────────────────────────────────────────────────────────────────
  function addText(saved) {
    const color = saved?.color ?? colorPicker.value;
    const id = ++annoCounter;
    const data = saved ? { ...saved, id } : { id, type: 'text', x: 120, y: 120, rot: 0, sx: 1, sy: 1, color, content: 'Label' };
    const el = document.createElement('div');
    el.className = 'annotation text-annotation';
    el.contentEditable = true;
    el.innerText = data.content;
    el.style.cssText = `position:absolute;left:${data.x}px;top:${data.y}px;color:${color};background:rgba(0,0,0,0.55);padding:4px 10px;border-radius:4px;font-size:16px;font-weight:600;cursor:move;user-select:none;white-space:nowrap;`;
    el.addEventListener('input', () => { data.content = el.innerText; refreshList(); });
    annotLayer.appendChild(el);
    applyTransform(el, data);
    makeDraggable(el, data);
    annotations.push({ id, type: 'text', el, data });
    refreshList();
    selectAnnotation(id);
  }

  // ── Add Arrow ─────────────────────────────────────────────────────────────────
  function addArrow(saved) {
    const color = saved?.color ?? colorPicker.value;
    const id = ++annoCounter;
    const data = saved ? { ...saved, id } : { id, type: 'arrow', x: 200, y: 200, rot: 0, sx: 1, sy: 1, color, length: 80 };
    const el = document.createElement('div');
    el.className = 'annotation arrow-annotation';
    el.style.cssText = `position:absolute;left:${data.x}px;top:${data.y}px;width:${data.length}px;height:24px;cursor:move;display:flex;align-items:center;`;
    el.innerHTML = `<svg width="100%" height="24" viewBox="0 0 ${data.length} 24" xmlns="http://www.w3.org/2000/svg">
      <defs><marker id="ah${id}" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L8,3 z" fill="${color}"/></marker></defs>
      <line x1="4" y1="12" x2="${data.length - 10}" y2="12" stroke="${color}" stroke-width="3" marker-end="url(#ah${id})"/>
    </svg>`;
    annotLayer.appendChild(el);
    applyTransform(el, data);
    makeDraggable(el, data);
    annotations.push({ id, type: 'arrow', el, data });
    refreshList();
    selectAnnotation(id);
  }

  // ── Color sync ───────────────────────────────────────────────────────────────
  colorPicker.addEventListener('input', () => {
    const ann = annotations.find(a => a.id === selectedAnnotId);
    if (!ann) return;
    ann.data.color = colorPicker.value;
    if (ann.type === 'text') ann.el.style.color = colorPicker.value;
    if (ann.type === 'arrow') {
      const svg = ann.el.querySelector('svg');
      svg.querySelector('line').setAttribute('stroke', colorPicker.value);
      svg.querySelector('path').setAttribute('fill', colorPicker.value);
    }
  });

  // ── Selection & transform controls ───────────────────────────────────────────
  let transformEl = null;
  function selectAnnotation(id) {
    // Remove old highlight
    annotations.forEach(a => a.el.style.outline = 'none');
    selectedAnnotId = id;
    const ann = annotations.find(a => a.id === id);
    if (!ann) { hideTransformControls(); return; }
    ann.el.style.outline = `2px solid ${ann.data.color}`;
    colorPicker.value = ann.data.color;
    showTransformControls(ann);
  }

  function hideTransformControls() {
    if (transformEl) { transformEl.remove(); transformEl = null; }
  }

  function showTransformControls(ann) {
    hideTransformControls();
    transformEl = document.createElement('div');
    transformEl.id = 'anno-transform-panel';
    transformEl.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(20,20,20,0.92);border:1px solid rgba(255,255,255,0.15);border-radius:8px;padding:12px 16px;display:flex;gap:16px;align-items:center;z-index:9999;font-size:11px;color:white;font-family:monospace;';
    transformEl.innerHTML = buildTransformHTML(ann.data);
    document.body.appendChild(transformEl);
    bindTransformControls(ann);
  }

  function buildTransformHTML(data) {
    return `
      <div style="display:flex;flex-direction:column;gap:4px;">
        <div style="color:#888;font-size:10px;margin-bottom:2px;">POSITION</div>
        <div style="display:flex;gap:8px;">
          <label>X <input data-key="x" type="number" step="1" value="${Math.round(data.x)}" style="${numStyle()}"></label>
          <label>Y <input data-key="y" type="number" step="1" value="${Math.round(data.y)}" style="${numStyle()}"></label>
        </div>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <div style="color:#888;font-size:10px;margin-bottom:2px;">ROTATE</div>
        <label><input data-key="rot" type="number" step="1" value="${Math.round(data.rot)}" style="${numStyle()}">°</label>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px;">
        <div style="color:#888;font-size:10px;margin-bottom:2px;">SCALE</div>
        <div style="display:flex;gap:8px;">
          <label>X <input data-key="sx" type="number" step="0.05" value="${data.sx.toFixed(2)}" style="${numStyle()}"></label>
          <label>Y <input data-key="sy" type="number" step="0.05" value="${data.sy.toFixed(2)}" style="${numStyle()}"></label>
        </div>
      </div>
      <button id="close-transform-panel" style="background:rgba(255,255,255,0.1);border:none;color:white;padding:4px 8px;border-radius:4px;cursor:pointer;font-size:14px;">×</button>`;
  }

  function numStyle() {
    return 'width:52px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);color:white;border-radius:3px;padding:2px 4px;font-family:monospace;font-size:11px;';
  }

  function bindTransformControls(ann) {
    transformEl.querySelectorAll('input[data-key]').forEach(inp => {
      inp.addEventListener('input', () => {
        const key = inp.dataset.key;
        ann.data[key] = parseFloat(inp.value) || 0;
        applyTransform(ann.el, ann.data);
      });
    });
    transformEl.querySelector('#close-transform-panel').addEventListener('click', () => {
      selectedAnnotId = null; hideTransformControls();
      annotations.forEach(a => a.el.style.outline = 'none');
    });
  }

  function refreshTransformControls(id) {
    if (selectedAnnotId !== id || !transformEl) return;
    const ann = annotations.find(a => a.id === id);
    if (!ann) return;
    transformEl.innerHTML = buildTransformHTML(ann.data);
    bindTransformControls(ann);
  }

  // ── Annotation list ───────────────────────────────────────────────────────────
  function refreshList() {
    annotList.innerHTML = '';
    annotations.forEach(ann => {
      const row = document.createElement('div');
      row.style.cssText = `display:flex;align-items:center;gap:6px;padding:5px 8px;border-radius:4px;border:1px solid rgba(255,255,255,0.1);cursor:pointer;background:${selectedAnnotId === ann.id ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.3)'};font-size:11px;`;
      const dot = `<span style="width:8px;height:8px;border-radius:50%;background:${ann.data.color};flex-shrink:0;display:inline-block;"></span>`;
      const label = ann.type === 'text' ? `"${(ann.data.content || '').slice(0, 18)}"` : `↗ Arrow`;
      row.innerHTML = `${dot}<span style="flex:1">${label}</span><button class="remove-anno" data-id="${ann.id}" style="background:none;border:none;color:#ff6666;cursor:pointer;font-size:13px;padding:0 2px;">×</button>`;
      row.addEventListener('click', e => { if (!e.target.classList.contains('remove-anno')) selectAnnotation(ann.id); refreshList(); });
      row.querySelector('.remove-anno').addEventListener('click', e => { e.stopPropagation(); removeAnnotation(ann.id); });
      annotList.appendChild(row);
    });
  }

  function removeAnnotation(id) {
    const idx = annotations.findIndex(a => a.id === id);
    if (idx === -1) return;
    annotations[idx].el.disposeDrag();
    annotations[idx].el.remove();
    annotations.splice(idx, 1);
    if (selectedAnnotId === id) { selectedAnnotId = null; hideTransformControls(); }
    refreshList();
  }

  btnAddText.addEventListener('click', () => addText());
  btnAddArrow.addEventListener('click', () => addArrow());

  // One compositor for downloads and Studio references. Copy the WebGL canvas
  // synchronously after rendering; restore scene visibility even if encoding fails.
  async function capture(mime = 'image/png') {
    beforeCapture();
    const canvasRect = getCanvasRect();
    const bounds = exportFrame.getBoundingClientRect();
    if (!exportActive || !canvasRect.width || !bounds.width) throw Error('Open Export and frame the scene first.');
    const source = stage.renderer.domElement;
    const scaleX = source.width / canvasRect.width, scaleY = source.height / canvasRect.height;
    const x = Math.max(0, bounds.left - canvasRect.left), y = Math.max(0, bounds.top - canvasRect.top);
    const width = Math.min(bounds.width, canvasRect.width - x), height = Math.min(bounds.height, canvasRect.height - y);
    const finalCanvas = document.createElement('canvas');
    finalCanvas.width = Math.max(1, Math.round(width * scaleX));
    finalCanvas.height = Math.max(1, Math.round(height * scaleY));
    const ctx = finalCanvas.getContext('2d');
    if (!ctx) throw Error('Could not create the capture canvas.');
    renderSceneCapture(stage, THREE, {
      includeGizmo: document.getElementById('export-gizmo').checked,
      includeCoords: document.getElementById('export-coordinates').checked,
      includeBg: document.getElementById('export-background').checked,
      background: bgSelect.value,
    }, () => ctx.drawImage(source, Math.round(x * scaleX), Math.round(y * scaleY), finalCanvas.width, finalCanvas.height, 0, 0, finalCanvas.width, finalCanvas.height));
    ctx.save();
    ctx.scale(finalCanvas.width / bounds.width, finalCanvas.height / bounds.height);
        annotations.forEach(ann => {
          const d = ann.data;
          ctx.save();
          ctx.translate(d.x, d.y);
          ctx.rotate(d.rot * Math.PI / 180);
          ctx.scale(d.sx, d.sy);

          if (ann.type === 'text') {
            const text = d.content || '';
            ctx.font = 'bold 18px Inter, sans-serif';
            const metrics = ctx.measureText(text);
            const tw = metrics.width + 20, th = 28;
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillRect(0, 0, tw, th);
            ctx.fillStyle = d.color;
            ctx.textBaseline = 'middle';
            ctx.fillText(text, 10, th / 2);
          }
          if (ann.type === 'arrow') {
            const aw = d.length;
            ctx.strokeStyle = d.color;
            ctx.lineWidth = 3;
            ctx.beginPath(); ctx.moveTo(0, 12); ctx.lineTo(aw - 10, 12); ctx.stroke();
            ctx.fillStyle = d.color;
            ctx.beginPath();
            ctx.moveTo(aw, 12);
            ctx.lineTo(aw - 12, 6);
            ctx.lineTo(aw - 12, 18);
            ctx.closePath(); ctx.fill();
          }
          ctx.restore();
        });
    ctx.restore();
    return new Promise((resolve, reject) => finalCanvas.toBlob(blob => blob ? resolve(blob) : reject(Error('Could not encode the scene image.')), mime, 1));
  }

  const sendButton = document.getElementById('btn-send-studio');
  const message = document.getElementById('stage-message');
  async function run(action) {
    btnDoExport.disabled = sendButton.disabled = true;
    message.textContent = 'Capturing scene…';
    try { await action(); message.textContent = ''; }
    catch (error) { message.textContent = error.message || 'Could not capture the scene.'; }
    finally { btnDoExport.disabled = sendButton.disabled = false; }
  }
  btnDoExport.addEventListener('click', () => run(async () => {
    const mime = document.getElementById('export-background').checked ? 'image/jpeg' : 'image/png';
    const blob = await capture(mime), url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.download = mime === 'image/png' ? 'pose-export.png' : 'pose-export.jpg'; link.href = url; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }));
  sendButton.addEventListener('click', () => run(() => onSend(() => capture())));

  return {
    getFrame() { return exportActive ? cameraFrame : null; },
    snapshot() {
      const rect = getCanvasRect();
      return {
        active: exportActive, preset: presetSelect.value, background: bgSelect.value,
        gizmo: document.getElementById('export-gizmo').checked,
        coordinates: document.getElementById('export-coordinates').checked,
        includeBackground: document.getElementById('export-background').checked,
        frame: rect.width && rect.height ? { x: (frameRect.x - rect.left) / rect.width, y: (frameRect.y - rect.top) / rect.height, width: frameRect.width / rect.width, height: frameRect.height / rect.height } : null,
        annotations: annotations.map(a => ({ ...a.data })),
      };
    },
    restore(data) {
      closeExport();
      [...annotations].forEach(a => removeAnnotation(a.id));
      annotList.replaceChildren(); selectedAnnotId = null; annoCounter = 0; hideTransformControls();
      presetSelect.value = data?.preset ?? '16:9'; bgSelect.value = data?.background ?? '#A6A6A6';
      document.getElementById('export-gizmo').checked = data?.gizmo ?? false;
      document.getElementById('export-coordinates').checked = data?.coordinates ?? false;
      document.getElementById('export-background').checked = data?.includeBackground ?? true;
      for (const a of data?.annotations ?? []) { if (a.type === 'text') addText(a); else if (a.type === 'arrow') addArrow(a); }
      selectAnnotation(null);
      beforeCapture();
      if (data?.active) document.getElementById('btn-export').click();
      if (data?.frame) {
        const rect = getCanvasRect();
        frameRect.x = rect.left + data.frame.x * rect.width; frameRect.y = rect.top + data.frame.y * rect.height;
        frameRect.width = data.frame.width * rect.width; frameRect.height = data.frame.height === undefined ? frameRect.width / getAspectRatio() : data.frame.height * rect.height;
        clampFrame(); applyFrameRect();
      }
      message.textContent = '';
    },
    capture,
  };
}

// Keep physical lights in the render while temporarily removing editor overlays.
// Synchronous readback also works when the animation loop is suspended.
export function renderSceneCapture(stage, THREE, { includeGizmo, includeCoords, includeBg, background }, draw) {
  const oldBg = stage.scene.background, oldAlpha = stage.renderer.getClearAlpha();
  const visibility = [], highlights = [];
  try {
    stage.scene.traverse(obj => {
      if(obj.selectionHighlight){
        const uniform=obj.selectionHighlight.enabled;
        highlights.push([uniform,uniform.value]);uniform.value=0;
      }
      if (obj.userData?.exportAlwaysHide ||
          (!includeGizmo && (obj.userData?.exportHideWhenGizmoDisabled || obj.userData?.ikLimbKey)) ||
          (!includeCoords && ['GridHelper', 'AxesHelper'].includes(obj.type)) || (!includeBg && obj === stage.ground)) {
        visibility.push([obj, obj.visible]); obj.visible = false;
      }
    });
    stage.scene.background = includeBg ? new THREE.Color(background) : null;
    stage.renderer.setClearAlpha(includeBg ? 1 : 0);
    stage.renderer.render(stage.scene, stage.camera);
    draw();
  } finally {
    stage.scene.background = oldBg;
    stage.renderer.setClearAlpha(oldAlpha);
    visibility.forEach(([obj, visible]) => { obj.visible = visible; });
    highlights.forEach(([uniform,value])=>{uniform.value=value;});
    stage.renderer.render(stage.scene, stage.camera);
  }
}
