"use strict";

/**
 * CONTIGUIDAD EXPLICITA (decision del usuario, 30-09-2026).
 *
 * Por que: ningun metodo de "cada cliente a un centro con capacidad" garantiza fronteras
 * limpias. Medido con el solver REAL de Open Door sobre 30.000 puntos: 20,6% de clientes con
 * la mayoria de sus vecinos en otra zona; nuestro reparto, 6,8%. El resto solo se elimina con
 * una regla: cada territorio es UNA SOLA PIEZA en el mapa.
 *
 * Vecindad: triangulacion de Delaunay de los clientes (dos clientes son vecinos si comparten
 * una arista). No cruza fronteras, a diferencia del grafo de k vecinos mas cercanos.
 *
 * 1) REPARAR: cada trozo suelto de un territorio (componente que no es la principal) pasa
 *    ENTERO al territorio vecino con el que mas aristas comparte y que tenga hueco bajo el
 *    tope. Si ninguno tiene hueco, el trozo se convierte en territorio propio.
 * 2) ALISAR: un cliente de frontera pasa a un territorio vecino solo si ACORTA la frontera
 *    (menos aristas entre territorios distintos), cabe bajo el tope y su territorio de origen
 *    sigue siendo una sola pieza. Hasta que ningun movimiento mejora.
 * 3) TOPE: si al recalcular los viajes alguna zona se pasa, cede clientes de frontera a
 *    vecinas con hueco sin partirse.
 * Verificacion: piezas por territorio (1), aristas de frontera, movimientos pendientes (0).
 */

import Delaunator from "delaunator";
import type { ClusterPoint, ZoningOptions, ZoningResult } from "./clustering";

export interface ContiguityStats {
    /** Piezas de mas (suma de componentes - numero de territorios). Debe ser 0. */
    extraPieces: number;
    /** Aristas de Delaunay entre clientes de territorios distintos (longitud de frontera). */
    cutEdges: number;
    /** Movimientos de alisado que aun mejorarian. Debe ser 0. */
    pending: number;
    /** Trozos que no cabian en ninguna vecina y pasaron a ser territorio propio. */
    newZones: number;
}

export function enforceContiguity(points: ClusterPoint[], opt: ZoningOptions, capFactorOver = 1): { result: ZoningResult; stats: ContiguityStats } {
    const idx: number[] = [];
    for (let i = 0; i < points.length; i++) if (points[i].clusterId >= 0) idx.push(i);
    const n = idx.length;
    const empty: ZoningResult = { k: 0, centers: [], zoneHours: new Float64Array(0), withinTolerance: 0, travelShare: 0, outOfBand: 0, unresolved: 0, unassigned: 0 };
    if (n === 0) return { result: empty, stats: { extraPieces: 0, cutEdges: 0, pending: 0, newZones: 0 } };

    // --- datos -----------------------------------------------------------------------------
    const capMin = opt.capacityHours * 60, tol = opt.tolerance;
    const hi = capMin * (1 + tol) * capFactorOver, lo = capMin * (1 - tol);
    const rf = opt.routeFactor != null && opt.routeFactor > 0 ? opt.routeFactor : 0.5;
    let latM = 0; for (const i of idx) latM += points[i].lat; latM /= n;
    const kx = (Math.PI / 180) * 6371 * Math.cos(latM * Math.PI / 180), ky = (Math.PI / 180) * 6371;
    const x = new Float64Array(n), y = new Float64Array(n), vis = new Float64Array(n), mins = new Float64Array(n), tpk = new Float64Array(n);
    const z = new Int32Array(n);
    let k = 0;
    for (let q = 0; q < n; q++) {
        const p = points[idx[q]];
        x[q] = p.lon * kx; y[q] = p.lat * ky;
        const v = p.visits != null && p.visits > 0 ? p.visits : 1;
        vis[q] = v; mins[q] = p.minutes != null && p.minutes > 0 ? p.minutes : (p.value * 60) / v;
        const s = p.speedKmh != null && p.speedKmh > 0 ? p.speedKmh : opt.speedKmh;
        tpk[q] = (2 * rf * opt.detour / s) * 60;
        z[q] = p.clusterId; if (z[q] + 1 > k) k = z[q] + 1;
    }

    // --- grafo de Delaunay (CSR) --------------------------------------------------------------
    // puntos duplicados: Delaunator los omite; se enlazan con el primero de su posicion
    const coords = new Float64Array(2 * n);
    for (let q = 0; q < n; q++) { coords[2 * q] = x[q]; coords[2 * q + 1] = y[q]; }
    const adjSets: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
    if (n >= 3) {
        const d = new Delaunator(coords);
        const tr = d.triangles;
        for (let t = 0; t < tr.length; t += 3) {
            const a = tr[t], b = tr[t + 1], c = tr[t + 2];
            adjSets[a].add(b); adjSets[b].add(a); adjSets[b].add(c); adjSets[c].add(b); adjSets[a].add(c); adjSets[c].add(a);
        }
    } else if (n === 2) { adjSets[0].add(1); adjSets[1].add(0); }
    {
        const seen = new Map<string, number>();
        for (let q = 0; q < n; q++) {
            const key = x[q] + "," + y[q];
            const f = seen.get(key);
            if (f === undefined) seen.set(key, q); else { adjSets[q].add(f); adjSets[f].add(q); }
        }
    }
    const adjStart = new Int32Array(n + 1);
    for (let q = 0; q < n; q++) adjStart[q + 1] = adjStart[q] + adjSets[q].size;
    const adj = new Int32Array(adjStart[n]);
    for (let q = 0; q < n; q++) { let p = adjStart[q]; for (const w of adjSets[q]) adj[p++] = w; }

    // --- carga, centroides -------------------------------------------------------------------
    let cx = new Float64Array(k), cy = new Float64Array(k), tot = new Float64Array(k);
    const load = new Float64Array(n);
    const loadIn = (q: number, c: number): number => vis[q] * (mins[q] + Math.hypot(x[q] - cx[c], y[q] - cy[c]) * tpk[q]);
    const recentre = (): void => {
        const sx = new Float64Array(k), sy = new Float64Array(k), sw = new Float64Array(k);
        for (let q = 0; q < n; q++) { const c = z[q]; const w = vis[q] * mins[q] + 1e-9; sx[c] += x[q] * w; sy[c] += y[q] * w; sw[c] += w; }
        for (let c = 0; c < k; c++) if (sw[c] > 0) { cx[c] = sx[c] / sw[c]; cy[c] = sy[c] / sw[c]; }
        tot = new Float64Array(k);
        for (let q = 0; q < n; q++) { load[q] = loadIn(q, z[q]); tot[z[q]] += load[q]; }
    };
    const grow = (): void => {
        const nk = k + 1;
        const ncx = new Float64Array(nk), ncy = new Float64Array(nk), ntot = new Float64Array(nk);
        ncx.set(cx); ncy.set(cy); ntot.set(tot); cx = ncx; cy = ncy; tot = ntot; k = nk;
    };
    recentre();

    // --- miembros por zona --------------------------------------------------------------------
    const membersOf = (): number[][] => { const m: number[][] = Array.from({ length: k }, () => []); for (let q = 0; q < n; q++) m[z[q]].push(q); return m; };
    // componentes de la zona c (BFS dentro de la zona)
    const mark = new Int32Array(n).fill(-1);
    let stamp = 0;
    const components = (ms: number[], c: number): number[][] => {
        stamp++;
        const comps: number[][] = [];
        for (const s of ms) {
            if (mark[s] === stamp) continue;
            const comp: number[] = [s]; mark[s] = stamp;
            for (let h = 0; h < comp.length; h++) {
                const u = comp[h];
                for (let e = adjStart[u]; e < adjStart[u + 1]; e++) { const w = adj[e]; if (z[w] === c && mark[w] !== stamp) { mark[w] = stamp; comp.push(w); } }
            }
            comps.push(comp);
        }
        return comps;
    };

    // quitar u de su zona la deja en una pieza? BFS desde un vecino de u en la zona, sin u
    const staysConnected = (u: number, sizeOfZone: number): boolean => {
        const c = z[u];
        let start = -1;
        for (let e = adjStart[u]; e < adjStart[u + 1]; e++) if (z[adj[e]] === c && adj[e] !== u) { start = adj[e]; break; }
        if (start < 0) return sizeOfZone <= 1;          // u estaba solo: quitarlo vacia la zona
        stamp++; mark[u] = stamp; mark[start] = stamp;
        const stack = [start]; let seen = 1;
        while (stack.length) {
            const a = stack.pop()!;
            for (let e = adjStart[a]; e < adjStart[a + 1]; e++) { const w = adj[e]; if (z[w] === c && mark[w] !== stamp) { mark[w] = stamp; seen++; stack.push(w); } }
        }
        return seen === sizeOfZone - 1;
    };
    // --- 1) REPARAR trozos sueltos ----------------------------------------------------------
    let newZones = 0;
    for (let round = 0; round < 20; round++) {
        const mem = membersOf();
        let changed = 0;
        for (let c = 0; c < mem.length; c++) {
            if (mem[c].length === 0) continue;
            const comps = components(mem[c], c);
            if (comps.length <= 1) continue;
            // la pieza principal es la de mas carga; el resto se reubica entero
            let main = 0, mainL = -1;
            for (let j = 0; j < comps.length; j++) { let L = 0; for (const q of comps[j]) L += load[q]; if (L > mainL) { mainL = L; main = j; } }
            for (let j = 0; j < comps.length; j++) {
                if (j === main) continue;
                const frag = comps[j];
                const shared = new Map<number, number>();
                for (const u of frag) for (let e = adjStart[u]; e < adjStart[u + 1]; e++) { const w = adj[e]; if (z[w] !== c) shared.set(z[w], (shared.get(z[w]) ?? 0) + 1); }
                const cands = [...shared.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(e => e[0]);
                let dest = -1;
                for (const d of cands) {
                    let L = 0; for (const u of frag) L += loadIn(u, d);
                    if (tot[d] + L <= hi) { dest = d; break; }
                }
                if (dest >= 0) {
                    for (const u of frag) { tot[z[u]] -= load[u]; const nl = loadIn(u, dest); z[u] = dest; load[u] = nl; tot[dest] += nl; }
                    changed++; continue;
                }
                // INTERCAMBIO: el trozo entra en la vecina d aunque se pase, y d devuelve a c
                // clientes de su frontera comun (c tiene sitio: acaba de perder el trozo) sin
                // partirse, hasta volver bajo el tope. Si no se puede, se deshace.
                let hecho = false;
                for (const d of cands.slice(0, 3)) {
                    const saveZ: [number, number, number][] = [];
                    for (const u of frag) { saveZ.push([u, z[u], load[u]]); tot[z[u]] -= load[u]; const nl = loadIn(u, d); z[u] = d; load[u] = nl; tot[d] += nl; }
                    let szD = 0, szC = 0; for (let q = 0; q < n; q++) { if (z[q] === d) szD++; else if (z[q] === c) szC++; }
                    let guard = 0;
                    while (tot[d] > hi && guard++ < 400) {
                        // cliente de d que toca c, que menos frontera anade y que cabe en c
                        let bu = -1, bcost = Infinity;
                        for (let q = 0; q < n; q++) {
                            if (z[q] !== d) continue;
                            let toC = 0, own = 0;
                            for (let e = adjStart[q]; e < adjStart[q + 1]; e++) { const w = z[adj[e]]; if (w === c) toC++; else if (w === d) own++; }
                            if (toC === 0) continue;
                            const cost = own - toC;
                            if (cost < bcost && tot[c] + loadIn(q, c) <= hi) { bcost = cost; bu = q; }
                        }
                        if (bu < 0 || !staysConnected(bu, szD)) break;
                        saveZ.push([bu, d, load[bu]]);
                        tot[d] -= load[bu]; szD--; const nl = loadIn(bu, c); z[bu] = c; load[bu] = nl; tot[c] += nl; szC++;
                    }
                    if (tot[d] <= hi) { hecho = true; break; }
                    for (let s = saveZ.length - 1; s >= 0; s--) { const [u, zz, l] = saveZ[s]; tot[z[u]] -= load[u]; z[u] = zz; load[u] = l; tot[zz] += l; }
                }
                if (!hecho) {
                    grow(); dest = k - 1; newZones++;
                    for (const u of frag) { tot[z[u]] -= load[u]; const nl = loadIn(u, dest); z[u] = dest; load[u] = nl; tot[dest] += nl; }
                }
                changed++;
            }
        }
        recentre();
        if (changed === 0) break;
    }

    // --- 2) ALISAR fronteras, 3) TOPE ----------------------------------------------------------
    const size = new Int32Array(Math.max(k, 1));
    const recount = (): Int32Array => { const s = new Int32Array(k); for (let q = 0; q < n; q++) s[z[q]]++; return s; };
    // mejor movimiento de alisado para u: {dest, gain} con gain = aristas de frontera ahorradas
    const bestSmooth = (u: number, sz: Int32Array): { d: number; gain: number } => {
        const c = z[u]; if (sz[c] <= 1) return { d: -1, gain: 0 };
        const cnt = new Map<number, number>(); let own = 0;
        for (let e = adjStart[u]; e < adjStart[u + 1]; e++) { const w = z[adj[e]]; if (w === c) own++; else cnt.set(w, (cnt.get(w) ?? 0) + 1); }
        let bd = -1, bg = 0;
        for (const [d, m] of cnt) {
            const g = m - own;
            if (g > bg || (g === bg && g > 0 && d < bd)) {
                if (tot[d] + loadIn(u, d) > hi) continue;
                bd = d; bg = g;
            }
        }
        return { d: bd, gain: bg };
    };
    void size;
    for (let round = 0; round < 12; round++) {
        let sz = recount();
        let moved = 0;
        // cola con todos los clientes de frontera
        const inQ = new Uint8Array(n); const queue: number[] = [];
        for (let q = 0; q < n; q++) for (let e = adjStart[q]; e < adjStart[q + 1]; e++) if (z[adj[e]] !== z[q]) { queue.push(q); inQ[q] = 1; break; }
        for (let h = 0; h < queue.length && h < 50 * n; h++) {
            const u = queue[h]; inQ[u] = 0;
            const mv = bestSmooth(u, sz);
            if (mv.d < 0 || mv.gain <= 0) continue;
            if (!staysConnected(u, sz[z[u]])) continue;
            const c = z[u], nl = loadIn(u, mv.d);
            tot[c] -= load[u]; sz[c]--; z[u] = mv.d; load[u] = nl; tot[mv.d] += nl; sz[mv.d]++; moved++;
            for (let e = adjStart[u]; e < adjStart[u + 1]; e++) { const w = adj[e]; if (!inQ[w]) { inQ[w] = 1; queue.push(w); } }
        }
        recentre();
        // TOPE: zonas que se pasan tras recentrar ceden el cliente de frontera que menos
        // frontera anade, a una vecina con hueco, sin partirse
        sz = recount();
        let fixed = 0;
        for (let c = 0; c < k; c++) {
            let guard = 0;
            while (tot[c] > hi && guard++ < 500) {
                let bu = -1, bd = -1, bcost = Infinity;
                for (let q = 0; q < n; q++) {
                    if (z[q] !== c) continue;
                    let own = 0; const cnt = new Map<number, number>();
                    for (let e = adjStart[q]; e < adjStart[q + 1]; e++) { const w = z[adj[e]]; if (w === c) own++; else cnt.set(w, (cnt.get(w) ?? 0) + 1); }
                    for (const [d, m] of cnt) {
                        const cost = own - m;
                        if (cost < bcost && tot[d] + loadIn(q, d) <= hi) { bcost = cost; bu = q; bd = d; }
                    }
                }
                if (bu < 0 || !staysConnected(bu, sz[c])) break;
                const nl = loadIn(bu, bd);
                tot[c] -= load[bu]; sz[c]--; z[bu] = bd; load[bu] = nl; tot[bd] += nl; sz[bd]++; fixed++;
            }
        }
        if (moved === 0 && fixed === 0) break;
    }
    recentre();

    // --- verificacion ---------------------------------------------------------------------------
    const mem = membersOf();
    let extraPieces = 0, cutEdges = 0, pending = 0;
    for (let c = 0; c < k; c++) if (mem[c].length) extraPieces += components(mem[c], c).length - 1;
    for (let q = 0; q < n; q++) for (let e = adjStart[q]; e < adjStart[q + 1]; e++) if (adj[e] > q && z[adj[e]] !== z[q]) cutEdges++;
    const szF = recount();
    for (let q = 0; q < n; q++) { const mv = bestSmooth(q, szF); if (mv.d >= 0 && mv.gain > 0 && staysConnected(q, szF[z[q]])) pending++; }

    // --- resultado (zonas vacias fuera, renumeradas) ----------------------------------------------
    const ren = new Int32Array(k).fill(-1); let k2 = 0;
    for (let q = 0; q < n; q++) if (ren[z[q]] < 0) ren[z[q]] = k2++;
    const zoneMin = new Float64Array(k2), ccx = new Float64Array(k2), ccy = new Float64Array(k2);
    let travel = 0, all = 0;
    for (let c = 0; c < k; c++) if (ren[c] >= 0) { ccx[ren[c]] = cx[c]; ccy[ren[c]] = cy[c]; }
    for (let q = 0; q < n; q++) {
        const p = points[idx[q]]; const c = ren[z[q]];
        p.clusterId = c; p.load = load[q];
        zoneMin[c] += load[q]; all += load[q]; travel += load[q] - vis[q] * mins[q];
    }
    const zoneHours = new Float64Array(k2); let within = 0;
    for (let c = 0; c < k2; c++) { zoneHours[c] = zoneMin[c] / 60; if (zoneMin[c] >= lo && zoneMin[c] <= capMin * (1 + tol)) within++; }
    const centers = Array.from({ length: k2 }, (_, c) => ({ lat: ccy[c] / ky, lon: ccx[c] / kx }));
    let unassigned = 0; for (const p of points) if (p.clusterId < 0) unassigned++;
    return {
        result: { k: k2, centers, zoneHours, withinTolerance: k2 ? within / k2 : 0, travelShare: all > 0 ? travel / all : 0, outOfBand: k2 - within, unresolved: pending, unassigned },
        stats: { extraPieces, cutEdges, pending, newZones }
    };
}
