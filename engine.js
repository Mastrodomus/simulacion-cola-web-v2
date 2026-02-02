// engine.js
export function makeRng(seed = 42) {
  // LCG simple (determinista)
  let s = (seed >>> 0) || 1;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export function clamp(v, a, b){ return Math.max(a, Math.min(b, v)); }

export function makeEngine(opts = {}) {
  const rng = makeRng(opts.seed ?? 42);

  // Unidades: minutos (para el timeline)
  const cfg = {
    // llegada base: 1 cada 8 min + jitter
    arrivalEveryMin: 8,
    arrivalJitterMin: 2,

    tMesaMin: 6,
    tCambMin: 4,
    tScanMin: 18,

    ...opts
  };

  // Waypoints (coordenadas XZ en "metros" virtuales)
  // Orden coincide con el flujo
  const waypoints = [
    { id:"WAIT", name:"Sala de espera", x:-6, z:  0 },
    { id:"MESA", name:"Mesa",           x:-2, z:  0 },
    { id:"CAMB", name:"Cambiador",      x: 2, z:  0 },
    { id:"SCAN", name:"Resonador",      x: 6, z:  0 },
    { id:"OUT",  name:"Salida",         x:10, z:  0 }
  ];

  const stages = [
    { id:"WAIT", dur: () => 0 }, // espera depende de cola, la manejamos aparte
    { id:"MESA", dur: () => cfg.tMesaMin },
    { id:"CAMB", dur: () => cfg.tCambMin },
    { id:"SCAN", dur: () => cfg.tScanMin },
    { id:"OUT",  dur: () => 0 }
  ];

  let t = 0;                 // tiempo sim (min)
  let nextArrival = 0;       // min
  let idSeq = 1;

  // Recursos: 1 resonador, 1 mesa, 1 cambiador (simple)
  const busy = { MESA:false, CAMB:false, SCAN:false };

  const entities = new Map(); // id -> entity
  const completed = [];

  function sampleArrivalDelta(){
    const jitter = (rng() * 2 - 1) * cfg.arrivalJitterMin;
    return Math.max(1, cfg.arrivalEveryMin + jitter);
  }

  function spawn(){
    const id = `P${idSeq++}`;
    const e = {
      id,
      createdAt: t,
      state: "WAIT",
      stateEnterAt: t,
      // para timeline: lista de segmentos {stage, start, end}
      timeline: [{ stage:"WAIT", start:t, end:null }],
      // para 3D: movimiento hacia waypoint target
      pos: { x: waypoints[0].x, z: waypoints[0].z },
      targetWp: "WAIT"
    };
    entities.set(id, e);
  }

  function setState(e, newState){
    // cerrar segmento anterior
    const last = e.timeline[e.timeline.length - 1];
    if (last && last.end == null) last.end = t;

    e.state = newState;
    e.stateEnterAt = t;
    e.timeline.push({ stage:newState, start:t, end:null });
    e.targetWp = newState;

    // liberar recursos si corresponde
    // (se libera al salir del stage)
  }

  function tryAdvance(e){
    // Flujo: WAIT -> MESA -> CAMB -> SCAN -> OUT (done)
    if (e.state === "WAIT") {
      // entra a mesa si está libre
      if (!busy.MESA) { busy.MESA = true; setState(e, "MESA"); }
      return;
    }

    if (e.state === "MESA") {
      const dur = cfg.tMesaMin;
      if (t - e.stateEnterAt >= dur) {
        busy.MESA = false;
        if (!busy.CAMB) { busy.CAMB = true; setState(e, "CAMB"); }
        else { setState(e, "WAIT"); } // vuelve a esperar (simple)
      }
      return;
    }

    if (e.state === "CAMB") {
      const dur = cfg.tCambMin;
      if (t - e.stateEnterAt >= dur) {
        busy.CAMB = false;
        if (!busy.SCAN) { busy.SCAN = true; setState(e, "SCAN"); }
        else { setState(e, "WAIT"); }
      }
      return;
    }

    if (e.state === "SCAN") {
      const dur = cfg.tScanMin;
      if (t - e.stateEnterAt >= dur) {
        busy.SCAN = false;
        setState(e, "OUT");
      }
      return;
    }

    if (e.state === "OUT") {
      // finalizar
      const last = e.timeline[e.timeline.length - 1];
      if (last && last.end == null) last.end = t;
      entities.delete(e.id);
      completed.push({ ...e, doneAt:t });
    }
  }

  function step(dtMin){
    // arrivals
    if (t >= nextArrival) {
      spawn();
      nextArrival = t + sampleArrivalDelta();
    }

    // avanzar entidades
    for (const e of entities.values()) {
      tryAdvance(e);
    }

    // avanzar tiempo
    t += dtMin;
  }

  function getSnapshot(){
    return {
      t,
      cfg: { ...cfg },
      waypoints: waypoints.map(w => ({...w})),
      entities: Array.from(entities.values()).map(e => ({
        id: e.id,
        state: e.state,
        createdAt: e.createdAt,
        timeline: e.timeline.map(s => ({...s})),
        pos: { ...e.pos },
        targetWp: e.targetWp
      })),
      completedCount: completed.length
    };
  }

  return { step, getSnapshot, reset, setSeed, setConfig };

  function reset(newSeed = cfg.seed ?? 42){
    // reset completo
    t = 0;
    nextArrival = 0;
    idSeq = 1;
    busy.MESA = busy.CAMB = busy.SCAN = false;
    entities.clear();
    completed.length = 0;
    setSeed(newSeed);
  }

  function setSeed(seed){
    cfg.seed = seed;
    // recrear rng con seed nuevo
    const newRng = makeRng(seed);
    // hack simple: reemplazar closure rng (no elegante, pero efectivo para starter)
    // eslint-disable-next-line no-func-assign
    rng = newRng;
  }

  function setConfig(patch){
    Object.assign(cfg, patch);
  }
}
