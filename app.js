// app.js
import * as THREE from "three";
import { makeEngine, clamp } from "./engine.js";

const elTimeline = document.getElementById("timeline");
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

const STAGE_COLOR = {
  WAIT: getCss("--wait"),
  MESA: getCss("--mesa"),
  CAMB: getCss("--camb"),
  SCAN: getCss("--scan"),
  OUT:  getCss("--out")
};

function getCss(varName){
  return getComputedStyle(document.documentElement).getPropertyValue(varName).trim() || "#999";
}

// ===== Engine =====
let engine = makeEngine({ seed: Number(elSeed.value || 42) });

// ===== Timeline 2D =====
function renderTimeline(snapshot){
  // Escala: 1 minuto = 8px (ajustable)
  const pxPerMin = 8;
  const tMax = Math.max(60, snapshot.t); // al menos 60 min visibles

  // mostrar los activos + (opcional) últimos completados: por ahora solo activos
  const rows = snapshot.entities;

  elTimeline.innerHTML = "";

  rows.forEach(e => {
    const row = document.createElement("div");
    row.className = "row";

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = e.id;

    const track = document.createElement("div");
    track.className = "track";
    track.style.width = `${tMax * pxPerMin}px`;

    // segmentos
    e.timeline.forEach(seg => {
      const start = seg.start;
      const end = (seg.end == null) ? snapshot.t : seg.end;
      const w = Math.max(1, (end - start) * pxPerMin);

      const div = document.createElement("div");
      div.className = "seg";
      div.style.left = `${start * pxPerMin}px`;
      div.style.width = `${w}px`;
      div.style.background = STAGE_COLOR[seg.stage] || "#777";
      track.appendChild(div);
    });

    row.appendChild(label);
    row.appendChild(track);
    elTimeline.appendChild(row);
  });
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

// Layout real (placeholder geométrico): sala espera, mesa, cambiador, resonador, salida
const layout = new THREE.Group();
scene.add(layout);

function addStation(name, x, z, w, d, colorHex){
  const box = new THREE.Mesh(
    new THREE.BoxGeometry(w, 1.2, d),
    new THREE.MeshStandardMaterial({ color: colorHex, roughness:0.85 })
  );
  box.position.set(x, 0.6, z);
  box.userData.name = name;
  layout.add(box);

  // etiqueta simple (sprite no; dejamos minimal): poste
  const pole = new THREE.Mesh(
    new THREE.CylinderGeometry(0.05, 0.05, 1.5, 12),
    new THREE.MeshStandardMaterial({ color: 0x94a3b8 })
  );
  pole.position.set(x, 0.75, z - d/2 - 0.6);
  layout.add(pole);
}

addStation("Espera",   -6, 0, 5, 4, 0x1f3b8a);
addStation("Mesa",     -2, 0, 3, 2, 0x14532d);
addStation("Cambiador", 2, 0, 3, 2, 0x7c4a03);
addStation("Resonador", 6, 0, 4, 3, 0x7f1d1d);
addStation("Salida",   10, 0, 2.5, 2, 0x334155);

// Waypoints visibles
const wpMeshes = new Map();
function renderWaypoints(wps){
  // limpiar viejos
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

// Pacientes (bolitas)
const patientMeshes = new Map();
function ensurePatientMesh(id, colorHex){
  if (patientMeshes.has(id)) return patientMeshes.get(id);
  const m = new THREE.Mesh(
    new THREE.SphereGeometry(0.25, 18, 18),
    new THREE.MeshStandardMaterial({ color: colorHex, roughness:0.5 })
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

// movimiento hacia waypoint
function moveTowards(mesh, target, speedPerSec){
  const dx = target.x - mesh.position.x;
  const dz = target.z - mesh.position.z;
  const dist = Math.hypot(dx, dz);
  if (dist < 1e-3) return;
  const step = Math.min(dist, speedPerSec);
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
let speed = Number(elSpeed.value || 1);

elSpeed.addEventListener("input", () => {
  speed = Number(elSpeed.value || 1);
  elSpeedVal.textContent = `${speed.toFixed(2)}×`;
});

btnStart.onclick = () => running = true;
btnPause.onclick = () => running = false;

btnReset.onclick = () => {
  running = false;
  engine = makeEngine({ seed: Number(elSeed.value || 42) });
  // limpiar meshes pacientes
  for (const m of patientMeshes.values()) scene.remove(m);
  patientMeshes.clear();
};

function tick(nowMs){
  const dtSec = (nowMs - lastMs) / 1000;
  lastMs = nowMs;

  // Sim: convertir a minutos
  if (running) {
    const dtMin = (dtSec * speed) / 1.0; // 1 sec real = 1 min sim a speed=1 (rápido a propósito)
    engine.step(dtMin);
  }

  const snap = engine.getSnapshot();

  // HUD
  hudTime.textContent = snap.t.toFixed(1);
  hudInSys.textContent = String(snap.entities.length);
  hudDone.textContent = String(snap.completedCount);

  // Timeline
  renderTimeline(snap);

  // Waypoints
  if (wpMeshes.size === 0) renderWaypoints(snap.waypoints);

  // 3D: pacientes
  const active = new Set(snap.entities.map(e => e.id));
  removeMissingPatients(active);

  snap.entities.forEach(e => {
    const mesh = ensurePatientMesh(e.id, stageToHex(e.state));
    // actualizar color por estado
    mesh.material.color.setHex(stageToHex(e.state));

    const wp = snap.waypoints.find(w => w.id === e.targetWp) || snap.waypoints[0];
    // velocidad de desplazamiento visual (metros por frame)
    const visualSpeed = clamp(3 * dtSec, 0.02, 0.2);
    moveTowards(mesh, wp, visualSpeed);
  });

  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

requestAnimationFrame(tick);
