"use strict";

/**
 * TERRITORIOS POR AREAS BASICAS (codigos postales), la forma estandar en diseno de
 * territorios de venta (Hess-Samuels 1971; Zoltners-Sinha 1983; Kalcsics-Nickel-Schroder
 * 2005): un territorio es un conjunto de codigos postales VECINOS; dos clientes del mismo
 * codigo van siempre juntos. Asi no hay clientes entrelazados en las fronteras.
 *
 * 1) Unidades: cada codigo postal, con su carga de visita, su centro y sus clientes.
 * 2) Vecindad entre codigos: dos codigos son vecinos si algun cliente de uno esta unido a
 *    alguno del otro en la triangulacion de Delaunay de los clientes.
 * 3) Crecimiento CONTIGUO con tope: los territorios crecen a la vez desde sus semillas
 *    anadiendo el codigo vecino mas cercano a su semilla que quepa bajo el tope. Lo que ya no
 *    cabe en nadie hace nacer un territorio nuevo.
 * 4) Recentrar las semillas y repetir; se queda la mejor vuelta (menos comerciales, y a
 *    igualdad, mas compacta).
 * 5) Pulido: un codigo de frontera pasa al territorio vecino si lo hace mas compacto, cabe
 *    bajo el tope y no parte su territorio de origen.
 */

import Delaunator from "delaunator";
import type { ClusterPoint, ZoningOptions, ZoningResult } from "./clustering";

export interface UnitStats { units: number; unitAdjEdges: number; extraPieces: number; oversizedUnits: number; rounds: number; }

export function territoriesByUnits(points: ClusterPoint[], unitKey: (p: ClusterPoint) => string, opt: ZoningOptions): { result: ZoningResult; stats: UnitStats } {
    const n = points.length;
    const empty: ZoningResult = { k: 0, centers: [], zoneHours: new Float64Array(0), withinTolerance: 0, travelShare: 0, outOfBand: 0, unresolved: 0, unassigned: 0 };
    if (n === 0) return { result: empty, stats: { units: 0, unitAdjEdges: 0, extraPieces: 0, oversizedUnits: 0, rounds: 0 } };
    const capMin = opt.capacityHours * 60, tol = opt.tolerance, hi = capMin * (1 + tol), lo = capMin * (1 - tol);
    const rf = opt.routeFactor != null && opt.routeFactor > 0 ? opt.routeFactor : 0.5;

    // --- clientes -----------------------------------------------------------------------------
    let latM = 0; for (const p of points) latM += p.lat; latM /= n;
    const kx = (Math.PI / 180) * 6371 * Math.cos(latM * Math.PI / 180), ky = (Math.PI / 180) * 6371;
    const x = new Float64Array(n), y = new Float64Array(n), vis = new Float64Array(n), mins = new Float64Array(n), tpk = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const p = points[i];
        x[i] = p.lon * kx; y[i] = p.lat * ky;
        const v = p.visits != null && p.visits > 0 ? p.visits : 1;
        vis[i] = v; mins[i] = p.minutes != null && p.minutes > 0 ? p.minutes : (p.value * 60) / v;
        const s = p.speedKmh != null && p.speedKmh > 0 ? p.speedKmh : opt.speedKmh;
        tpk[i] = (2 * rf * opt.detour / s) * 60;
    }

    // --- unidades -----------------------------------------------------------------------------
    const keyToU = new Map<string, number>();
    const unitOf = new Int32Array(n);
    const keys = points.map(p => unitKey(p) ?? "");
    const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : a - b));
    for (const i of order) { let u = keyToU.get(keys[i]); if (u === undefined) { u = keyToU.size; keyToU.set(keys[i], u); } unitOf[i] = u; }
    // UNIDADES MAYORES QUE UN COMERCIAL (un codigo postal centrico con mucho comercio): se
    // parten por su eje principal, equilibrando carga, hasta que cada parte cabe con holgura.
    // Es lo que se hace en la practica: esos codigos se comparten entre comerciales.
    let U = keyToU.size;
    {
        const groups: number[][] = Array.from({ length: U }, () => []);
        for (let i = 0; i < n; i++) groups[unitOf[i]].push(i);
        const out: number[][] = [];
        const partir = (ids: number[]): void => {
            let sw = 0, sx = 0, sy = 0;
            for (const i of ids) { const w = vis[i] * mins[i] + 1e-9; sw += w; sx += x[i] * w; sy += y[i] * w; }
            const gx = sx / sw, gy = sy / sw;
            let L = 0; for (const i of ids) L += vis[i] * (mins[i] + Math.hypot(x[i] - gx, y[i] - gy) * tpk[i]);
            if (ids.length < 2 || L <= hi * 0.85) { out.push(ids); return; }
            let sxx = 0, sxy = 0, syy = 0;
            for (const i of ids) { const w = vis[i] * mins[i] + 1e-9, dx = x[i] - gx, dy = y[i] - gy; sxx += w * dx * dx; sxy += w * dx * dy; syy += w * dy * dy; }
            const tr = sxx + syy, det = sxx * syy - sxy * sxy, l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
            let ax = sxy, ay = l1 - sxx; if (Math.abs(ax) + Math.abs(ay) < 1e-12) { ax = 1; ay = 0; }
            const e = ids.map(i => ({ i, p: (x[i] - gx) * ax + (y[i] - gy) * ay, w: vis[i] * mins[i] })).sort((a, b) => a.p - b.p || a.i - b.i);
            const m = Math.ceil(L / (hi * 0.85)), half = Math.floor(m / 2);
            let tot2 = 0; for (const v of e) tot2 += v.w;
            let acc = 0, cut = 1; for (let s = 0; s < e.length; s++) { acc += e[s].w; if (acc >= tot2 * half / m) { cut = Math.min(e.length - 1, Math.max(1, s + 1)); break; } }
            partir(e.slice(0, cut).map(v => v.i)); partir(e.slice(cut).map(v => v.i));
        };
        for (const g of groups) partir(g);
        U = out.length;
        out.forEach((g, u) => { for (const i of g) unitOf[i] = u; });
    }
    const uMembers: number[][] = Array.from({ length: U }, () => []);
    for (let i = 0; i < n; i++) uMembers[unitOf[i]].push(i);
    const ux = new Float64Array(U), uy = new Float64Array(U), uVisit = new Float64Array(U);
    for (let u = 0; u < U; u++) {
        let sw = 0, sx = 0, sy = 0;
        for (const i of uMembers[u]) { const w = vis[i] * mins[i] + 1e-9; sw += w; sx += x[i] * w; sy += y[i] * w; }
        ux[u] = sx / sw; uy[u] = sy / sw; uVisit[u] = sw;
    }
    // carga de la unidad u si el centro de su territorio esta en (cx, cy)
    const unitLoad = (u: number, cx: number, cy: number): number => {
        let L = 0; for (const i of uMembers[u]) L += vis[i] * (mins[i] + Math.hypot(x[i] - cx, y[i] - cy) * tpk[i]);
        return L;
    };

    // --- vecindad entre unidades (Delaunay de clientes) -------------------------------------
    const uAdjSet: Set<number>[] = Array.from({ length: U }, () => new Set<number>());
    if (n >= 3) {
        const coords = new Float64Array(2 * n); for (let i = 0; i < n; i++) { coords[2 * i] = x[i]; coords[2 * i + 1] = y[i]; }
        const tr = new Delaunator(coords).triangles;
        const link = (a: number, b: number): void => { const ua = unitOf[a], ub = unitOf[b]; if (ua !== ub) { uAdjSet[ua].add(ub); uAdjSet[ub].add(ua); } };
        for (let t = 0; t < tr.length; t += 3) { link(tr[t], tr[t + 1]); link(tr[t + 1], tr[t + 2]); link(tr[t], tr[t + 2]); }
    }
    const uAdj: Int32Array[] = uAdjSet.map(s => Int32Array.from([...s].sort((a, b) => a - b)));
    let adjEdges = 0; for (const a of uAdj) adjEdges += a.length; adjEdges /= 2;
    let oversized = 0; for (let u = 0; u < U; u++) if (unitLoad(u, ux[u], uy[u]) > hi) oversized++;

    // --- crecimiento contiguo con tope -----------------------------------------------------------
    const d2 = (u: number, sx: number, sy: number): number => (ux[u] - sx) ** 2 + (uy[u] - sy) ** 2;
    const grow = (seedX: number[], seedY: number[]): { t: Int32Array; tx: number[]; ty: number[]; tot: number[] } => {
        const tOf = new Int32Array(U).fill(-1);
        const tx = seedX.slice(), ty = seedY.slice(), tot: number[] = seedX.map(() => 0);
        // semilla -> unidad mas cercana libre
        const heapT: number[] = [], heapU: number[] = [], heapC: number[] = [];
        const push = (t: number, u: number, c: number): void => {
            let p = heapC.length; heapT.push(t); heapU.push(u); heapC.push(c);
            while (p > 0) { const q = (p - 1) >> 1; if (heapC[q] < heapC[p] || (heapC[q] === heapC[p] && heapU[q] <= heapU[p])) break; [heapT[p], heapT[q]] = [heapT[q], heapT[p]]; [heapU[p], heapU[q]] = [heapU[q], heapU[p]]; [heapC[p], heapC[q]] = [heapC[q], heapC[p]]; p = q; }
        };
        const pop = (): [number, number, number] => {
            const top: [number, number, number] = [heapT[0], heapU[0], heapC[0]];
            const lt = heapT.pop()!, lu = heapU.pop()!, lc = heapC.pop()!;
            if (heapC.length) {
                heapT[0] = lt; heapU[0] = lu; heapC[0] = lc; let p = 0;
                for (;;) { const a = 2 * p + 1, b = a + 1; let m = p;
                    if (a < heapC.length && (heapC[a] < heapC[m] || (heapC[a] === heapC[m] && heapU[a] < heapU[m]))) m = a;
                    if (b < heapC.length && (heapC[b] < heapC[m] || (heapC[b] === heapC[m] && heapU[b] < heapU[m]))) m = b;
                    if (m === p) break;
                    [heapT[p], heapT[m]] = [heapT[m], heapT[p]]; [heapU[p], heapU[m]] = [heapU[m], heapU[p]]; [heapC[p], heapC[m]] = [heapC[m], heapC[p]]; p = m; }
            }
            return top;
        };
        const addSeed = (t: number): void => {
            let best = -1, bd = Infinity;
            for (let u = 0; u < U; u++) if (tOf[u] < 0) { const d = d2(u, tx[t], ty[t]); if (d < bd) { bd = d; best = u; } }
            if (best >= 0) push(t, best, 0);
        };
        for (let t = 0; t < tx.length; t++) addSeed(t);
        const run = (): void => {
            while (heapC.length) {
                const [t, u] = pop();
                if (tOf[u] >= 0) continue;
                const L = unitLoad(u, tx[t], ty[t]);
                if (tot[t] > 0 && tot[t] + L > hi) continue;          // no cabe: que lo coja otro
                tOf[u] = t; tot[t] += L;
                for (const w of uAdj[u]) if (tOf[w] < 0) push(t, w, d2(w, tx[t], ty[t]));
            }
        };
        run();
        // lo que quedo sin territorio: nace uno nuevo en la unidad libre de mas carga
        for (let guard = 0; guard < U; guard++) {
            let best = -1, bl = -1;
            for (let u = 0; u < U; u++) if (tOf[u] < 0 && uVisit[u] > bl) { bl = uVisit[u]; best = u; }
            if (best < 0) break;
            tx.push(ux[best]); ty.push(uy[best]); tot.push(0);
            push(tx.length - 1, best, 0);
            run();
        }
        return { t: tOf, tx, ty, tot };
    };

    // --- vueltas: recentrar y volver a crecer -----------------------------------------------
    const centroidOf = (tOf: Int32Array, K: number): { cx: number[]; cy: number[] } => {
        const sx = new Array(K).fill(0), sy = new Array(K).fill(0), sw = new Array(K).fill(0);
        for (let u = 0; u < U; u++) { const t = tOf[u]; if (t < 0) continue; sx[t] += ux[u] * uVisit[u]; sy[t] += uy[u] * uVisit[u]; sw[t] += uVisit[u]; }
        return { cx: sx.map((v, t) => sw[t] > 0 ? v / sw[t] : 0), cy: sy.map((v, t) => sw[t] > 0 ? v / sw[t] : 0) };
    };
    const inertia = (tOf: Int32Array, cx: number[], cy: number[]): number => { let s = 0; for (let u = 0; u < U; u++) if (tOf[u] >= 0) s += uVisit[u] * d2(u, cx[tOf[u]], cy[tOf[u]]); return s; };
    // semillas iniciales: de mas denso a mas disperso, como el crecimiento por puntos
    let totalVisit = 0; for (let u = 0; u < U; u++) totalVisit += uVisit[u];
    const k0 = Math.max(1, Math.ceil(totalVisit * 1.15 / hi));
    const byLoad = Array.from({ length: U }, (_, u) => u).sort((a, b) => uVisit[b] - uVisit[a] || a - b);
    let sx: number[] = [], sy: number[] = [];
    {
        // k0 semillas separadas: la unidad de mas carga cuya distancia a las ya elegidas supera un radio
        const r2 = (areaOf() / k0) * 0.25;
        for (const u of byLoad) { if (sx.length >= k0) break; let ok = true; for (let s = 0; s < sx.length; s++) if (d2(u, sx[s], sy[s]) < r2) { ok = false; break; } if (ok) { sx.push(ux[u]); sy.push(uy[u]); } }
    }
    function areaOf(): number { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (let u = 0; u < U; u++) { a = Math.min(a, ux[u]); b = Math.max(b, ux[u]); c = Math.min(c, uy[u]); d = Math.max(d, uy[u]); } return Math.max(1, (b - a) * (d - c)); }
    let best: { t: Int32Array; K: number; inertia: number; cx: number[]; cy: number[] } | null = null;
    let rounds = 0;
    for (let it = 0; it < 15; it++) {
        rounds++;
        const g = grow(sx, sy);
        const K = g.tx.length;
        // quitar territorios vacios
        const used = new Int32Array(K); for (let u = 0; u < U; u++) if (g.t[u] >= 0) used[g.t[u]] = 1;
        const ren = new Int32Array(K).fill(-1); let K2 = 0; for (let t = 0; t < K; t++) if (used[t]) ren[t] = K2++;
        const tOf = Int32Array.from(g.t, t => t >= 0 ? ren[t] : -1);
        const { cx, cy } = centroidOf(tOf, K2);
        const I = inertia(tOf, cx, cy);
        if (!best || K2 < best.K || (K2 === best.K && I < best.inertia - 1e-6)) best = { t: tOf, K: K2, inertia: I, cx, cy };
        // siguiente vuelta: semillas en los centros de esta
        const prev = sx.length;
        sx = cx; sy = cy;
        if (it > 2 && K2 === prev && best.t === tOf) { /* converge */ }
    }
    const tOf = best!.t; let K = best!.K;
    let { cx, cy } = centroidOf(tOf, K);

    // --- DISOLVER territorios cortos cuyos codigos caben en los contiguos --------------------
    // Se recorren sus codigos desde la frontera hacia dentro (cada uno pasa a un territorio
    // vecino con hueco, el mas cercano), asi cada receptor sigue siendo una pieza. Si alguno
    // no cabe, se deshace y el territorio se queda corto.
    for (let pasada = 0; pasada < 3; pasada++) {
        let totD = new Array(K).fill(0);
        for (let u = 0; u < U; u++) if (tOf[u] >= 0) totD[tOf[u]] += unitLoad(u, cx[tOf[u]], cy[tOf[u]]);
        const cortos = Array.from({ length: K }, (_, q) => q).filter(q => totD[q] > 0 && totD[q] < lo).sort((a, b) => totD[a] - totD[b]);
        let disueltos = 0;
        for (const s of cortos) {
            if (totD[s] <= 0 || totD[s] >= lo) continue;
            const mine: number[] = []; for (let u = 0; u < U; u++) if (tOf[u] === s) mine.push(u);
            const hechos: [number, number][] = []; let ok = true;
            let pend = mine.slice();
            for (let guard = 0; guard < mine.length * 2 && pend.length; guard++) {
                const next: number[] = [];
                let progreso = false;
                for (const u of pend) {
                    let bt = -1, bd = Infinity;
                    for (const w of uAdj[u]) { const q = tOf[w]; if (q < 0 || q === s) continue; const d = d2(u, cx[q], cy[q]); if (d < bd && totD[q] + unitLoad(u, cx[q], cy[q]) <= hi) { bd = d; bt = q; } }
                    if (bt < 0) { next.push(u); continue; }
                    const L = unitLoad(u, cx[bt], cy[bt]); totD[bt] += L; totD[s] -= unitLoad(u, cx[s], cy[s]); tOf[u] = bt; hechos.push([u, bt]); progreso = true;
                }
                pend = next;
                if (!progreso) break;
            }
            if (pend.length) { ok = false; for (let h = hechos.length - 1; h >= 0; h--) { const [u, q] = hechos[h]; totD[q] -= unitLoad(u, cx[q], cy[q]); totD[s] += unitLoad(u, cx[s], cy[s]); tOf[u] = s; } }
            if (ok) disueltos++;
        }
        // renumerar sin los vacios
        const used = new Int32Array(K); for (let u = 0; u < U; u++) if (tOf[u] >= 0) used[tOf[u]] = 1;
        const ren = new Int32Array(K).fill(-1); let K2 = 0; for (let q = 0; q < K; q++) if (used[q]) ren[q] = K2++;
        for (let u = 0; u < U; u++) if (tOf[u] >= 0) tOf[u] = ren[tOf[u]];
        K = K2; ({ cx, cy } = centroidOf(tOf, K)); totD = [];
        if (!disueltos) break;
    }

    // --- pulido: unidades de frontera al vecino si baja la inercia, cabe y no parte el origen ---
    const tot = new Array(K).fill(0);
    for (let u = 0; u < U; u++) if (tOf[u] >= 0) tot[tOf[u]] += unitLoad(u, cx[tOf[u]], cy[tOf[u]]);
    const sizeT = new Int32Array(K); for (let u = 0; u < U; u++) if (tOf[u] >= 0) sizeT[tOf[u]]++;
    const mark = new Int32Array(U); let stamp = 0;
    const staysConnected = (u: number): boolean => {
        const t = tOf[u]; if (sizeT[t] <= 1) return false;
        let start = -1; for (const w of uAdj[u]) if (tOf[w] === t) { start = w; break; }
        if (start < 0) return false;
        stamp++; mark[u] = stamp; mark[start] = stamp; const st = [start]; let seen = 1;
        while (st.length) { const a = st.pop()!; for (const w of uAdj[a]) if (tOf[w] === t && mark[w] !== stamp) { mark[w] = stamp; seen++; st.push(w); } }
        return seen === sizeT[t] - 1;
    };
    for (let pass = 0; pass < 30; pass++) {
        let moved = 0;
        for (let u = 0; u < U; u++) {
            const a = tOf[u]; if (a < 0) continue;
            const cand = new Set<number>(); for (const w of uAdj[u]) if (tOf[w] >= 0 && tOf[w] !== a) cand.add(tOf[w]);
            if (!cand.size) continue;
            const dA = d2(u, cx[a], cy[a]);
            let bt = -1, bd = dA;
            for (const b of [...cand].sort((p, q) => p - q)) { const d = d2(u, cx[b], cy[b]); if (d < bd - 1e-9) { const L = unitLoad(u, cx[b], cy[b]); if (tot[b] + L <= hi) { bd = d; bt = b; } } }
            if (bt < 0 || !staysConnected(u)) continue;
            tot[a] -= unitLoad(u, cx[a], cy[a]); tot[bt] += unitLoad(u, cx[bt], cy[bt]);
            sizeT[a]--; sizeT[bt]++; tOf[u] = bt; moved++;
        }
        if (moved === 0) break;
        ({ cx, cy } = centroidOf(tOf, K));
        tot.fill(0); for (let u = 0; u < U; u++) if (tOf[u] >= 0) tot[tOf[u]] += unitLoad(u, cx[tOf[u]], cy[tOf[u]]);
    }

    // --- EQUILIBRAR y TOPE, con contigüidad, hasta que nada cambia ----------------------------
    const recalc = (): number[] => { const T = new Array(K).fill(0); for (let u = 0; u < U; u++) if (tOf[u] >= 0) T[tOf[u]] += unitLoad(u, cx[tOf[u]], cy[tOf[u]]); return T; };
    const recount = (): void => { sizeT.fill(0); for (let u = 0; u < U; u++) if (tOf[u] >= 0) sizeT[tOf[u]]++; };
    // mitad contigua de un territorio: BFS desde la unidad mas lejana al centro hasta la mitad de carga
    const halve = (q: number, T: number[]): void => {
        const mine: number[] = []; for (let u = 0; u < U; u++) if (tOf[u] === q) mine.push(u);
        if (mine.length < 2) return;
        let far = mine[0], fd = -1; for (const u of mine) { const d = d2(u, cx[q], cy[q]); if (d > fd) { fd = d; far = u; } }
        const nq = K; K++;
        const inQ = new Set<number>(mine); const half = T[q] / 2; let acc = 0;
        const st = [far]; const seen = new Set<number>([far]);
        while (st.length && acc < half) {
            // siempre la unidad del frente mas cercana a la semilla lejana (crece compacto)
            let bi = 0; for (let s = 1; s < st.length; s++) if (d2(st[s], ux[far], uy[far]) < d2(st[bi], ux[far], uy[far])) bi = s;
            const u = st.splice(bi, 1)[0];
            tOf[u] = nq; acc += unitLoad(u, cx[q], cy[q]);
            for (const w of uAdj[u]) if (inQ.has(w) && !seen.has(w)) { seen.add(w); st.push(w); }
        }
        cx.push(0); cy.push(0);
    };
    for (let ronda = 0; ronda < 25; ronda++) {
        ({ cx, cy } = centroidOf(tOf, K));
        let T = recalc(); recount();
        let cambios = 0;
        // equilibrar: de un territorio mas cargado a uno vecino corto
        for (let u = 0; u < U; u++) {
            const a = tOf[u]; if (a < 0) continue;
            for (const w of uAdj[u]) {
                const b = tOf[w]; if (b < 0 || b === a || T[b] >= lo) continue;
                const La = unitLoad(u, cx[a], cy[a]), Lb = unitLoad(u, cx[b], cy[b]);
                if (T[b] + Lb > hi || T[a] - La < T[b] + Lb) continue;          // no invertir el orden
                if (!staysConnected(u)) continue;
                T[a] -= La; T[b] += Lb; sizeT[a]--; sizeT[b]++; tOf[u] = b; cambios++; break;
            }
        }
        // tope: ceder frontera a vecinos con hueco; si no, partir en dos mitades contiguas
        for (let q = 0; q < K; q++) {
            let guard = 0;
            while (T[q] > hi && guard++ < 200) {
                let bu = -1, bb = -1, bd = Infinity;
                for (let u = 0; u < U; u++) {
                    if (tOf[u] !== q) continue;
                    for (const w of uAdj[u]) { const b = tOf[w]; if (b < 0 || b === q) continue; const Lb = unitLoad(u, cx[b], cy[b]); if (T[b] + Lb <= hi) { const d = d2(u, cx[b], cy[b]); if (d < bd) { bd = d; bu = u; bb = b; } } }
                }
                if (bu < 0 || !staysConnected(bu)) { halve(q, T); cambios++; break; }
                T[q] -= unitLoad(bu, cx[q], cy[q]); T[bb] += unitLoad(bu, cx[bb], cy[bb]); sizeT[q]--; sizeT[bb]++; tOf[bu] = bb; cambios++;
            }
        }
        if (!cambios) break;
    }
    ({ cx, cy } = centroidOf(tOf, K));

    // --- piezas (verificacion) y resultado ---------------------------------------------------------
    let extraPieces = 0;
    {
        const seenT = new Int32Array(U).fill(0); const comps = new Int32Array(K);
        for (let u = 0; u < U; u++) {
            if (seenT[u] || tOf[u] < 0) continue;
            const t = tOf[u]; comps[t]++; seenT[u] = 1; const st = [u];
            while (st.length) { const a = st.pop()!; for (const w of uAdj[a]) if (!seenT[w] && tOf[w] === t) { seenT[w] = 1; st.push(w); } }
        }
        for (let t = 0; t < K; t++) if (comps[t] > 1) extraPieces += comps[t] - 1;
    }
    const zoneMin = new Float64Array(K); let travel = 0, all = 0;
    for (let i = 0; i < n; i++) {
        const t = tOf[unitOf[i]]; points[i].clusterId = t;
        const l = vis[i] * (mins[i] + Math.hypot(x[i] - cx[t], y[i] - cy[t]) * tpk[i]);
        points[i].load = l; zoneMin[t] += l; all += l; travel += l - vis[i] * mins[i];
    }
    const zoneHours = new Float64Array(K); let within = 0;
    for (let t = 0; t < K; t++) { zoneHours[t] = zoneMin[t] / 60; if (zoneMin[t] >= lo && zoneMin[t] <= hi) within++; }
    void K;
    return {
        result: { k: K, centers: Array.from({ length: K }, (_, t) => ({ lat: cy[t] / ky, lon: cx[t] / kx })), zoneHours, withinTolerance: K ? within / K : 0, travelShare: all > 0 ? travel / all : 0, outOfBand: K - within, unresolved: 0, unassigned: 0 },
        stats: { units: U, unitAdjEdges: adjEdges, extraPieces, oversizedUnits: oversized, rounds }
    };
}
