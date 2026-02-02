// engine.js — Simulador Resonador (Agenda diaria, event-driven)
// Unidades: minutos del día. Ej: 08:00=480, 19:51=1191, 20:00=1200.
//
// Reglas:
// - 24 pacientes (agenda de 24 turnos). Último turno fijo 19:51.
// - Tipo de estudio discreto probabilístico.
// - Scan Normal por tipo; Valid/Camb/Salida Normal.
// - Resonador ocupado por CAMB + SCAN (CAMB solo cuando resonador libre).
// - No iniciar resonador después de 19:51.
// - Cierre 20:00: lo no completado se pierde (otro local).
// - Sala de espera 10 sillas.
//   - Paciencia 60 min SOLO si al llegar la sala estaba llena (>=10 WAIT).
//   - Si sigue en WAIT al vencer: se pierde (otro local).

export function makeRng(seed = 42) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

function normal(rng, mu, sigma) {
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

    // Agenda (24)
    slotCount: 24,
    minGapMin: 12,
    slotJitterMin: 8,

    // Llegada = turno + offset (Normal clamp)
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
    patienceMin: 60,

    minProcessMin: 0.5,
    targetDone: 24,
  };

  const waypoints = [
    { id:"WAIT",  name:"Sala de espera", x:-6, z:0 },
    { id:"VALID", name:"Validación",     x:-3.5, z:0 },
    { id:"CAMB",  name:"Cambiador",      x: 2, z:0 },
    { id:"SCAN",  name:"Resonador",      x: 6, z:0 },
    { id:"OUT",   name:"Salida",         x:10, z:0 },
  ];

  let t = cfg.simStartMin;
  let idSeq = 1;

  const evq = new MinHeap();
  const entities = new Map();     // activos
  const completed = [];           // finalizados OK
  const lostRows = [];            // perdidos (espera / cierre)

  const lost = { byClose: 0, byWait: 0 };

  const stats = {
    maxWaiters: 0,
    lastResoStartActual: null
  };

  let validBusy = false;
  let resonatorBusy = false;
  let resonatorLockedOut = false;

  const qWaitPreValid = [];     // FIFO de WAIT sin validar
  const qWaitForReso = [];      // FIFO de WAIT post-validación (espera resonador)

  function step(dtMin){
    const targetT = Math.min(t + dtMin, cfg.closeMin);

    while (evq.size && evq.peek().t <= targetT) {
      const ev = evq.pop();
      t = ev.t;
      handleEvent(ev);
      if (t >= cfg.closeMin) break;
    }

    t = targetT;

    if (t >= cfg.closeMin) flushCloseLoss();
  }

  function getSnapshot(){
    return {
      t,
      cfg: { ...cfg },
      waypoints: waypoints.map(w => ({...w})),
      active: Array.from(entities.values()).map(publicRowFromEntity),
      completed: completed.map(r => ({...r})),
      lostRows: lostRows.map(r => ({...r})),
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
    lostRows.length = 0;

    lost.byClose = 0;
    lost.byWait = 0;

    stats.maxWaiters = 0;
    stats.lastResoStartActual = null;

    validBusy = false;
    resonatorBusy = false;
    resonatorLockedOut = false;

    qWaitPreValid.length = 0;
    qWaitForReso.length = 0;

    programScheduleDay();
  }

  function setSeed(seed){ reset(seed); }

  function setConfig(patch){
    Object.assign(cfg, patch);
    reset(cfg.seed);
  }

  reset(cfg.seed);

  return { step, getSnapshot, reset, setSeed, setConfig };

  // ----------------------
  // Agenda (24 turnos)
  // ----------------------

  function programScheduleDay(){
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

      schedule({ t: arrivalAt, type:"ARRIVAL", apptAt, offset, seq: i+1 });
    }
  }

  function buildAppointmentSlots(startMin, lastStartMin, n, minGap, jitter){
    if (n < 2) return [lastStartMin];

    const slots = new Array(n);
    slots[n - 1] = lastStartMin;

    const endForOthers = lastStartMin - minGap;
    const span = Math.max(1, endForOthers - startMin);

    // base lineal + jitter
    const tmp = [];
    for (let i = 0; i < n - 1; i++){
      const frac = i / (n - 2);
      const edgeFactor = 0.35 + 0.65 * Math.sin(Math.PI * frac);
      const j = (rng()*2 - 1) * jitter * edgeFactor;
      tmp.push(startMin + frac * span + j);
    }
    tmp.sort((a,b)=>a-b);

    slots[0] = Math.max(tmp[0], startMin);
    for (let i = 1; i < n - 1; i++){
      slots[i] = Math.max(tmp[i], slots[i-1] + minGap);
    }

    slots[n-2] = Math.min(slots[n-2], lastStartMin - minGap);
    for (let i = n - 3; i >= 0; i--){
      slots[i] = Math.min(slots[i], slots[i+1] - minGap);
    }

    slots[n - 1] = lastStartMin;
    return slots;
  }

  // ----------------------
  // Eventos
  // ----------------------

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
    if (t >= cfg.closeMin) return;

    const study = pickStudy(rng);
    const e = createEntity(study);

    e.seq = ev.seq;
    e.apptAt = ev.apptAt;
    e.arrivalOffset = ev.offset;
    e.arrivalAt = t;

    entities.set(e.id, e);

    // entra a WAIT
    enterState(e, "WAIT");
    qWaitPreValid.push(e.id);

    // si al llegar ya hay 10+ en WAIT => activa paciencia
    const waitersNow = countState("WAIT");
    stats.maxWaiters = Math.max(stats.maxWaiters, waitersNow);

    if (waitersNow >= cfg.waitCap) {
      e.patienceDeadline = t + cfg.patienceMin;
      e.patienceActive = true;
      schedule({ t: e.patienceDeadline, type:"PATIENCE_EXPIRE", id: e.id });
    }

    tryStartValidation();
  }

  function tryStartValidation(){
    if (validBusy) return;

    while (qWaitPreValid.length) {
      const id = qWaitPreValid.shift();
      const e = entities.get(id);
      if (!e) continue;
      if (e.state !== "WAIT") continue;
      if (e.hasValidated) continue;

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

    // vuelve a WAIT (ahora espera resonador)
    enterState(e, "WAIT");
    qWaitForReso.push(id);
    stats.maxWaiters = Math.max(stats.maxWaiters, countState("WAIT"));

    tryStartValidation();
    tryStartResonator();
  }

  function tryStartResonator(){
    if (resonatorBusy) return;

    if (t > cfg.lastResoStartMin) {
      resonatorLockedOut = true;
      return;
    }
    if (resonatorLockedOut) return;

    while (qWaitForReso.length) {
      const id = qWaitForReso.shift();
      const e = entities.get(id);
      if (!e) continue;
      if (e.state !== "WAIT") continue;
      if (!e.hasValidated) continue;

      // marca último start
      stats.lastResoStartActual = t;

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

    enterState(e, "SCAN");

    const durS = sampleProcess(e.study.mu, e.study.sigma);
    schedule({ t: t + durS, type:"END_SCAN", id });
  }

  function onEndScan(id){
    const e = entities.get(id);
    if (!e) { resonatorBusy = false; tryStartResonator(); return; }
    if (e.state !== "SCAN") { resonatorBusy = false; tryStartResonator(); return; }

    resonatorBusy = false;

    enterState(e, "OUT");

    const durE = sampleProcess(cfg.exitMu, cfg.exitSigma);
    schedule({ t: t + durE, type:"END_EXIT", id });

    tryStartResonator();
  }

  function onEndExit(id){
    const e = entities.get(id);
    if (!e) return;
    if (e.state !== "OUT") return;

    closeSegment(e);

    // publicar row completa
    const row = publicRowFromEntity(e);
    row.status = "OK";
    row.endAt = t;

    entities.delete(id);
    completed.push(row);
  }

  function onPatienceExpire(id){
    const e = entities.get(id);
    if (!e) return;

    if (e.patienceActive && e.state === "WAIT") {
      closeSegment(e);

      const row = publicRowFromEntity(e);
      row.status = "PERDIDO_ESPERA";
      row.endAt = t;

      entities.delete(id);
      lost.byWait++;
      lostRows.push(row);

      removeFromQueue(qWaitPreValid, id);
      removeFromQueue(qWaitForReso, id);
    }
  }

  function flushCloseLoss(){
    if (!entities.size) return;

    // a las 20:00, lo no terminado se pierde (otro local)
    for (const e of entities.values()){
      closeSegment(e);

      const row = publicRowFromEntity(e);
      row.status = "PERDIDO_CIERRE";
      row.endAt = cfg.closeMin;

      lost.byClose++;
      lostRows.push(row);
    }

    entities.clear();
    qWaitPreValid.length = 0;
    qWaitForReso.length = 0;
    validBusy = false;
    resonatorBusy = false;
    resonatorLockedOut = true;
  }

  // ----------------------
  // Helpers / serialización
  // ----------------------

  function createEntity(study){
    const id = `P${idSeq++}`;
    return {
      id,
      seq: null,
      study,

      apptAt: null,
      arrivalAt: null,
      arrivalOffset: null,

      hasValidated: false,
      patienceActive: false,
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
    e.targetWp = newState;

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

  function publicRowFromEntity(e){
    return {
      id: e.id,
      seq: e.seq,
      study: e.study.key,
      apptAt: e.apptAt,
      arrivalAt: e.arrivalAt,
      arrivalOffset: e.arrivalOffset,
      timeline: e.timeline.map(s => ({...s})),
      status: "ACTIVO",
      endAt: null,
      targetWp: e.targetWp,
      pos: { ...e.pos }
    };
  }
}
