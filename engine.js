// engine.js (event-driven)
// Unidades: minutos. Reloj: minuto 0 = 00:00.
// Recomendación: simStartMin = 8:00 (480) para jornada típica.

export function makeRng(seed = 42) {
  // LCG simple determinista
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
    if (a.length === 0) return null;
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
  { id:"CEREBRO", label:"Cerebro",  p:0.30, mu:25, sigma:4 },
  { id:"COLUMNA", label:"Columna",  p:0.25, mu:30, sigma:5 },
  { id:"RODILLA", label:"Rodilla",  p:0.20, mu:20, sigma:3 },
  { id:"ABDOMEN", label:"Abdomen",  p:0.15, mu:28, sigma:4 },
  { id:"OTROS",   label:"Otros",    p:0.10, mu:22, sigma:3 },
];

function pickStudy(rng){
  const u = rng();
  let acc = 0;
  for (const s of STUDIES) {
    acc += s.p;
    if (u <= acc) return s;
  }
  return STUDIES[STUDIES.length - 1];
}

export function makeEngine(opts = {}) {
  let rng = makeRng(opts.seed ?? 42);

  const cfg = {
    seed: opts.seed ?? 42,

    // Jornada
    simStartMin: opts.simStartMin ?? (8*60),     // 08:00
    closeMin:    opts.closeMin    ?? (20*60),    // 20:00
    lastResoStartMin: opts.lastResoStartMin ?? (19*60 + 51), // 19:51 (hora reloj)

    // Llegadas (si no tenés agenda de turnos real, esto simula flujo)
    arrivalEveryMin: opts.arrivalEveryMin ?? 20,
    arrivalJitterMin: opts.arrivalJitterMin ?? 5,

    // Procesos auxiliares (Normal)
    validMu: 5, validSigma: 1,
    cambMu:  6, cambSigma:  1.5,
    exitMu:  4, exitSigma:  1,

    // Espera
    waitCap: 10,
    patienceMin: 60,

    // Corrida
    targetDone: 24,

    // clamps para evitar negativos
    minStepMin: 0.5,
  };

  // Waypoints (para 3D)
  const waypoints = [
    { id:"WAIT",  name:"Sala de espera", x:-6, z:0 },
    { id:"VALID", name:"Validación",     x:-4, z:0 },
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
    byPatience: 0,
    byClose: 0,
    byWaitCap: 0, // opcional si querés bloquear admisión estricta
  };

  // Colas / recursos
  const waitQueue = [];  // FIFO ids (solo los que están sentados esperando)
  const validQueue = []; // FIFO ids
  let validBusy = false;

  let resonatorBusy = false;
  let resonatorLockedOut = false; // cuando pasamos lastResoStart, ya no arranca nadie nuevo

  // ==== API pública ====
  function step(dtMin){
    const targetT = Math.min(t + dtMin, cfg.closeMin);

    // ejecutar eventos hasta targetT
    while (evq.size && evq.peek().t <= targetT) {
      const ev = evq.pop();
      t = ev.t;
      handleEvent(ev);
      if (isFinished()) break;
    }

    // avanzar tiempo “en vacío”
    t = targetT;

    // si llegamos al cierre, perder a todos los no atendidos
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
        study: e.study.label,
        createdAt: e.createdAt,
        timeline: e.timeline.map(s => ({...s})),
        pos: { ...e.pos },
        targetWp: e.targetWp,
      })),
      completedCount: completed.length,
      lost: { ...lost }
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
    lost.byPatience = 0;
    lost.byClose = 0;
    lost.byWaitCap = 0;
    waitQueue.length = 0;
    validQueue.length = 0;
    validBusy = false;
    resonatorBusy = false;
    resonatorLockedOut = false;

    // programar llegadas
    scheduleArrival(t);
  }

  function setConfig(patch){
    Object.assign(cfg, patch);
  }

  function setSeed(seed){
    reset(seed);
  }

  // ==== Inicialización ====
  reset(cfg.seed);

  return { step, getSnapshot, reset, setSeed, setConfig };

  // ======================
  //      Eventos
  // ======================

  function schedule(ev){
    evq.push(ev);
  }

  function scheduleArrival(now){
    const dt = sampleArrivalDelta();
    const at = now + dt;
    if (at <= cfg.closeMin) schedule({ t: at, type:"ARRIVAL" });
  }

  function sampleArrivalDelta(){
    const jitter = (rng() * 2 - 1) * cfg.arrivalJitterMin;
    return Math.max(1, cfg.arrivalEveryMin + jitter);
  }

  function handleEvent(ev){
    switch (ev.type) {
      case "ARRIVAL": onArrival(); break;
      case "END_VALID": onEndValid(ev.id); break;
      case "PATIENCE_EXPIRE": onPatienceExpire(ev.id); break;
      case "END_CHANGING": onEndChanging(ev.id); break;
      case "END_SCAN": onEndScan(ev.id); break;
      case "END_EXIT": onEndExit(ev.id); break;
      default: break;
    }
  }

  function onArrival(){
    if (isFinished()) return;

    // Generar paciente
    const study = pickStudy(rng);
    const e = createEntity(study);
    entities.set(e.id, e);

    // Sala de espera (10 sillas)
    // Interpretación: WAIT = sentado esperando turno (para validación o para resonador).
    if (countWaiters() >= cfg.waitCap) {
      // En tu operación normal "no debería pasar", pero si pasa:
      // el paciente NO se va instantáneo: se va a 60 min si no avanza.
      // Para no inventar “sillas invisibles”, lo dejamos en WAIT igual,
      // pero marcamos overflow en KPI opcional.
      // Si querés bloqueo estricto (no entra): descomentá las 3 líneas.
      // lost.byWaitCap++; entities.delete(e.id); return;

      // KPI de saturación (no es pérdida, es señal)
      // (si querés un KPI separado, lo agregamos luego)
    }

    enterState(e, "WAIT");

    // paciencia: 60 min
    schedule({ t: t + cfg.patienceMin, type:"PATIENCE_EXPIRE", id: e.id });

    // Entra a cola de validación cuando haya slot
    waitQueue.push(e.id);
    tryStartValidation();

    // Programar próxima llegada
    scheduleArrival(t);
  }

  function tryStartValidation(){
    if (validBusy) return;
    if (waitQueue.length === 0) return;

    const id = waitQueue.shift();
    const e = entities.get(id);
    if (!e) return;
    if (e.state !== "WAIT") return;

    validBusy = true;
    enterState(e, "VALID");

    const dur = sampleProcess(cfg.validMu, cfg.validSigma);
    schedule({ t: t + dur, type:"END_VALID", id });
  }

  function onEndValid(id){
    validBusy = false;
    const e = entities.get(id);
    if (!e) { tryStartValidation(); return; }
    if (e.state !== "VALID") { tryStartValidation(); return; }

    // Luego de validación, queda esperando resonador
    enterState(e, "WAIT");
    waitQueue.push(id);

    tryStartValidation(); // sigue la validación con el siguiente si hay

    tryStartResonator();
  }

  function tryStartResonator(){
    if (resonatorBusy) return;

    // regla: no iniciar después de 19:51
    if (t > cfg.lastResoStartMin) {
      resonatorLockedOut = true;
      // los que queden se perderán por cierre (o podemos marcarlos ya)
      return;
    }
    if (resonatorLockedOut) return;

    // tomar primer paciente WAIT (FIFO) que esté esperando por resonador
    // Nota: compartimos waitQueue entre “espera general” y “espera por resonador”.
    // El que está en VALID no está en waitQueue.
    while (waitQueue.length) {
      const id = waitQueue.shift();
      const e = entities.get(id);
      if (!e) continue;
      if (e.state !== "WAIT") continue;

      // ahora sí: “entra al cambiador” porque resonador libre
      resonatorBusy = true;
      enterState(e, "CAMB");

      const durC = sampleProcess(cfg.cambMu, cfg.cambSigma);
      schedule({ t: t + durC, type:"END_CHANGING", id });
      return;
    }
  }

  function onEndChanging(id){
    const e = entities.get(id);
    if (!e) { resonatorBusy = false; tryStartResonator(); return; }
    if (e.state !== "CAMB") { resonatorBusy = false; tryStartResonator(); return; }

    // iniciar scan (resonador sigue ocupado)
    enterState(e, "SCAN");

    const durS = sampleProcess(e.study.mu, e.study.sigma);
    schedule({ t: t + durS, type:"END_SCAN", id });
  }

  function onEndScan(id){
    const e = entities.get(id);
    if (!e) { resonatorBusy = false; tryStartResonator(); return; }
    if (e.state !== "SCAN") { resonatorBusy = false; tryStartResonator(); return; }

    // resonador se libera al terminar scan
    resonatorBusy = false;

    // salida (no bloquea resonador)
    enterState(e, "OUT");
    const durE = sampleProcess(cfg.exitMu, cfg.exitSigma);
    schedule({ t: t + durE, type:"END_EXIT", id });

    // intentar meter otro al resonador, respetando cutoff
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

    // solo se va si sigue en WAIT
    if (e.state === "WAIT") {
      // removerlo de waitQueue si está (O(n), pero N pequeño)
      removeFromQueue(waitQueue, id);

      closeSegment(e);
      entities.delete(id);
      lost.byPatience++;
    }
  }

  // ======================
  //     Helpers
  // ======================

  function createEntity(study){
    const id = `P${idSeq++}`;
    return {
      id,
      study,
      createdAt: t,
      state: "NEW",
      stateEnterAt: t,
      timeline: [],
      pos: { x: waypoints[0].x, z: waypoints[0].z },
      targetWp: "WAIT"
    };
  }

  function enterState(e, newState){
    // cerrar segmento anterior si está abierto
    closeSegment(e);

    e.state = newState;
    e.stateEnterAt = t;
    e.timeline.push({ stage:newState, start:t, end:null });

    // waypoint target
    e.targetWp = newState;
    // “VALID” tiene waypoint distinto
    if (newState === "VALID") e.targetWp = "VALID";
    if (newState === "WAIT")  e.targetWp = "WAIT";
    if (newState === "CAMB")  e.targetWp = "CAMB";
    if (newState === "SCAN")  e.targetWp = "SCAN";
    if (newState === "OUT")   e.targetWp = "OUT";
  }

  function closeSegment(e){
    const last = e.timeline[e.timeline.length - 1];
    if (last && last.end == null) last.end = t;
  }

  function sampleProcess(mu, sigma){
    const v = normal(rng, mu, sigma);
    return Math.max(cfg.minStepMin, v);
  }

  function removeFromQueue(q, id){
    const i = q.indexOf(id);
    if (i >= 0) q.splice(i, 1);
  }

  function countWaiters(){
    // contador “real” de pacientes en WAIT (sillas)
    let c = 0;
    for (const e of entities.values()) if (e.state === "WAIT") c++;
    return c;
  }

  function flushCloseLoss(){
    // Al cierre, todo lo no completado se pierde (se fue a otro local)
    if (entities.size === 0) return;

    // marcar pérdida por cierre para todos los activos
    for (const e of entities.values()) {
      closeSegment(e);
      lost.byClose++;
    }
    entities.clear();
    waitQueue.length = 0;
    validQueue.length = 0;
    validBusy = false;
    resonatorBusy = false;
    resonatorLockedOut = true;
  }

  function isFinished(){
    // si querés “corrida = 24 completados sí o sí”, esto lo dejamos.
    // Pero con regla de cierre, puede terminar antes si no llega.
    return completed.length >= cfg.targetDone;
  }
}
