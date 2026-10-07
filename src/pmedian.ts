"use strict";

/**
 * TERRITORIOS COMO P-MEDIANA CON CAPACIDAD (el metodo de Open Door Logistics).
 *
 * Open Door (com.opendoorlogistics ... cluster/capacitated/solver) implementa una version
 * modificada del algoritmo MB1 de Mulvey y Beck (1984):
 *   - UN SOLO coste, lexicografico: (1) exceso sobre la capacidad, (2) viaje total de los
 *     clientes a su centro. Sin minimos, sin banda, sin reglas de islas ni de pueblos.
 *   - Los centros son clientes (medoides).
 *   - Asignacion por REGRET: primero el cliente que mas perderia si no le tocara su mejor
 *     zona; nunca se rompe la capacidad si hay alternativa.
 *   - Recentrar y reasignar hasta que los centros no cambian; despues busqueda local
 *     (movimientos e intercambios) entre cada zona y sus 5 zonas mas cercanas.
 *   - Busqueda local ITERADA: se cambian algunos centros de la mejor solucion y se repite.
 *
 * Por que sustituye a las fases anteriores (crecimiento, reclamo, cadenas, fusion, pueblos,
 * campo): cada una optimizaba una cosa distinta y la siguiente la deshacia; aqui todas las
 * fases optimizan LO MISMO, y eso es lo que evita que las zonas se mezclen.
 *
 * Adaptaciones nuestras: la carga de un cliente incluye su viaje (en ruta, routeFactor) al
 * centro de SU zona; el tope es duro y no hay minimo (una zona corta se queda corta); y el
 * numero de comerciales es el MINIMO con el que todo cabe bajo el tope.
 */

import { ClusterPoint, ZoningOptions, ZoningResult } from "./clustering";

const R = 6371;

function mulberry(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Rejilla sobre un conjunto de puntos (centros): los V mas cercanos a (px, py). */
class Grid {
    private cell: number; private minX: number; private minY: number; private cols: number; private rows: number;
    private start: Int32Array; private order: Int32Array;
    constructor(private xs: Float64Array, private ys: Float64Array, private ids: Int32Array, areaKm2: number) {
        const m = ids.length;
        this.cell = Math.max(0.2, Math.sqrt(areaKm2 / Math.max(m, 1)));
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let q = 0; q < m; q++) { const i = ids[q]; if (xs[i] < minX) minX = xs[i]; if (xs[i] > maxX) maxX = xs[i]; if (ys[i] < minY) minY = ys[i]; if (ys[i] > maxY) maxY = ys[i]; }
        if (m === 0) { minX = minY = 0; maxX = maxY = 1; }
        this.minX = minX; this.minY = minY;
        this.cols = Math.max(1, Math.floor((maxX - minX) / this.cell) + 1);
        this.rows = Math.max(1, Math.floor((maxY - minY) / this.cell) + 1);
        const counts = new Int32Array(this.cols * this.rows);
        const b = new Int32Array(m);
        for (let q = 0; q < m; q++) { b[q] = this.bucket(xs[ids[q]], ys[ids[q]]); counts[b[q]]++; }
        this.start = new Int32Array(this.cols * this.rows + 1);
        for (let k = 0; k < counts.length; k++) this.start[k + 1] = this.start[k] + counts[k];
        this.order = new Int32Array(m);
        const fill = this.start.slice(0, counts.length);
        for (let q = 0; q < m; q++) this.order[fill[b[q]]++] = q;   // posicion q en ids
    }
    private bucket(x: number, y: number): number {
        const a = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
        const c = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)));
        return c * this.cols + a;
    }
    /** Devuelve cuantos encontro; outQ = posiciones en ids, outD = d2, ordenados. */
    nearest(px: number, py: number, V: number, outQ: Int32Array, outD: Float64Array): number {
        const i0 = Math.min(this.cols - 1, Math.max(0, Math.floor((px - this.minX) / this.cell)));
        const j0 = Math.min(this.rows - 1, Math.max(0, Math.floor((py - this.minY) / this.cell)));
        let found = 0;
        const maxRing = Math.max(this.cols, this.rows);
        for (let ring = 0; ring <= maxRing; ring++) {
            for (let j = j0 - ring; j <= j0 + ring; j++) {
                if (j < 0 || j >= this.rows) continue;
                for (let a = i0 - ring; a <= i0 + ring; a++) {
                    if (a < 0 || a >= this.cols) continue;
                    if (ring > 0 && Math.abs(a - i0) !== ring && Math.abs(j - j0) !== ring) continue;
                    const bk = j * this.cols + a;
                    for (let s = this.start[bk]; s < this.start[bk + 1]; s++) {
                        const q = this.order[s], i = this.ids[q];
                        const dx = this.xs[i] - px, dy = this.ys[i] - py, d = dx * dx + dy * dy;
                        if (found < V) { let p = found++; while (p > 0 && outD[p - 1] > d) { outD[p] = outD[p - 1]; outQ[p] = outQ[p - 1]; p--; } outD[p] = d; outQ[p] = q; }
                        else if (d < outD[V - 1]) { let p = V - 1; while (p > 0 && outD[p - 1] > d) { outD[p] = outD[p - 1]; outQ[p] = outQ[p - 1]; p--; } outD[p] = d; outQ[p] = q; }
                    }
                }
            }
            if (found >= V && outD[V - 1] <= (ring * this.cell) * (ring * this.cell)) break;
        }
        return found;
    }
}

export interface PMedianOptions extends ZoningOptions {
    /** Tiempo maximo de la busqueda iterada, en ms (por defecto 6000). */
    timeLimitMs?: number;
    /**
     * Reparto de partida (zona de cada punto, -1 = fuera). Si se da, no se busca k ni se usa
     * el regret: se toman esos grupos, se recentran en su medoide y se mejoran con la busqueda
     * local (movimientos e intercambios con las 5 zonas vecinas) hasta que nada mejora.
     */
    initialAssign?: Int32Array;
    /**
     * Modo FIEL a Open Door: la capacidad cuenta solo la carga de visita (cantidad fija del
     * cliente, sin viaje), el coste de viaje es la distancia al centro, y k es fijo (fixedK).
     */
    odlFaithful?: boolean;
    fixedK?: number;
}

/**
 * Reparte los puntos en territorios (p-mediana con capacidad). Escribe clusterId y load en
 * cada punto. unresolved = movimientos/intercambios entre zonas vecinas que aun bajarian el
 * coste (0 = optimo local verificado con el mismo criterio que se optimiza).
 */
export function pmedianTerritories(points: ClusterPoint[], opt: PMedianOptions): ZoningResult {
    const n = points.length;
    const empty: ZoningResult = { k: 0, centers: [], zoneHours: new Float64Array(0), withinTolerance: 0, travelShare: 0, outOfBand: 0, unresolved: 0, unassigned: 0 };
    if (n === 0) return empty;
    const t0 = Date.now();
    const timeLimit = opt.timeLimitMs ?? 6000;
    const rnd = mulberry((opt.seed ?? 20260930) ^ n);
    const capMin = opt.capacityHours * 60, tol = opt.tolerance;
    const hi = capMin * (1 + tol), lo = capMin * (1 - tol);
    const rf = opt.routeFactor != null && opt.routeFactor > 0 ? opt.routeFactor : 0.5;

    // --- proyeccion y datos por cliente --------------------------------------------------
    let latM = 0; for (const p of points) latM += p.lat; latM /= n;
    const kx = (Math.PI / 180) * R * Math.cos(latM * Math.PI / 180), ky = (Math.PI / 180) * R;
    const x = new Float64Array(n), y = new Float64Array(n), vis = new Float64Array(n), mins = new Float64Array(n), tpk = new Float64Array(n);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
        const p = points[i];
        x[i] = p.lon * kx; y[i] = p.lat * ky;
        if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i]; if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i];
        const v = p.visits != null && p.visits > 0 ? p.visits : 1;
        vis[i] = v; mins[i] = p.minutes != null && p.minutes > 0 ? p.minutes : (p.value * 60) / v;
        const s = p.speedKmh != null && p.speedKmh > 0 ? p.speedKmh : opt.speedKmh;
        tpk[i] = (2 * rf * opt.detour / s) * 60;           // minutos por km, por visita
    }
    const area = Math.max(1, (maxX - minX) * (maxY - minY));
    const dist = (i: number, j: number): number => Math.hypot(x[i] - x[j], y[i] - y[j]);
    // coste de viaje de i si su centro es el cliente m, y su carga total (visita + viaje)
    const faithful = !!opt.odlFaithful;
    const trav = (i: number, m: number): number => faithful ? dist(i, m) : vis[i] * dist(i, m) * tpk[i];
    const loadAt = (i: number, m: number): number => faithful ? vis[i] * mins[i] : vis[i] * mins[i] + trav(i, m);
    const over = (v: number): number => v > hi ? v - hi : 0;

    // --- estado ------------------------------------------------------------------------
    let centres: Int32Array = new Int32Array(0);      // cliente que hace de centro, por zona
    const asig = new Int32Array(n).fill(-1);
    let tot = new Float64Array(0);
    const V = 25;
    const cq = new Int32Array(V), cd = new Float64Array(V);

    // --- asignacion por REGRET con centros fijos -----------------------------------------
    const regretAssign = (): void => {
        const k = centres.length;
        tot = new Float64Array(k);
        asig.fill(-1);
        const isCentre = new Int32Array(n).fill(-1);
        for (let c = 0; c < k; c++) { isCentre[centres[c]] = c; asig[centres[c]] = c; tot[c] += vis[centres[c]] * mins[centres[c]]; }
        const grid = new Grid(x, y, centres, area);
        // candidatos por cliente
        const cand = new Int32Array(n * V).fill(-1), candN = new Int32Array(n);
        for (let i = 0; i < n; i++) {
            if (isCentre[i] >= 0) continue;
            const m = grid.nearest(x[i], y[i], V, cq, cd);
            candN[i] = m;
            for (let s = 0; s < m; s++) cand[i * V + s] = cq[s];
        }
        // mejor y segunda factibles; regret = diferencia de viaje
        const bestTwo = (i: number): { b1: number; c1: number; c2: number } => {
            let b1 = -1, c1 = Infinity, c2 = Infinity;
            for (let s = 0; s < candN[i]; s++) {
                const c = cand[i * V + s];
                if (tot[c] + loadAt(i, centres[c]) > hi) continue;
                const t = trav(i, centres[c]);
                if (t < c1) { c2 = c1; c1 = t; b1 = c; } else if (t < c2) c2 = t;
            }
            return { b1, c1, c2 };
        };
        // monticulo maximo por regret (perezoso: se recalcula al sacar)
        const heapI: number[] = [], heapR: number[] = [];
        const push = (i: number, r: number): void => {
            let p = heapI.length; heapI.push(i); heapR.push(r);
            while (p > 0) { const q = (p - 1) >> 1; if (heapR[q] > heapR[p] || (heapR[q] === heapR[p] && heapI[q] < heapI[p])) break; [heapI[p], heapI[q]] = [heapI[q], heapI[p]]; [heapR[p], heapR[q]] = [heapR[q], heapR[p]]; p = q; }
        };
        const pop = (): { i: number; r: number } => {
            const top = { i: heapI[0], r: heapR[0] };
            const li = heapI.pop()!, lr = heapR.pop()!;
            if (heapI.length) {
                heapI[0] = li; heapR[0] = lr; let p = 0;
                for (;;) {
                    const a = 2 * p + 1, b = a + 1; let m = p;
                    if (a < heapI.length && (heapR[a] > heapR[m] || (heapR[a] === heapR[m] && heapI[a] < heapI[m]))) m = a;
                    if (b < heapI.length && (heapR[b] > heapR[m] || (heapR[b] === heapR[m] && heapI[b] < heapI[m]))) m = b;
                    if (m === p) break;
                    [heapI[p], heapI[m]] = [heapI[m], heapI[p]]; [heapR[p], heapR[m]] = [heapR[m], heapR[p]]; p = m;
                }
            }
            return top;
        };
        const regretOf = (bt: { b1: number; c1: number; c2: number }): number => bt.b1 < 0 ? Infinity : (isFinite(bt.c2) ? bt.c2 - bt.c1 : 1e12);
        for (let i = 0; i < n; i++) if (asig[i] < 0) push(i, regretOf(bestTwo(i)));
        while (heapI.length) {
            const { i, r } = pop();
            if (asig[i] >= 0) continue;
            const bt = bestTwo(i);
            const rNow = regretOf(bt);
            if (rNow < r - 1e-9 && heapI.length && rNow < heapR[0]) { push(i, rNow); continue; }   // perezoso
            let c = bt.b1;
            if (c < 0) {
                // ninguna candidata cabe: la que menos se pasa (queda como exceso en el coste)
                let bestOv = Infinity;
                for (let s = 0; s < candN[i]; s++) { const z = cand[i * V + s]; const ov = tot[z] + loadAt(i, centres[z]) - hi; if (ov < bestOv) { bestOv = ov; c = z; } }
                if (c < 0) c = 0;
            }
            asig[i] = c; tot[c] += loadAt(i, centres[c]);
        }
    };

    // --- recentrar: medoide = cliente de la zona con menor viaje al resto -----------------
    const members = (): number[][] => { const m: number[][] = Array.from({ length: centres.length }, () => []); for (let i = 0; i < n; i++) if (asig[i] >= 0) m[asig[i]].push(i); return m; };
    const recentre = (): boolean => {
        const mem = members();
        let changed = false;
        for (let c = 0; c < centres.length; c++) {
            const ms = mem[c]; if (ms.length === 0) continue;
            // candidatos a medoide: los 40 mas cercanos al centroide (zonas grandes)
            let sx = 0, sy = 0; for (const i of ms) { sx += x[i]; sy += y[i]; } sx /= ms.length; sy /= ms.length;
            const cands = ms.length <= 40 ? ms : ms.slice().sort((a, b) => ((x[a] - sx) ** 2 + (y[a] - sy) ** 2) - ((x[b] - sx) ** 2 + (y[b] - sy) ** 2)).slice(0, 40);
            let best = centres[c], bestT = Infinity;
            for (const m of cands) {
                let t = 0; for (const i of ms) { t += trav(i, m); if (t >= bestT) break; }
                if (t < bestT - 1e-9 || (Math.abs(t - bestT) <= 1e-9 && m < best)) { bestT = t; best = m; }
            }
            if (best !== centres[c]) { centres[c] = best; changed = true; }
        }
        // recalcular cargas con los centros nuevos
        tot = new Float64Array(centres.length);
        for (let i = 0; i < n; i++) if (asig[i] >= 0) tot[asig[i]] += loadAt(i, centres[asig[i]]);
        return changed;
    };

    // --- coste lexicografico -------------------------------------------------------------
    const costOf = (): { ov: number; tr: number } => {
        let ov = 0, tr = 0;
        for (let c = 0; c < centres.length; c++) ov += over(tot[c]);
        for (let i = 0; i < n; i++) if (asig[i] >= 0) tr += trav(i, centres[asig[i]]);
        return { ov, tr };
    };
    const better = (a: { ov: number; tr: number }, b: { ov: number; tr: number }): boolean => a.ov < b.ov - 1e-6 || (Math.abs(a.ov - b.ov) <= 1e-6 && a.tr < b.tr - 1e-6);

    // --- busqueda local: movimientos e intercambios con las 5 zonas mas cercanas ----------
    const NEAR = 5;
    const nearClusters = (): Int32Array[] => {
        const k = centres.length;
        const g = new Grid(x, y, centres, area);
        const q = new Int32Array(NEAR + 1), d = new Float64Array(NEAR + 1);
        const out: Int32Array[] = [];
        for (let c = 0; c < k; c++) { const m = g.nearest(x[centres[c]], y[centres[c]], NEAR + 1, q, d); const arr: number[] = []; for (let s = 0; s < m; s++) if (q[s] !== c) arr.push(q[s]); out.push(Int32Array.from(arr.slice(0, NEAR))); }
        return out;
    };
    // mejora (dOv, dTr) de un movimiento; se acepta si baja el exceso, o no lo cambia y baja el viaje
    const accept = (dOv: number, dTr: number): boolean => dOv < -1e-6 || (Math.abs(dOv) <= 1e-6 && dTr < -1e-6);
    const localSearch = (countOnly = false): number => {
        const near = nearClusters();
        let improvements = 0;
        for (let pass = 0; pass < (countOnly ? 1 : 40); pass++) {
            const mem = members();
            let moved = 0;
            for (let a = 0; a < centres.length; a++) {
                for (const b of near[a]) {
                    const ca = centres[a], cb = centres[b];
                    // movimientos a -> b
                    for (const i of mem[a]) {
                        if (i === ca || asig[i] !== a) continue;
                        const la = loadAt(i, ca), lb = loadAt(i, cb);
                        const dOv = over(tot[a] - la) + over(tot[b] + lb) - over(tot[a]) - over(tot[b]);
                        const dTr = trav(i, cb) - trav(i, ca);
                        if (accept(dOv, dTr)) {
                            if (countOnly) { improvements++; continue; }
                            asig[i] = b; tot[a] -= la; tot[b] += lb; mem[b].push(i); moved++;
                        }
                    }
                    // intercambios a <-> b
                    for (const i of mem[a]) {
                        if (i === ca || asig[i] !== a) continue;
                        const la_i = loadAt(i, ca), lb_i = loadAt(i, cb), ti_a = trav(i, ca), ti_b = trav(i, cb);
                        for (const j of mem[b]) {
                            if (j === cb || asig[j] !== b) continue;
                            const lb_j = loadAt(j, cb), la_j = loadAt(j, ca);
                            const nA = tot[a] - la_i + la_j, nB = tot[b] - lb_j + lb_i;
                            const dOv = over(nA) + over(nB) - over(tot[a]) - over(tot[b]);
                            const dTr = (ti_b + trav(j, ca)) - (ti_a + trav(j, cb));
                            if (accept(dOv, dTr)) {
                                if (countOnly) { improvements++; continue; }
                                asig[i] = b; asig[j] = a; tot[a] = nA; tot[b] = nB; mem[b].push(i); mem[a].push(j); moved++;
                                break;
                            }
                        }
                    }
                }
            }
            if (countOnly) break;
            improvements += moved;
            if (moved === 0) break;
        }
        return improvements;
    };

    // --- un ciclo completo desde unos centros ---------------------------------------------
    const cycle = (): void => {
        regretAssign();
        for (let it = 0; it < 8; it++) { if (!recentre()) break; regretAssign(); }
        for (let it = 0; it < 5; it++) { localSearch(); if (!recentre()) break; }
        localSearch();
    };

    // --- centros iniciales: k-means++ ponderado por carga de visita -----------------------
    const initCentres = (k: number): Int32Array => {
        const c = new Int32Array(k);
        const w = new Float64Array(n); let tw = 0;
        for (let i = 0; i < n; i++) { w[i] = vis[i] * mins[i] + 1e-9; tw += w[i]; }
        const pick = (ws: Float64Array, total: number): number => { let u = rnd() * total; for (let i = 0; i < n; i++) { u -= ws[i]; if (u <= 0) return i; } return n - 1; };
        c[0] = pick(w, tw);
        const d2 = new Float64Array(n); for (let i = 0; i < n; i++) d2[i] = (x[i] - x[c[0]]) ** 2 + (y[i] - y[c[0]]) ** 2;
        const pw = new Float64Array(n);
        for (let s = 1; s < k; s++) {
            let tp = 0; for (let i = 0; i < n; i++) { pw[i] = d2[i] * w[i]; tp += pw[i]; }
            c[s] = tp > 0 ? pick(pw, tp) : Math.floor(rnd() * n);
            for (let i = 0; i < n; i++) { const d = (x[i] - x[c[s]]) ** 2 + (y[i] - y[c[s]]) ** 2; if (d < d2[i]) d2[i] = d; }
        }
        return c;
    };

    if (opt.initialAssign) {
        // ARRANQUE DESDE UN REPARTO FACTIBLE: medoides de los grupos dados y busqueda local
        let kk = 0; for (let i = 0; i < n; i++) if (opt.initialAssign[i] + 1 > kk) kk = opt.initialAssign[i] + 1;
        const ren = new Int32Array(kk).fill(-1); let k2 = 0;
        for (let i = 0; i < n; i++) { const z = opt.initialAssign[i]; if (z >= 0 && ren[z] < 0) ren[z] = k2++; }
        for (let i = 0; i < n; i++) asig[i] = opt.initialAssign[i] >= 0 ? ren[opt.initialAssign[i]] : -1;
        const first = new Int32Array(k2).fill(-1); for (let i = 0; i < n; i++) if (asig[i] >= 0 && first[asig[i]] < 0) first[asig[i]] = i;
        centres = first;
        recentre();
        for (let it = 0; it < 12 && Date.now() - t0 < timeLimit; it++) {
            const imp = localSearch();
            const ch = recentre();
            if (imp === 0 && !ch) break;
        }
        // si el recentrado dejo alguna zona sobre el tope, la busqueda local ya lo paga primero;
        // la seguridad final (abajo) no cambia nada si no hace falta
    } else {
    // --- numero de comerciales: el MINIMO con el que todo cabe bajo el tope ---------------
    // Fase barata (solo regret + recentrar, sin busqueda local): se anaden centros en
    // proporcion al exceso total, en el cliente mas lejano de las zonas que mas se pasan,
    // hasta que todo cabe. La busqueda local con un reparto imposible tardaba 52 s en vano.
    const quick = (): void => { regretAssign(); for (let it = 0; it < 6; it++) { if (!recentre()) break; regretAssign(); } };
    let totalVisit = 0; for (let i = 0; i < n; i++) totalVisit += vis[i] * mins[i];
    let k = opt.fixedK && opt.fixedK > 0 ? Math.min(n, opt.fixedK) : Math.max(1, Math.min(n, Math.ceil(totalVisit * 1.1 / hi)));
    centres = initCentres(k);
    quick();
    for (let guard = 0; guard < (opt.fixedK ? 0 : 60) && costOf().ov > 1e-6 && centres.length < n; guard++) {
        const mem = members();
        const overZones = Array.from({ length: centres.length }, (_, c) => c).filter(c => tot[c] > hi).sort((a, b) => tot[b] - tot[a]);
        const nAdd = Math.max(1, Math.min(overZones.length, Math.ceil(costOf().ov / hi)));
        const add: number[] = [];
        for (const c of overZones.slice(0, nAdd)) {
            let far = -1, fd = -1; for (const i of mem[c]) { const d = dist(i, centres[c]); if (d > fd) { fd = d; far = i; } }
            if (far >= 0) add.push(far);
        }
        if (!add.length) break;
        const nc = new Int32Array(centres.length + add.length); nc.set(centres); nc.set(add, centres.length); centres = nc;
        quick();
    }
    // quitar comerciales mientras todo siga cabiendo (la zona con menos carga), solo con la fase barata
    for (let guard = 0; guard < (opt.fixedK ? 0 : 200) && centres.length > 1 && Date.now() - t0 < timeLimit * 0.5; guard++) {
        const saveC = centres.slice(), saveA = asig.slice(), saveT = tot.slice();
        let low = 0; for (let c = 1; c < centres.length; c++) if (tot[c] < tot[low]) low = c;
        centres = Int32Array.from(Array.from(centres).filter((_, c) => c !== low));
        quick();
        if (costOf().ov > 1e-6) { centres = saveC; asig.set(saveA); tot = saveT; break; }
    }
    cycle();

    // --- busqueda local ITERADA: mutar ~10% de los centros y quedarse con la mejor --------
    let best = { c: centres.slice(), a: asig.slice(), t: tot.slice(), cost: costOf() };
    while (Date.now() - t0 < timeLimit) {
        centres = best.c.slice();
        const nm = Math.max(1, Math.floor(centres.length * 0.1));
        const used = new Set<number>(Array.from(centres));
        for (let q = 0; q < nm; q++) {
            const c = Math.floor(rnd() * centres.length);
            let cand = Math.floor(rnd() * n), tries = 0; while (used.has(cand) && tries++ < 20) cand = Math.floor(rnd() * n);
            used.delete(centres[c]); centres[c] = cand; used.add(cand);
        }
        cycle();
        const cost = costOf();
        if (better(cost, best.cost)) best = { c: centres.slice(), a: asig.slice(), t: tot.slice(), cost };
    }
    centres = best.c; asig.set(best.a); tot = best.t;
    }
    const unresolved = localSearch(true);

    // --- resultado ---------------------------------------------------------------------
    const k2 = centres.length;
    const zoneMin = new Float64Array(k2);
    let travel = 0, totalAll = 0;
    for (let i = 0; i < n; i++) {
        const c = asig[i]; points[i].clusterId = c;
        if (c < 0) { points[i].load = vis[i] * mins[i]; continue; }
        const l = loadAt(i, centres[c]); points[i].load = l;
        zoneMin[c] += l; totalAll += l; travel += trav(i, centres[c]);
    }
    const zoneHours = new Float64Array(k2);
    let within = 0;
    for (let c = 0; c < k2; c++) { zoneHours[c] = zoneMin[c] / 60; if (zoneMin[c] >= lo && zoneMin[c] <= hi) within++; }
    const centers = Array.from(centres).map(m => ({ lat: points[m].lat, lon: points[m].lon }));
    return { k: k2, centers, zoneHours, withinTolerance: k2 ? within / k2 : 0, travelShare: totalAll > 0 ? travel / totalAll : 0, outOfBand: k2 - within, unresolved, unassigned: 0 };
}
