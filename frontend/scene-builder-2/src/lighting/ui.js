import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { RectAreaLightHelper } from 'three/examples/jsm/helpers/RectAreaLightHelper.js';
import { defaultLighting, defaultLightingEditor, isLightingEditor, LIGHT_TYPES, createLight, supportsShadow, supportsTarget, shadowBudget, lightingJSON, parseLightingJSON } from './state.js';
import { PRESETS, lightingPreset } from './presets.js';
import { generateLightingCode } from './codeExport.js';
export function createLightingUI(stage, controller, { enter, leave, commit, dragChanged, getSelection, getSubjects }) {
    let settings = defaultLightingEditor(), dragStart, helper, frustum, helperLight, layoutKey, pending = null;
    const fields = [];
    const gizmo = new TransformControls(stage.camera, stage.renderer.domElement);
    const marker = new THREE.Mesh(new THREE.SphereGeometry(0.08), new THREE.MeshBasicMaterial({ color: 0xffcc44, depthTest: false }));
    marker.renderOrder = 1000;
    function overlay(object) { object.traverse(node => { node.userData.exportAlwaysHide = true; }); stage.scene.add(object); }
    overlay(gizmo);
    overlay(marker);
    const panel = document.createElement('section');
    panel.id = 'lighting-panel';
    panel.className = 'glass-panel';
    panel.hidden = true;
    panel.setAttribute('aria-label', 'Lighting');
    panel.innerHTML = `<header><strong>Lighting</strong><button class="btn" id="lighting-close" aria-label="Close lighting">×</button></header>
    <label>Light <select id="lighting-select" aria-label="Selected light"></select></label>
    <div class="lighting-actions"><select id="lighting-type" aria-label="New light type"></select><button class="btn" id="lighting-add">Add</button><button class="btn" id="lighting-duplicate">Duplicate</button><button class="btn" id="lighting-delete">Delete</button></div>
    <div id="lighting-fields"></div>
    <div class="lighting-actions"><button class="btn" id="lighting-move">Move light</button><button class="btn" id="lighting-target">Move target</button><button class="btn" id="lighting-rotate">Rotate</button></div>
    <div class="lighting-actions"><button class="btn" id="lighting-aim-selection">Aim at selection</button><button class="btn" id="lighting-aim-center">Aim at scene center</button></div>
    <label><input id="lighting-helper" type="checkbox"> Show selected light helper</label><label><input id="lighting-frustum" type="checkbox"> Show shadow camera</label>
    <div id="lighting-global"></div><button class="btn" id="lighting-fit">Refresh shadow fit</button>
    <details><summary>Ground</summary><div id="lighting-ground"></div></details>
    <label>Preset <select id="lighting-preset"></select><button class="btn" id="lighting-apply-preset">Apply</button></label>
    <p>Per-light resolution overrides global quality. Point shadows cost eight atlas tiles; lower resolution before adding more shadow lights.</p>
    <p>Presets replace lights. Ground and object shadow settings are retained. Soft portrait uses standard shadow-map approximations.</p>
    <div class="lighting-actions"><button class="btn" id="lighting-import">Import lighting JSON</button><button class="btn" id="lighting-export">Export lighting JSON</button></div>
    <details id="lighting-code-panel"><summary>Advanced code export</summary><label>Format <select id="lighting-format"><option value="vanilla">Three.js</option><option value="r3f">React Three Fiber</option></select></label><label id="lighting-code-helper-row"><input id="lighting-code-helpers" type="checkbox"> Include helpers</label><textarea id="lighting-code" aria-label="Generated lighting code" readonly rows="12"></textarea><button class="btn" id="lighting-copy">Copy code</button></details>
    <p id="lighting-budget"></p><p id="lighting-error" role="alert"></p><button class="btn" id="lighting-reset">Reset lighting</button>`;
    document.getElementById('app').append(panel);
    const button = document.createElement('button');
    button.className = 'btn';
    button.textContent = 'Lighting';
    document.querySelector('#ui-overlay .toolbar').append(button);
    button.setAttribute('aria-controls', panel.id);
    button.setAttribute('aria-expanded', 'false');
    const el = id => panel.querySelector(`#lighting-${id}`);
    for (const type of LIGHT_TYPES)
        el('type').add(new Option(type === 'area' ? 'Rectangular area' : type, type));
    for (const preset of PRESETS)
        el('preset').add(new Option(preset, preset));
    function current() { return controller.snapshot().lights.find(l => l.id === settings.selected); }
    function finish() { if (pending !== null && pending !== JSON.stringify(controller.snapshot()))
        commit(); pending = null; }
    function edit(update, record = true) {
        const before = controller.snapshot(), next = structuredClone(before);
        try {
            update(next, next.lights.find(l => l.id === settings.selected));
            controller.apply(next);
            controller.flush(true);
            el('error').textContent = '';
            sync();
            if (record && JSON.stringify(before) !== JSON.stringify(next))
                commit();
        }
        catch (error) {
            el('error').textContent = error.message;
            sync();
        }
    }
    function field(container, label, read, write, type = 'number', choices = null, unit = 1, step = 'any') {
        const row = document.createElement('label'), caption = document.createElement('span');
        caption.textContent = label;
        row.append(caption);
        const input = document.createElement(choices ? 'select' : 'input');
        input.setAttribute('aria-label', label);
        if (choices)
            for (const [value, text] of choices)
                input.add(new Option(text, value));
        else {
            input.type = type;
            if (type === 'number')
                input.step = step;
        }
        row.append(input);
        container.append(row);
        const update = (source = input) => {
            if (type === 'number' && !choices && source.value.trim() === '') {
                el('error').textContent = 'Enter a finite number.';
                return;
            }
            const value = type === 'checkbox' ? source.checked : type === 'number' ? Number(source.value) * unit : source.value;
            edit((state, light) => write(state, light, value), false);
        };
        input.addEventListener('input', () => { pending ??= JSON.stringify(controller.snapshot()); update(); });
        input.addEventListener('change', () => { pending ??= JSON.stringify(controller.snapshot()); update(); finish(); sync(); });
        input.addEventListener('blur', () => { finish(); sync(); });
        input.addEventListener('keydown', event => { if (event.key === 'Enter')
            input.blur(); });
        let range;
        if (type === 'number' && !choices && !label.startsWith('Shadow')) {
            range = document.createElement('input');
            range.type = 'range';
            range.setAttribute('aria-label', `${label} slider`);
            const spatial = /^(position|target|rotation)/.test(label);
            range.min = spatial ? (label.startsWith('rotation') ? -180 : -30) : 0;
            range.max = label.startsWith('rotation') ? 180 : spatial ? 30 : label.includes('angle') ? 89 : label === 'Penumbra' || label === 'Opacity' ? 1 : label === 'Intensity' ? 10 : label.includes('Extent') ? 100 : 40;
            range.step = label === 'Penumbra' || label === 'Opacity' ? 0.01 : 0.1;
            row.insertBefore(range, input);
            range.addEventListener('input', () => { pending ??= JSON.stringify(controller.snapshot()); update(range); });
            range.addEventListener('change', () => { finish(); sync(); });
            range.addEventListener('blur', finish);
        }
        fields.push({ input, range, read, type, unit });
    }
    const quality = [['low', 'Lightweight (512)'], ['balanced', 'Balanced (1024)'], ['high', 'High (2048)']];
    field(el('global'), 'Global shadows', s => s.shadows.enabled, (s, l, v) => s.shadows.enabled = v, 'checkbox');
    field(el('global'), 'Quality', s => s.shadows.quality, (s, l, v) => s.shadows.quality = v, 'text', quality);
    field(el('global'), 'Shadow filter', s => s.shadows.filter, (s, l, v) => s.shadows.filter = v, 'text', [['basic', 'Basic'], ['pcf', 'PCF'], ['pcfSoft', 'PCF soft'], ['vsm', 'Variance (VSM)']]);
    for (const [key, label, type] of [['visible', 'Visible', 'checkbox'], ['receiveShadow', 'Receive shadows', 'checkbox'], ['color', 'Ground color', 'color'], ['opacity', 'Opacity', 'number'], ['extent', 'Extent (world units)', 'number']])
        field(el('ground'), label, s => s.ground[key], (s, l, v) => s.ground[key] = v, type);
    const fixedFields = fields.length;
    function rebuild(data, state) {
        fields.splice(fixedFields);
        el('fields').replaceChildren();
        if (!data) {
            el('fields').textContent = 'Add a light to begin.';
            return;
        }
        const simple = (key, label, type = 'number', container = el('fields'), choices = null, unit = 1) => field(container, label, (s, l) => l[key], (s, l, v) => l[key] = v, type, choices, unit);
        simple('name', 'Name', 'text');
        simple('enabled', 'Enabled', 'checkbox');
        simple('color', data.type === 'hemisphere' ? 'Sky color' : 'Color', 'color');
        simple('intensity', 'Intensity');
        if (data.groundColor)
            simple('groundColor', 'Ground color', 'color');
        for (const key of ['position', 'target', 'rotation'])
            if (data[key])
                for (let axis = 0; axis < 3; axis++)
                    field(el('fields'), `${key} ${'XYZ'[axis]}${key === 'rotation' ? ' (°)' : ''}`, (s, l) => l[key][axis], (s, l, v) => l[key][axis] = v, 'number', null, key === 'rotation' ? Math.PI / 180 : 1);
        for (const [key, label] of [['distance', 'Range (0 = unlimited)'], ['decay', 'Decay'], ['angle', 'Cone half-angle (°)'], ['penumbra', 'Penumbra'], ['width', 'Width'], ['height', 'Height']])
            if (data[key] !== undefined)
                simple(key, label, 'number', el('fields'), null, key === 'angle' ? Math.PI / 180 : 1);
        const hint = document.createElement('p');
        hint.textContent = data.type === 'directional' ? 'Aim controls direction; distance does not dim directional light.' : data.type === 'area' ? 'Area lights require Standard/Physical materials and do not cast native shadows. Imported unlit materials retain their appearance.' : data.type === 'hemisphere' ? 'Position defines sky orientation.' : '';
        el('fields').append(hint);
        if (supportsShadow(data.type)) {
            simple('castShadow', 'Cast shadows', 'checkbox');
            const advanced = document.createElement('details');
            const summary = document.createElement('summary');
            summary.textContent = 'Advanced shadows';
            advanced.append(summary);
            el('fields').append(advanced);
            simple('autoFit', 'Automatic fitting', 'checkbox', advanced);
            field(advanced, 'Resolution', (s, l) => l.shadow.resolution, (s, l, v) => l.shadow.resolution = v, 'number', [[0, 'Global quality'], 256, 512, 1024, 2048, 4096].map(v => Array.isArray(v) ? v : [v, String(v)]));
            for (const key of ['bias', 'normalBias', ...(!data.autoFit ? ['near', 'far', ...(data.type === 'directional' ? ['left', 'right', 'bottom', 'top'] : [])] : []), ...(state.shadows.filter === 'pcf' || state.shadows.filter === 'vsm' || (data.type === 'point' && state.shadows.filter === 'pcfSoft') ? ['radius'] : []), ...(state.shadows.filter === 'vsm' && data.type !== 'point' ? ['blurSamples'] : [])])
                field(advanced, `Shadow ${key}`, (s, l) => l.shadow[key], (s, l, v) => l.shadow[key] = v);
        }
    }
    function updateOverlays() {
        const light = controller.get(settings.selected);
        if (helperLight !== light) {
            helper?.removeFromParent();
            helper?.dispose();
            frustum?.removeFromParent();
            frustum?.dispose();
            helper = null;
            frustum = null;
            helperLight = light;
            if (light && !light.isAmbientLight) {
                helper = light.isDirectionalLight ? new THREE.DirectionalLightHelper(light, 0.8, 0x66aaff) : light.isHemisphereLight ? new THREE.HemisphereLightHelper(light, 0.8) : light.isPointLight ? new THREE.PointLightHelper(light, 0.35, 0xff8844) : light.isSpotLight ? new THREE.SpotLightHelper(light, 0xff66aa) : new RectAreaLightHelper(light, 0x66aaff);
                overlay(helper);
            }
            if (light?.shadow) {
                frustum = new THREE.CameraHelper(light.shadow.camera);
                overlay(frustum);
            }
        }
        if (helper) {
            light.updateWorldMatrix(true, false);
            light.target?.updateWorldMatrix(true, false);
            if (settings.helper)
                helper.update?.();
            helper.visible = settings.helper;
        }
        if (frustum) {
            if (settings.frustum)
                frustum.update();
            frustum.visible = !!settings.frustum;
        }
        marker.visible = !!(settings.helper && light?.target);
        if (light?.target)
            marker.position.copy(light.target.position);
    }
    function updateCode() {
        el('code-helper-row').hidden = el('format').value !== 'vanilla';
        if (el('code-panel').open)
            el('code').value = generateLightingCode(controller.snapshot(), el('format').value, el('code-helpers').checked);
    }
    function sync() {
        const state = controller.snapshot();
        if (settings.selected && !state.lights.some(l => l.id === settings.selected))
            settings.selected = state.lights[0]?.id ?? null;
        const data = current(), key = JSON.stringify([state.lights.map(l => [l.id, l.type]), data?.id, data?.type, data?.autoFit, state.shadows.filter]);
        if (key !== layoutKey) {
            el('select').replaceChildren(...state.lights.map(l => new Option(l.name, l.id)));
            rebuild(data, state);
            layoutKey = key;
        }
        for (let i = 0; i < state.lights.length; i++)
            el('select').options[i].textContent = state.lights[i].name;
        el('select').value = settings.selected ?? '';
        for (const f of fields) {
            const value = f.read(state, data);
            if (f.range)
                f.range.value = value / f.unit;
            if (f.type === 'checkbox')
                f.input.checked = value;
            else if (document.activeElement !== f.input)
                f.input.value = f.type === 'number' ? Number((value / f.unit).toFixed(6)) : value;
        }
        el('duplicate').disabled = el('delete').disabled = !data;
        el('move').hidden = !data || data.type === 'ambient';
        el('target').hidden = !supportsTarget(data?.type);
        el('rotate').hidden = data?.type !== 'area';
        for (const id of ['aim-selection', 'aim-center'])
            el(id).hidden = !(supportsTarget(data?.type) || data?.type === 'area');
        el('helper').checked = settings.helper;
        el('frustum').checked = !!settings.frustum;
        el('frustum').disabled = !supportsShadow(data?.type);
        const budget = shadowBudget(state);
        el('budget').textContent = `${state.lights.length}/16 lights · ${budget.count}/4 shadow lights · ${(budget.bytes / 1048576).toFixed(1)}/128 MiB estimated maps`;
        updateOverlays();
        updateCode();
        const light = controller.get(settings.selected);
        if (gizmo.object && gizmo.object !== light && gizmo.object !== light?.target)
            attach();
    }
    function attach() { gizmo.detach(); const light = controller.get(settings.selected); if (light && !light.isAmbientLight) {
        if (settings.mode === 'target' && !light.target)
            settings.mode = 'light';
        if (settings.mode === 'rotate' && !light.isRectAreaLight)
            settings.mode = 'light';
        gizmo.setMode(settings.mode === 'rotate' ? 'rotate' : 'translate');
        gizmo.attach(settings.mode === 'target' ? light.target : light);
    } updateOverlays(); dragChanged(); }
    function select(id) { finish(); settings.selected = id; settings.mode = 'light'; enter(); sync(); attach(); }
    function exit(restore = true) { commitPending(); settings.selected = null; gizmo.detach(); panel.hidden = true; button.setAttribute('aria-expanded', 'false'); if (restore)
        leave(); sync(); dragChanged(); }
    button.addEventListener('click', () => { if (!panel.hidden)
        exit();
    else {
        panel.hidden = false;
        button.setAttribute('aria-expanded', 'true');
        select(controller.snapshot().lights[0]?.id ?? null);
    } });
    el('close').addEventListener('click', () => exit());
    el('select').addEventListener('change', () => select(el('select').value));
    for (const [id, mode] of [['move', 'light'], ['target', 'target'], ['rotate', 'rotate']])
        el(id).addEventListener('click', () => { finish(); settings.mode = mode; attach(); });
    for (const key of ['helper', 'frustum'])
        el(key).addEventListener('change', () => { settings[key] = el(key).checked; updateOverlays(); });
    el('add').addEventListener('click', () => { finish(); const light = createLight(el('type').value); edit(s => s.lights.push(light)); if (controller.get(light.id))
        select(light.id); });
    el('duplicate').addEventListener('click', () => { finish(); const data = current(); if (!data)
        return; const copy = structuredClone(data); copy.id = crypto.randomUUID(); copy.name = `${data.name.slice(0, 190)} copy`; edit(s => s.lights.push(copy)); if (controller.get(copy.id))
        select(copy.id); });
    function deleteLight() { finish(); edit(s => { s.lights = s.lights.filter(l => l.id !== settings.selected); }); attach(); }
    el('delete').addEventListener('click', deleteLight);
    for (const [id, selection] of [['aim-selection', true], ['aim-center', false]])
        el(id).addEventListener('click', () => {
            const roots = selection ? [getSelection?.()].filter(Boolean) : getSubjects();
            const bounds = new THREE.Box3();
            for (const root of roots)
                bounds.union(new THREE.Box3().setFromObject(root, true));
            if (bounds.isEmpty()) {
                el('error').textContent = 'No subject bounds available.';
                return;
            }
            const target = bounds.getCenter(new THREE.Vector3());
            edit((s, l) => { if (l.target)
                l.target = target.toArray();
            else {
                const temp = new THREE.Object3D();
                temp.position.fromArray(l.position);
                temp.lookAt(target);
                temp.rotateY(Math.PI);
                l.rotation = temp.rotation.toArray().slice(0, 3);
            } });
        });
    el('fit').addEventListener('click', () => { controller.invalidate(); controller.flush(true); updateOverlays(); });
    el('apply-preset').addEventListener('click', () => { finish(); edit(s => Object.assign(s, lightingPreset(el('preset').value, s))); attach(); });
    el('reset').addEventListener('click', () => { finish(); edit(s => Object.assign(s, defaultLighting())); attach(); });
    function download(text, name) { const url = URL.createObjectURL(new Blob([text], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
    el('export').addEventListener('click', () => download(lightingJSON(controller.snapshot()), 'lighting.json'));
    el('import').addEventListener('click', () => { const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json'; input.addEventListener('change', async () => { try {
        const file = input.files[0];
        if (!file)
            return;
        if (file.size > 1024 * 1024)
            throw Error('Lighting JSON exceeds 1 MiB.');
        const next = parseLightingJSON(await file.text());
        finish();
        edit(s => Object.assign(s, next));
        attach();
    }
    catch (error) {
        el('error').textContent = error.message;
    } }); input.click(); });
    el('format').addEventListener('change', updateCode);
    el('code-helpers').addEventListener('change', updateCode);
    el('code-panel').addEventListener('toggle', updateCode);
    el('copy').addEventListener('click', async () => { try {
        await navigator.clipboard.writeText(el('code').value);
    }
    catch {
        el('error').textContent = 'Copy failed; select the code manually.';
    } });
    gizmo.addEventListener('dragging-changed', event => { if (event.value)
        dragStart = JSON.stringify(controller.snapshot());
    else {
        if (dragStart && dragStart !== JSON.stringify(controller.snapshot()))
            commit();
        dragStart = null;
    } dragChanged(); });
    gizmo.addEventListener('objectChange', () => edit((s, l) => { const light = controller.get(l.id); if (l.position)
        l.position = light.position.toArray(); if (l.target)
        l.target = light.target.position.toArray(); if (l.rotation)
        l.rotation = light.rotation.toArray().slice(0, 3); }, false));
    function commitPending() { finish(); if (gizmo.dragging)
        gizmo.pointerUp(null); }
    window.addEventListener('scene-suspend', commitPending);
    sync();
    return { gizmo, dispose() { commitPending(); window.removeEventListener('scene-suspend', commitPending); gizmo.detach(); gizmo.dispose(); gizmo.removeFromParent(); helper?.removeFromParent(); helper?.dispose(); frustum?.removeFromParent(); frustum?.dispose(); marker.removeFromParent(); marker.geometry.dispose(); marker.material.dispose(); panel.remove(); button.remove(); }, get active() { return !panel.hidden; }, exit, sync, deleteSelected: deleteLight, updateOverlays, commitPending, snapshot: () => structuredClone(settings), restore(value) { settings = isLightingEditor(value) ? { ...defaultLightingEditor(), ...structuredClone(value) } : defaultLightingEditor(); panel.hidden = settings.selected === null; button.setAttribute('aria-expanded', String(!panel.hidden)); if (!panel.hidden)
            enter(); sync(); attach(); } };
}
