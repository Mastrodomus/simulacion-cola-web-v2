// engine.js — Simulador Resonador (Agenda diaria, event-driven)
// Unidades: minutos del día. Ej: 08:00 = 480, 19:51 = 1191, 20:00 = 1200.
//
// Reglas implementadas (según lo acordado):
// - 24 pacientes por corrida (agenda de 24 turnos).
// - Tipos de estudio: discreto probabilístico.
// - Scan: Normal por tipo.
// - Validación/Cambiador/Salida: Normal.
// - Cambiador solo ocurre si resonador libre; resonador se ocupa CAMB + SCAN.
// - Último inicio de resonador: 19:51 (hh:mm).
// - Cierre: 20:00. Todo lo no completado se pierde (se fue a otro local).
// - Sala de espera: 10 sillas.
//   - Si al llegar está llena (>=10 en WAIT), se programa paciencia 60 min.
//   - Si no avanza y sigue en WAIT cuando vence, abandona (perdido).
//   - Si NO estaba llena al llegar, no abandona por espera (puede esperar).
//
// El motor produce estados para Timeline y 3D: WAIT, VALID, CAMB, SCAN, OUT.

export function makeRng(seed = 42) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function normal(rng, mu, sigma) {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
  return mu + sigma * z;
}

class MinHeap {
  constructor(){ this.a = []; }
  push(x){
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].t <= a[i].t) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop(){
    const a = this.a;
    if (!a.length) return null;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].t < a[m].t) m = l;
        if (r < a.length && a[r].t < a[m].t) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  peek(){ return this.a.length ? this.a[0] : null; }
  get size(){ return this.a.length; }
}

const STUDIES = [
  { key:"Cerebro",  p:0.30, mu:25, sigma:4 },
  { key:"Columna",  p:0.25, mu:30, sigma:5 },
  { key:"Rodilla",  p:0.20, mu:20, sigma:3 },
  { key:"Abdomen",  p:0.15, mu:28, sigma:4 },
  { key:"Otros",    p:0.10, mu:22, sigma:3 },
];

function pickStudy(rng){
  const u = rng();
  let acc = 0;
  for (const s of STUDIES){
    acc += s.p;
    if (u <= acc) return s;
  }
  return STUDIES[STUDIES.length - 1];
}

export function makeEngine(opts = {}) {
  let rng = makeRng(opts.seed ?? 42);

  const cfg = {
    seed: opts.seed ?? 42,

    simStartMin: 8*60,              // 08:00
    closeMin: 20*60,                // 20:00
    lastResoStartMin: 19*60 + 51,   // 19:51 (hh:mm)

    // Agenda del día
    slotCount: 24,
    minGapMin: 12,        // gap mínimo entre turnos asignados
    slotJitterMin: 8,     // jitter para “humanizar” la agenda
    // Llegada vs turno (offset en minutos): Normal clamp
    arrivalOffsetMu: 0,
    arrivalOffsetSigma: 6,
    arrivalOffsetMin: -15,
    arrivalOffsetMax: 20,

    // Procesos auxiliares (Normal)
    validMu: 5, validSigma: 1,
    cambMu:  6, cambSigma:  1.5,
    exitMu:  4, exitSigma:  1,

    // Espera
    waitCap: 10,
    patienceMin: 60,      // se aplica SOLO si llegó con sala llena

    // clamps
    minProcessMin: 0.5,

    // Corrida
    targetDone: 24,
  };

  // Waypoints para 3D
  const waypoints = [
    { id:"WAIT",  name:"Sala de espera", x:-6, z:0 },
    { id:"VALID", name:"Validación",     x:-3.5, z:0 },
    { id:"CAMB",  name:"Cambiador",      x: 2, z:0 },
    { id:"SCAN",  name:"Resonador",      x: 6, z:0 },
    { id:"OUT",   name:"Salida",         x:10, z:0 },
  ];

  // Estado
  let t = cfg.simStartMin;
  let idSeq = 1;

  const evq = new MinHeap();
  const entities = new Map(); // id -> entity
  const completed = [];

  const lost = {
    byClose: 0,
    byWait: 0
  };

  const stats = {
    maxWaiters: 0,
    lastResoStartActual: null
  };

  // Recursos / colas
  let validBusy = false;
  let resonatorBusy = false;
  let resonatorLockedOut = false;

  const qWait = [];         // FIFO ids en WAIT (incluye pre y post validación)
  const qWaitingForReso = [];// FIFO ids post-validación esperando resonador

  // ==== API pública ====
  function step(dtMin){
    const targetT = Math.min(t + dtMin, cfg.closeMin);

    while (evq.size && evq.peek().t <= targetT) {
      const ev = evq.pop();
      t = ev.t;
      handleEvent(ev);

      if (t >= cfg.closeMin) break;
    }

    t = targetT;

    if (t >= cfg.closeMin) {
      flushCloseLoss();
    }
  }

  function getSnapshot(){
    return {
      t,
      cfg: { ...cfg },
      waypoints: waypoints.map(w => ({...w})),
      entities: Array.from(entities.values()).map(e => ({
        id: e.id,
        state: e.state,
        study: e.study.key,
        apptAt: e.apptAt,
        arrivalAt: e.arrivalAt,
        arrivalOffset: e.arrivalOffset,
        timeline: e.timeline.map(s => ({...s})),
        pos: { ...e.pos },
        targetWp: e.targetWp,
      })),
      completedCount: completed.length,
      lost: { ...lost },
      stats: { ...stats }
    };
  }

  function reset(newSeed = cfg.seed){
    rng = makeRng(newSeed);
    cfg.seed = newSeed;

    t = cfg.simStartMin;
    idSeq = 1;

    evq.a.length = 0;
    entities.clear();
    completed.length = 0;

    lost.byClose = 0;
    lost.byWait = 0;

    stats.maxWaiters = 0;
    stats.lastResoStartActual = null;

    validBusy = false;
    resonatorBusy = false;
    resonatorLockedOut = false;

    qWait.length = 0;
    qWaitingForReso.length = 0;

    programScheduleDay();
  }

  function setSeed(seed){ reset(seed); }

  function setConfig(patch){
    Object.assign(cfg, patch);
    // Re-armar la corrida para que aplique agenda nueva
    reset(cfg.seed);
  }

  reset(cfg.seed);

  return { step, getSnapshot, reset, setSeed, setConfig };

  // ======================
  //    Agenda del día
  // ======================

  function programScheduleDay(){
    // Armamos 24 turnos entre 08:00 y 19:51, con el último fijo en 19:51
    const slots = buildAppointmentSlots(
      cfg.simStartMin,
      cfg.lastResoStartMin,
      cfg.slotCount,
      cfg.minGapMin,
      cfg.slotJitterMin
    );

    for (let i = 0; i < slots.length; i++){
      const apptAt = slots[i];

      const offset = clamp(
        normal(rng, cfg.arrivalOffsetMu, cfg.arrivalOffsetSigma),
        cfg.arrivalOffsetMin,
        cfg.arrivalOffsetMax
      );

      const arrivalAt = clamp(apptAt + offset, cfg.simStartMin, cfg.closeMin);

      schedule({ t: arrivalAt, type:"ARRIVAL", apptAt, offset });
    }
  }

  function buildAppointmentSlots(startMin, lastStartMin, n, minGap, jitter){
    // Distribución suave + jitter, asegurando:
    // - slots crecientes
    // - gap mínimo
    // - último slot EXACTO en lastStartMin
    if (n < 2) return [lastStartMin];

    const slots = new Array(n);
    slots[n - 1] = lastStartMin;

    // Distribuir los primeros n-1 en [startMin, lastStartMin - minGap]
    const endForOthers = lastStartMin - minGap;
    const span = Math.max(1, endForOthers - startMin);

    for (let i = 0; i < n - 1; i++){
      const frac = i / (n - 2); // 0..1
      let base = startMin + frac * span;

      // jitter simétrico, con menor jitter cerca de los bordes
      const edgeFactor = 0.35 + 0.65 * Math.sin(Math.PI * frac); // 0.35..1..0.35
      const j = (rng()*2 - 1) * jitter * edgeFactor;

      slots[i] = base + j;
    }

    // Ordenar y aplicar gap mínimo
    slots.slice(0, n-1).sort((a,b)=>a-b).forEach((v, idx) => slots[idx] = v);

    // Clamp y monotonicidad con gap
    slots[0] = Math.max(slots[0], startMin);
    for (let i = 1; i < n - 1; i++){
      slots[i] = Math.max(slots[i], slots[i-1] + minGap);
    }

    // Asegurar que el penúltimo no choque con el último
    slots[n-2] = Math.min(slots[n-2], lastStartMin - minGap);

    // Re-corregir gaps si quedó apretado
    for (let i = n - 3; i >= 0; i--){
      slots[i] = Math.min(slots[i], slots[i+1] - minGap);
    }

    // Y el último fijo
    slots[n - 1] = lastStartMin;

    return slots;
  }

  // ======================
  //        Eventos
  // ======================

  function schedule(ev){ evq.push(ev); }

  function handleEvent(ev){
    switch (ev.type) {
      case "ARRIVAL": onArrival(ev); break;
      case "END_VALID": onEndValid(ev.id); break;
      case "END_CAMB": onEndCamb(ev.id); break;
      case "END_SCAN": onEndScan(ev.id); break;
      case "END_EXIT": onEndExit(ev.id); break;
      case "PATIENCE_EXPIRE": onPatienceExpire(ev.id); break;
      default: break;
    }
  }

  function onArrival(ev){
    // Si ya cerramos o ya no hay mundo, igual lo ignoramos
    if (t >= cfg.closeMin) return;

    const study = pickStudy(rng);
    const e = createEntity(study);

    e.apptAt = ev.apptAt;
    e.arrivalOffset = ev.offset;
    e.arrivalAt = t;

    entities.set(e.id, e);

    // Entrar a WAIT (sala)
    enterState(e, "WAIT");
    qWait.push(e.id);

    // Si la sala ya estaba llena (>=10) al momento de llegar,
    // se programa paciencia de 60 min (abandono si no avanza).
    const waitersNow = countState("WAIT");
    stats.maxWaiters = Math.max(stats.maxWaiters, waitersNow);

    if (waitersNow >= cfg.waitCap) {
      e.patienceDeadline = t + cfg.patienceMin;
      schedule({ t: e.patienceDeadline, type:"PATIENCE_EXPIRE", id: e.id });
    } else {
      e.patienceDeadline = null;
    }

    // Intentar arrancar validación si está libre
    tryStartValidation();
  }

  function tryStartValidation(){
    if (validBusy) return;

    // Buscar el primer paciente en WAIT que aún no haya validado
    // (mantenemos una cola FIFO qWait)
    while (qWait.length) {
      const id = qWait.shift();
      const e = entities.get(id);
      if (!e) continue;
      if (e.state !== "WAIT") continue;
      if (e.hasValidated) continue; // ya validó, este WAIT es por resonador

      validBusy = true;
      enterState(e, "VALID");

      const dur = sampleProcess(cfg.validMu, cfg.validSigma);
      schedule({ t: t + dur, type:"END_VALID", id });
      return;
    }
  }

  function onEndValid(id){
    validBusy = false;

    const e = entities.get(id);
    if (!e) { tryStartValidation(); return; }
    if (e.state !== "VALID") { tryStartValidation(); return; }

    e.hasValidated = true;

    // vuelve a WAIT pero ahora en cola “espera resonador”
    enterState(e, "WAIT");
    qWaitingForReso.push(id);

    // actualizar pico de waiters
    stats.maxWaiters = Math.max(stats.maxWaiters, countState("WAIT"));

    // seguir con validación del siguiente
    tryStartValidation();

    // e intentar meter al resonador
    tryStartResonator();
  }

  function tryStartResonator(){
    if (resonatorBusy) return;

    // Regla de corte: no iniciar después de 19:51
    if (t > cfg.lastResoStartMin) {
      resonatorLockedOut = true;
      return;
    }
    if (resonatorLockedOut) return;

    // Tomar FIFO post-validación
    while (qWaitingForReso.length) {
      const id = qWaitingForReso.shift();
      const e = entities.get(id);
      if (!e) continue;
      if (e.state !== "WAIT") continue;
      if (!e.hasValidated) continue;

      // Arranque real de resonador (marca)
      stats.lastResoStartActual = t;

      // Cambiador (resonador ocupado a partir de aquí)
      resonatorBusy = true;
      enterState(e, "CAMB");

      const durC = sampleProcess(cfg.cambMu, cfg.cambSigma);
      schedule({ t: t + durC, type:"END_CAMB", id });
      return;
    }
  }

  function onEndCamb(id){
    const e = entities.get(id);
    if (!e) { resonatorBusy = false; tryStartResonator(); return; }
    if (e.state !== "CAMB") { resonatorBusy = false; tryStartResonator(); return; }

    // Scan (resonador sigue ocupado)
    enterState(e, "SCAN");

    const durS = sampleProcess(e.study.mu, e.study.sigma);
    schedule({ t: t + durS, type:"END_SCAN", id });
  }

  function onEndScan(id){
    const e = entities.get(id);
    if (!e) { resonatorBusy = false; tryStartResonator(); return; }
    if (e.state !== "SCAN") { resonatorBusy = false; tryStartResonator(); return; }

    // Resonador se libera al finalizar el scan
    resonatorBusy = false;

    // salida (no bloquea)
    enterState(e, "OUT");
    const durE = sampleProcess(cfg.exitMu, cfg.exitSigma);
    schedule({ t: t + durE, type:"END_EXIT", id });

    // intentar meter otro, respetando corte
    tryStartResonator();
  }

  function onEndExit(id){
    const e = entities.get(id);
    if (!e) return;
    if (e.state !== "OUT") return;

    closeSegment(e);

    entities.delete(id);
    completed.push({ ...e, doneAt:t });
  }

  function onPatienceExpire(id){
    const e = entities.get(id);
    if (!e) return;

    // Abandona SOLO si sigue en WAIT
    if (e.state === "WAIT") {
      // Se pierde (se fue a otro centro)
      closeSegment(e);
      entities.delete(id);
      lost.byWait++;

      // Limpiar de colas si estaba
      removeFromQueue(qWait, id);
      removeFromQueue(qWaitingForReso, id);
    }
  }

  // ======================
  //        Helpers
  // ======================

  function createEntity(study){
    const id = `P${idSeq++}`;
    return {
      id,
      study,
      apptAt: null,
      arrivalAt: null,
      arrivalOffset: null,

      hasValidated: false,
      patienceDeadline: null,

      state: "NEW",
      timeline: [],
      pos: { x: waypoints[0].x, z: waypoints[0].z },
      targetWp: "WAIT"
    };
  }

  function enterState(e, newState){
    closeSegment(e);

    e.state = newState;
    e.timeline.push({ stage:newState, start:t, end:null });

    // waypoint
    e.targetWp = newState;

    // actualizar pico de waiters cuando corresponda
    if (newState === "WAIT") {
      stats.maxWaiters = Math.max(stats.maxWaiters, countState("WAIT"));
    }
  }

  function closeSegment(e){
    const last = e.timeline[e.timeline.length - 1];
    if (last && last.end == null) last.end = t;
  }

  function sampleProcess(mu, sigma){
    const v = normal(rng, mu, sigma);
    return Math.max(cfg.minProcessMin, v);
  }

  function countState(state){
    let c = 0;
    for (const e of entities.values()){
      if (e.state === state) c++;
    }
    return c;
  }

  function removeFromQueue(q, id){
    const i = q.indexOf(id);
    if (i >= 0) q.splice(i, 1);
  }

  function flushCloseLoss(){
    // al cierre, todo lo no completado se pierde
    if (!entities.size) return;

    for (const e of entities.values()){
      closeSegment(e);
      lost.byClose++;
    }

    entities.clear();
    qWait.length = 0;
    qWaitingForReso.length = 0;
    validBusy = false;
    resonatorBusy = false;
    resonatorLockedOut = true;
  }
}
