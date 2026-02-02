import * as THREE from "three";
import { makeEngine, clamp } from "./engine.js";

const elTimeline = document.getElementById("timeline");
const elTimelineScroll = document.getElementById("timelineScroll");
const elRuler = document.getElementById("timeRuler");
const elNowMarker = document.getElementById("nowMarker");
const elViewport = document.getElementById("viewport");

const btnStart = document.getElementById("btnStart");
const btnPause = document.getElementById("btnPause");
const btnReset = document.getElementById("btnReset");

const elSpeed = document.getElementById("speed");
const elSpeedVal = document.getElementById("speedVal");
const elSeed = document.getElementById("seed");

const hudTime = document.getElementById("hudTime");
const hudInSys = document.getElementById("hudInSys");
const hudDone = document.getElementById("hudDone");
const hudLostClose = document.getElementById("hudLostClose");
const hudLostWait = document.getElementById("hudLostWait");
const hudMaxWait = document.getElementById("hudMaxWait");
const hudLastStart = document.getElementById("hudLastStart");

const excelHead = document.getElementById("excelHead");
const excelBody = document.getElementById("excelBody");

// Escala timeline
const PX_PER_MIN = 6;

const STAGE_COLOR = {
  WAIT:  getCss("--wait"),
  VALID: getCss("--valid"),
  CAMB:  getCss("--camb"),
  SCAN:  getCss("--scan"),
  OUT:   getCss("--out")
};

function getCss(varName){
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || "#999";
}

function fmtHHMM(minDay){
  if (minDay == null || Number.isNaN(minDay)) return "--:--";
  const h = Math.floor(minDay / 60);
  const m = Math.floor(minDay % 60);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}

function fmtSignedMin(x){
  if (x == null || Number.isNaN(x)) return "";
  const s = x >= 0 ? "+" : "";
  return `${s}${x.toFixed(1)}`;
}

function sumStage(timeline, stage){
  let s = 0;
  for (const seg of timeline){
    if (seg.stage !== stage) continue;
    const a = seg.start;
    const b = seg.end ?? seg.start;
    s += Math.max(0, b - a);
  }
  return s;
}

function firstStageStart(timeline, stage){
  let best = null;
  for (const seg of timeline){
    if (seg.stage !== stage) continue;
    if (best == null || seg.start < best) best = seg.start;
  }
  return best;
}

function lastStageEnd(timeline, stage){
  let best = null;
  for (const seg of timeline){
    if (seg.stage !== stage) continue;
    const end = seg.end ?? null;
    if (end == null) continue;
    if (best == null || end > best) best = end;
  }
  return best;
}

// ===== Engine =====
let engine = makeEngine({ seed: Number(elSeed.value || 42) });

// ===== Timeline: ruler + marker =====
function renderRuler(cfg){
  const t0 = cfg.simStartMin;
  const t1 = cfg.closeMin;
  const span = t1 - t0;
  const widthPx = span * PX_PER_MIN;

  elRuler.innerHTML = "";
  const inner = document.createElement("div");
  inner.className = "rulerInner";
  inner.style.width = `${widthPx + 120}px`; // + margen para que no quede justo
  elRuler.appendChild(inner);

  // ticks: cada 15 min; major cada 60 min
  for (let m = t0; m <= t1; m += 15) {
    const x = (m - t0) * PX_PER_MIN + 120; // +120 para alinear con label column-ish
    const tick = document.createElement("div");
    tick.className = "rTick" + ((m % 60 === 0) ? " major" : "");
    tick.style.left = `${x}px`;
    inner.appendChild(tick);

    if (m % 60 === 0) {
      const lab = document.createElement("div");
      lab.className = "rLabel";
      lab.style.left = `${x}px`;
      lab.textContent = fmtHHMM(m);
      inner.appendChild(lab);
    }
  }

  // Alineación: el contenido de timeline empieza con padding + label column.
  // Usamos el mismo offset (120px) al calcular seg.left en renderTimeline.
}

function updateNowMarker(cfg, nowMin){
  const t0 = cfg.simStartMin;
  const t1 = cfg.closeMin;
  const clamped = clamp(nowMin, t0, t1);
  const x = (clamped - t0) * PX_PER_MIN + 120;
  elNowMarker.style.transform = `translateX(${x}px)`;
}

// ===== Timeline 2D =====
function renderTimeline(snapshot){
  const cfg = snapshot.cfg;
  const t0 = cfg.simStartMin;
  const t1 = cfg.closeMin;
  const span = t1 - t0;
  const trackWidth = span * PX_PER_MIN;

  // Filas: mostramos activos + completados + perdidos (en orden de seq)
  const rows = collectAllRows(snapshot).sort((a,b) => (a.seq ?? 999) - (b.seq ?? 999));

  elTimeline.innerHTML = "";

  rows.forEach(e => {
    const row = document.createElement("div");
    row.className = "row";

    const label = document.createElement("div");
    label.className = "label";

    const idDiv = document.createElement("div");
    idDiv.className = "id";
    idDiv.textContent = e.id;

    const metaDiv = document.createElement("div");
    metaDiv.className = "meta";
    const appt = fmtHHMM(e.apptAt);
    const arr  = fmtHHMM(e.arrivalAt);
    const off  = fmtSignedMin(e.arrivalOffset);
    metaDiv.textContent = `${e.study} | T:${appt} L:${arr} ${off ? `(${off}m)` : ""}`;

    label.appendChild(idDiv);
    label.appendChild(metaDiv);

    const track = document.createElement("div");
    track.className = "track";
    track.style.width = `${trackWidth + 120}px`; // +120 por offset visual

    // segmentos
    e.timeline.forEach(seg => {
      const start = clamp(seg.start, t0, t1);
      const end = clamp(seg.end ?? snapshot.t, t0, t1);
      const w = Math.max(1, (end - start) * PX_PER_MIN);

      const div = document.createElement("div");
      div.className = "seg";
      div.style.left = `${(start - t0) * PX_PER_MIN + 120}px`;
      div.style.width = `${w}px`;
      div.style.background = STAGE_COLOR[seg.stage] || "#777";
      track.appendChild(div);
    });

    row.appendChild(label);
    row.appendChild(track);
    elTimeline.appendChild(row);
  });

  // regla/marker
  if (!elRuler.dataset.built) {
    renderRuler(cfg);
    elRuler.dataset.built = "1";
  }
  updateNowMarker(cfg, snapshot.t);
}

// ===== Excel =====
function renderExcel(snapshot){
  const rows = collectAllRows(snapshot).sort((a,b) => (a.seq ?? 999) - (b.seq ?? 999));

  // Header fijo
  excelHead.innerHTML = `
    <tr>
      <th>#</th>
      <th>ID</th>
      <th>Estudio</th>
      <th>Turno</th>
      <th>Llegada</th>
      <th>Offset (min)</th>
      <th>WAIT total (min)</th>
      <th>Valid (min)</th>
      <th>Camb (min)</th>
      <th>Scan (min)</th>
      <th>Salida (min)</th>
      <th>Inicio Scan</th>
      <th>Fin</th>
      <th>Estado</th>
    </tr>
  `;

  excelBody.innerHTML = "";

  rows.forEach(r => {
    const tl = r.timeline || [];
    const waitTot = sumStage(tl, "WAIT");
    const valid = sumStage(tl, "VALID");
    const camb  = sumStage(tl, "CAMB");
    const scan  = sumStage(tl, "SCAN");
    const out   = sumStage(tl, "OUT");

    const scanStart = firstStageStart(tl, "SCAN");     // inicio SCAN
    const endAt = r.endAt ?? lastStageEnd(tl, "OUT") ?? lastStageEnd(tl, "SCAN") ?? null;

    const status = r.status || "ACTIVO";
    const badge = statusToBadge(status);

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.seq ?? ""}</td>
      <td>${r.id}</td>
      <td>${r.study}</td>
      <td>${fmtHHMM(r.apptAt)}</td>
      <td>${fmtHHMM(r.arrivalAt)}</td>
      <td>${r.arrivalOffset != null ? fmtSignedMin(r.arrivalOffset) : ""}</td>
      <td>${waitTot.toFixed(1)}</td>
      <td>${valid.toFixed(1)}</td>
      <td>${camb.toFixed(1)}</td>
      <td>${scan.toFixed(1)}</td>
      <td>${out.toFixed(1)}</td>
      <td>${fmtHHMM(scanStart)}</td>
      <td>${fmtHHMM(endAt)}</td>
      <td>${badge}</td>
    `;
    excelBody.appendChild(tr);
  });
}

function statusToBadge(status){
  if (status === "OK") return `<span class="badge ok">OK</span>`;
  if (status === "PERDIDO_ESPERA") return `<span class="badge lw">Perdido espera</span>`;
  if (status === "PERDIDO_CIERRE") return `<span class="badge lc">Perdido cierre</span>`;
  return `<span class="badge">${status}</span>`;
}

function collectAllRows(snapshot){
  // Unificamos: activos + completados + perdidos
  const all = [];
  for (const a of snapshot.active) all.push(a);
  for (const c of snapshot.completed) all.push(c);
  for (const l of snapshot.lostRows) all.push(l);
  return all;
}

// ===== Three.js 3D =====
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d12);

const camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
camera.position.set(0, 10, 18);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias:true });
elViewport.appendChild(renderer.domElement);

// luces
scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const dir = new THREE.DirectionalLight(0xffffff, 0.8);
dir.position.set(8, 12, 6);
scene.add(dir);

// piso
const floor = new THREE.Mesh(
  new THREE.PlaneGeometry(40, 20),
  new THREE.MeshStandardMaterial({ color: 0x101528, metalness:0.0, roughness:0.9 })
);
floor.rotation.x = -Math.PI / 2;
scene.add(floor);

// Layout (placeholder)
const layout = new THREE.Group();
scene.add(layout);

function addStation(x, z, w, d, colorHex){
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(w, 1.2, d),
    new THREE.MeshStandardMaterial({ color: colorHex, roughness:0.85 })
  );
  box.position.set(x, 0.6, z);
  layout.add(box);
}
addStation(-6, 0, 5, 4, 0x1f3b8a);   // WAIT
addStation(-3.5, 0, 3, 2, 0x14532d); // VALID
addStation( 2, 0, 3, 2, 0x7c4a03);   // CAMB
addStation( 6, 0, 4, 3, 0x7f1d1d);   // SCAN
addStation(10, 0, 2.5, 2, 0x334155); // OUT

// Waypoints
const wpMeshes = new Map();
function renderWaypoints(wps){
  for (const m of wpMeshes.values()) scene.remove(m);
  wpMeshes.clear();

  wps.forEach(wp => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(0.18, 18, 18),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness:0.6 })
    );
    m.position.set(wp.x, 0.18, wp.z);
    scene.add(m);
    wpMeshes.set(wp.id, m);
  });
}

// Pacientes
const patientMeshes = new Map();
function ensurePatientMesh(id){
  if (patientMeshes.has(id)) return patientMeshes.get(id);
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 18, 18),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness:0.5 })
  );
  m.position.set(-6, 0.25, 0);
  scene.add(m);
  patientMeshes.set(id, m);
  return m;
}
function removeMissingPatients(activeIds){
  for (const [id, mesh] of patientMeshes.entries()) {
    if (!activeIds.has(id)) {
      scene.remove(mesh);
      patientMeshes.delete(id);
    }
  }
}
function stageToHex(stage){
  const c = STAGE_COLOR[stage] || "#999999";
  return parseInt(c.replace("#","0x"));
}
function moveTowards(mesh, target, speedPerFrame){
  const dx = target.x - mesh.position.x;
  const dz = target.z - mesh.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-3) return;
  const step = Math.min(dist, speedPerFrame);
  mesh.position.x += (dx / dist) * step;
  mesh.position.z += (dz / dist) * step;
}

// resize
function resize(){
  const r = elViewport.getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / r.height;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

// ===== Loop =====
let running = false;
let lastMs = performance.now();
let speed = Number(elSpeed.value || 2);

elSpeed.addEventListener("input", () => {
  speed = Number(elSpeed.value || 1);
  elSpeedVal.textContent = `${speed.toFixed(2)}×`;
});

btnStart.onclick = () => running = true;
btnPause.onclick = () => running = false;

btnReset.onclick = () => {
  running = false;
  engine = makeEngine({ seed: Number(elSeed.value || 42) });

  // limpiar meshes
  for (const m of patientMeshes.values()) scene.remove(m);
  patientMeshes.clear();
  wpMeshes.clear();

  // rebuild ruler
  elRuler.dataset.built = "";
  elRuler.innerHTML = "";
};

function tick(nowMs){
  const dtSec = (nowMs - lastMs) / 1000;
  lastMs = nowMs;

  if (running) {
    const dtMin = (dtSec * speed) * 1.0; // 1s real ~= 1min sim * speed
    engine.step(dtMin);
  }

  const snap = engine.getSnapshot();

  // HUD
  hudTime.textContent = fmtHHMM(snap.t);
  hudInSys.textContent = String(snap.active.length);
  hudDone.textContent = String(snap.completedCount);
  hudLostClose.textContent = String(snap.lost.byClose);
  hudLostWait.textContent = String(snap.lost.byWait);
  hudMaxWait.textContent = String(snap.stats.maxWaiters);
  hudLastStart.textContent = snap.stats.lastResoStartActual != null ? fmtHHMM(snap.stats.lastResoStartActual) : "--:--";

  if (snap.t >= snap.cfg.closeMin) running = false;

  // Timeline + Excel
  renderTimeline(snap);
  renderExcel(snap);

  // Waypoints
  if (wpMeshes.size === 0) renderWaypoints(snap.waypoints);

  // 3D pacientes: solo activos
  const activeIds = new Set(snap.active.map(e => e.id));
  removeMissingPatients(activeIds);

  snap.active.forEach(e => {
    const mesh = ensurePatientMesh(e.id);
    mesh.material.color.setHex(stageToHex(e.state));

    const wp = snap.waypoints.find(w => w.id === e.targetWp) || snap.waypoints[0];
    const visualSpeed = clamp(3 * dtSec, 0.02, 0.25);
    moveTowards(mesh, wp, visualSpeed);
  });

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
