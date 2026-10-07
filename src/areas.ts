"use strict";

/**
 * AREAS COMERCIALES A NIVEL DE CODIGO POSTAL (decision del usuario, 30-09-2026).
 *
 * El producto responde primero a la pregunta de dimensionamiento (Zoltners-Sinha: dimensionar
 * antes que alinear): cuantos comerciales necesita cada area. Las areas se construyen con
 * codigos postales enteros, salvo dos excepciones: un codigo de mas de 25 km se parte por
 * pueblos, y un codigo que no es geografico (coherencia < 0,5) se ignora. Pueden venir:
 *   - del usuario (provincia, comunidad, region...): cada cliente va a SU valor de Area; el
 *     codigo postal no interviene (hasta el 07-10-2026 movia clientes al area con mas peso de
 *     su codigo, contra el dato del usuario);
 *   - automaticas: el usuario dice cuantas y se agrupan codigos postales vecinos en ese numero
 *     de areas compactas y de UNA SOLA PIEZA (k-medias ponderado por carga sobre los centros
 *     de los codigos + reparacion de contigüidad sobre la vecindad de Delaunay).
 * Sin codigo postal: en automaticas, "pueblos" (clientes a <= 2 km); con el campo Area, cada
 * cliente es su propia unidad.
 *
 * Con el estado de cada punto (regions.ts), las areas automaticas solo unen unidades de estados
 * con frontera terrestre comun: la vecindad de Delaunay en linea recta cruzaba golfos y mares
 * (Baja California Sur con Sinaloa, 06-10-2026). Un trozo que queda al otro lado del agua pasa
 * al area con la que si tiene frontera.
 */

import Delaunator from "delaunator";
import type { ClusterPoint } from "./clustering";
import { landGroup, statesTouch } from "./regions";
import { ADMIN1_NAMES } from "./outlines";

export interface AreaBuild {
    areaOf: Int32Array; names: string[]; units: number; extraPieces: number;
    /** El codigo postal no parece geografico y se ha ignorado (unidades = clientes). */
    postalIgnored?: boolean;
    /** Codigos postales de mas de 25 km partidos por pueblos: el filtro por codigo ya no es exacto. */
    postalSplit?: number;
    /** Nombre propio de cada area (islas: su region) o null (area numerada). */
    fixedNames?: (string | null)[];
    /** Fraccion de clientes cuyo vecino mas cercano comparte su codigo (codigos de 2+ clientes). */
    postalCoherence?: number;
}

function mulberry(seed: number): () => number {
    let a = seed >>> 0;
    return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/**
 * @param postal  codigo postal de cada punto (o null: cada cliente es una unidad)
 * @param mode    "field": areas del campo Area; "auto": nAuto areas automaticas
 * @param stateOf estado de cada punto (regions.statesOfPoints) o null: sin restriccion
 */
export function buildAreas(points: ClusterPoint[], postal: ((p: ClusterPoint) => string | undefined) | null, mode: "field" | "auto", nAuto: number,
                           stateOf: Int32Array | null = null): AreaBuild {
    const n = points.length;
    if (n === 0) return { areaOf: new Int32Array(0), names: [], units: 0, extraPieces: 0 };
    let postalIgnored = false, postalCoherence: number | undefined;
    let latM = 0; for (const p of points) latM += p.lat; latM /= n;
    const kx = (Math.PI / 180) * 6371 * Math.cos(latM * Math.PI / 180), ky = (Math.PI / 180) * 6371;
    const x = new Float64Array(n), y = new Float64Array(n), w = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const p = points[i]; x[i] = p.lon * kx; y[i] = p.lat * ky;
        const v = p.visits != null && p.visits > 0 ? p.visits : 1;
        w[i] = v * (p.minutes != null && p.minutes > 0 ? p.minutes : (p.value * 60) / v) + 1e-9;
    }
    // triangulacion de los clientes: da la vecindad entre unidades y el vecino mas cercano
    // (que siempre es un vecino de Delaunay)
    const tri = n >= 3 ? (() => { const c = new Float64Array(2 * n); for (let i = 0; i < n; i++) { c[2 * i] = x[i]; c[2 * i + 1] = y[i]; } return new Delaunator(c).triangles; })() : null;

    // --- ¿el codigo postal es geografico? ----------------------------------------------------
    // En un codigo real, el cliente mas cercano suele estar en el mismo codigo: 0,86-0,91 en
    // los cuatro datasets de demo. Con codigos sin geografia (un codigo de cliente puesto en
    // Postal code, o los inventados del 04-10-2026, que juntaban clientes a 250-465 km) sale
    // 0,00, y como un codigo nunca se parte, las areas se mezclaban. Por debajo de 0,5 se
    // ignora el codigo y cada cliente es su propia unidad; el visual lo dice en el mapa.
    // Con el campo Area el codigo postal no interviene (manda el dato del usuario, cliente a
    // cliente; decision de Tino 07-10-2026): solo se evalua en areas automaticas.
    if (mode === "field") postal = null;
    if (postal && tri) {
        const keys = points.map(p => postal(p) ?? "");
        const cnt = new Map<string, number>(); for (const k of keys) cnt.set(k, (cnt.get(k) ?? 0) + 1);
        const nn = new Int32Array(n).fill(-1), nd = new Float64Array(n).fill(Infinity);
        const edge = (a: number, b: number): void => {
            const d = (x[a] - x[b]) ** 2 + (y[a] - y[b]) ** 2;
            if (d < nd[a]) { nd[a] = d; nn[a] = b; } if (d < nd[b]) { nd[b] = d; nn[b] = a; }
        };
        for (let t = 0; t < tri.length; t += 3) { edge(tri[t], tri[t + 1]); edge(tri[t + 1], tri[t + 2]); edge(tri[t], tri[t + 2]); }
        let same = 0, tot = 0;
        for (let i = 0; i < n; i++) if ((cnt.get(keys[i]) ?? 0) >= 2 && nn[i] >= 0) { tot++; if (keys[nn[i]] === keys[i]) same++; }
        if (tot >= 20) {
            postalCoherence = same / tot;
            if (postalCoherence < 0.5) { postal = null; postalIgnored = true; }
        }
    }

    // --- PUEBLOS (06-10-2026): clientes a menos de 2 km de otro (aristas de Delaunay) o en la
    // misma coordenada (mismo edificio: Delaunay los ignora) forman un pueblo. Una mancha de mas
    // de 25 km (una conurbacion) se parte en celdas de 5 km. Sirven de unidad sin codigo postal
    // y para partir codigos postales que no son de un solo sitio (ver abajo).
    const LINK = 2, MAX_EXT = 25, CELDA = 5;
    const par = Int32Array.from({ length: n }, (_, i) => i);
    const raiz = (a: number): number => { while (par[a] !== a) { par[a] = par[par[a]]; a = par[a]; } return a; };
    const unir = (a: number, b: number): void => { const ra = raiz(a), rb = raiz(b); if (ra !== rb) par[Math.max(ra, rb)] = Math.min(ra, rb); };
    {
        const mismo = new Map<string, number>();
        for (let i = 0; i < n; i++) { const k = x[i] + "," + y[i]; const j = mismo.get(k); if (j === undefined) mismo.set(k, i); else unir(i, j); }
        if (tri) for (let t = 0; t < tri.length; t += 3) {
            for (const [a, b] of [[tri[t], tri[t + 1]], [tri[t + 1], tri[t + 2]], [tri[t], tri[t + 2]]]) if (Math.hypot(x[a] - x[b], y[a] - y[b]) <= LINK) unir(a, b);
        }
    }
    const extension = (grupo: (i: number) => string): Map<string, number> => {
        const caja = new Map<string, [number, number, number, number]>();
        for (let i = 0; i < n; i++) {
            const g = grupo(i), c = caja.get(g);
            if (!c) caja.set(g, [x[i], x[i], y[i], y[i]]);
            else { if (x[i] < c[0]) c[0] = x[i]; if (x[i] > c[1]) c[1] = x[i]; if (y[i] < c[2]) c[2] = y[i]; if (y[i] > c[3]) c[3] = y[i]; }
        }
        const out = new Map<string, number>(); for (const [g, c] of caja) out.set(g, Math.hypot(c[1] - c[0], c[3] - c[2])); return out;
    };
    const extPueblo = extension(i => String(raiz(i)));
    const pueblo = (i: number): string => { const r = raiz(i); return extPueblo.get(String(r))! > MAX_EXT ? `${r}:${Math.floor(x[i] / CELDA)}:${Math.floor(y[i] / CELDA)}` : `${r}`; };

    // --- unidades: codigos postales, pueblos o clientes ----------------------------------------
    // Un codigo postal real es compacto. Si uno abarca mas de 25 km (el de la capital puesto a
    // toda la provincia, error habitual en un CRM; en el dataset de demo, "18000" con 51
    // clientes en 134 km), se parte por pueblos: si no, sus clientes sueltos iban al area de la
    // mayoria del codigo, lejos de donde estan.
    const unitOf = new Int32Array(n);
    let U = 0, postalSplit = 0;
    {
        let keys: string[];
        if (postal) {
            const codes = points.map(p => postal(p) ?? "");
            const extCode = extension(i => codes[i]);
            keys = codes.map((c, i) => extCode.get(c)! > MAX_EXT ? `${c}|${pueblo(i)}` : c);
            for (const e of extCode.values()) if (e > MAX_EXT) postalSplit++;
        } else if (mode === "auto") {
            keys = Array.from({ length: n }, (_, i) => pueblo(i));   // con el campo Area manda el dato, cliente a cliente
        } else {
            keys = Array.from({ length: n }, (_, i) => String(i));
        }
        const ids = new Map<string, number>();
        const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (keys[a] < keys[b] ? -1 : keys[a] > keys[b] ? 1 : a - b));
        for (const i of order) { let u = ids.get(keys[i]); if (u === undefined) { u = ids.size; ids.set(keys[i], u); } unitOf[i] = u; }
        U = ids.size;
    }
    const members: number[][] = Array.from({ length: U }, () => []);
    for (let i = 0; i < n; i++) members[unitOf[i]].push(i);
    const ux = new Float64Array(U), uy = new Float64Array(U), uw = new Float64Array(U);
    for (let u = 0; u < U; u++) { let sx = 0, sy = 0, sw = 0; for (const i of members[u]) { sx += x[i] * w[i]; sy += y[i] * w[i]; sw += w[i]; } ux[u] = sx / sw; uy[u] = sy / sw; uw[u] = sw; }

    // --- modo campo: unidades = clientes (sin postal), cada uno a su valor de Area --------------
    if (mode === "field") {
        const nameIds = new Map<string, number>();
        const labels = [...new Set(points.map(p => p.area ?? ""))].sort();
        for (const l of labels) nameIds.set(l, nameIds.size);
        const areaOf = new Int32Array(n);
        for (let u = 0; u < U; u++) {
            const cnt = new Map<string, number>();
            for (const i of members[u]) { const l = points[i].area ?? ""; cnt.set(l, (cnt.get(l) ?? 0) + w[i]); }
            let best = "", bv = -1; for (const [l, v] of [...cnt.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) if (v > bv) { bv = v; best = l; }
            for (const i of members[u]) areaOf[i] = nameIds.get(best)!;
        }
        return { areaOf, names: labels.map(l => l || "(no area)"), units: U, extraPieces: 0, postalIgnored, postalCoherence, postalSplit };
    }

    // --- modo automatico: k-medias ponderado sobre los codigos + contigüidad -----------------
    // estado de cada unidad: el de la mayoria de su carga (-1 = desconocido, no restringe)
    const uState = new Int32Array(U).fill(-1);
    if (stateOf) {
        for (let u = 0; u < U; u++) {
            const cnt = new Map<number, number>();
            for (const i of members[u]) if (stateOf[i] >= 0) cnt.set(stateOf[i], (cnt.get(stateOf[i]) ?? 0) + w[i]);
            let bv = -1; for (const [s, v] of cnt) if (v > bv || (v === bv && s < uState[u])) { bv = v; uState[u] = s; }
        }
    }
    // ISLAS (06-10-2026): cada GRUPO DE TIERRA que no es el principal de los datos (Baleares,
    // cada provincia canaria, Azores, Sicilia, Creta, Hawai...) es un area propia, ademas de las
    // nAuto. Un comercial no va en coche de Palma a Valencia: con el continente, sus horas de
    // viaje serian falsas. Las islas no entran en el k-medias (peso 0) para no gastar un centro
    // en el mar; se asignan despues, una area por grupo, con nombre propio.
    const uGroup = new Int32Array(U).fill(-1);
    const gLoad = new Map<number, number>();
    for (let u = 0; u < U; u++) { uGroup[u] = landGroup(uState[u]); if (uGroup[u] >= 0) gLoad.set(uGroup[u], (gLoad.get(uGroup[u]) ?? 0) + uw[u]); }
    let mainG = -1, mgl = -1; for (const [g, l] of gLoad) if (l > mgl || (l === mgl && g < mainG)) { mgl = l; mainG = g; }
    const isIsland = (u: number): boolean => uGroup[u] >= 0 && uGroup[u] !== mainG;
    const kw = new Float64Array(U); let mainUnits = 0;
    for (let u = 0; u < U; u++) { kw[u] = isIsland(u) ? 0 : uw[u]; if (!isIsland(u)) mainUnits++; }

    const K = Math.max(1, Math.min(nAuto, mainUnits));
    // VARIOS ARRANQUES, nos quedamos con el mas compacto (06-10-2026). Con un solo arranque, el
    // resultado dependia de la semilla y la semilla del numero de unidades: con 5 areas, poner
    // o quitar el codigo postal dejaba en la misma area solo el 68-73% de la carga, porque hay
    // varias particiones casi igual de buenas. Con 24 arranques y la de menor dispersion
    // ponderada, las dos versiones caen en la misma solucion.
    const RESTARTS = 24;
    const rnd = mulberry(20260930 ^ (K * 7919));
    let tw = 0; for (let u = 0; u < U; u++) tw += kw[u];
    const pick = (ws: Float64Array, tot: number): number => { let r = rnd() * tot; for (let u = 0; u < U; u++) { r -= ws[u]; if (r <= 0) return u; } return U - 1; };
    const aOf = new Int32Array(U);
    let bestCost = Infinity;
    const cx = new Float64Array(K), cy = new Float64Array(K), cur = new Int32Array(U);
    const dm = new Float64Array(U), pw = new Float64Array(U);
    for (let rs = 0; rs < RESTARTS; rs++) {
        // k-medias++ ponderado por carga
        const f = pick(kw, tw); cx[0] = ux[f]; cy[0] = uy[f];
        for (let u = 0; u < U; u++) dm[u] = (ux[u] - cx[0]) ** 2 + (uy[u] - cy[0]) ** 2;
        for (let c = 1; c < K; c++) {
            let tp = 0; for (let u = 0; u < U; u++) { pw[u] = dm[u] * kw[u]; tp += pw[u]; }
            const s = tp > 0 ? pick(pw, tp) : Math.floor(rnd() * U); cx[c] = ux[s]; cy[c] = uy[s];
            for (let u = 0; u < U; u++) { const d = (ux[u] - cx[c]) ** 2 + (uy[u] - cy[c]) ** 2; if (d < dm[u]) dm[u] = d; }
        }
        cur.fill(-1);
        let cost = 0;
        for (let it = 0; it < 50; it++) {
            let ch = 0; cost = 0;
            for (let u = 0; u < U; u++) { let b = 0, bd = Infinity; for (let c = 0; c < K; c++) { const d = (ux[u] - cx[c]) ** 2 + (uy[u] - cy[c]) ** 2; if (d < bd) { bd = d; b = c; } } cost += bd * kw[u]; if (cur[u] !== b) { cur[u] = b; ch++; } }
            const sx = new Float64Array(K), sy = new Float64Array(K), sw = new Float64Array(K);
            for (let u = 0; u < U; u++) { sx[cur[u]] += ux[u] * kw[u]; sy[cur[u]] += uy[u] * kw[u]; sw[cur[u]] += kw[u]; }
            for (let c = 0; c < K; c++) if (sw[c] > 0) { cx[c] = sx[c] / sw[c]; cy[c] = sy[c] / sw[c]; }
            if (ch === 0) break;
        }
        if (cost < bestCost) { bestCost = cost; aOf.set(cur); }
    }
    // islas: un area por grupo de tierra, despues de las K
    const islandArea = new Map<number, number>();
    let KT = K;
    for (let u = 0; u < U; u++) {
        if (!isIsland(u)) continue;
        let ar = islandArea.get(uGroup[u]);
        if (ar === undefined) { ar = KT++; islandArea.set(uGroup[u], ar); }
        aOf[u] = ar;
    }
    // vecindad entre unidades (Delaunay de clientes), sin cruzar entre estados que no se tocan.
    // Cada vecino guarda la distancia mas corta entre clientes de las dos unidades (km).
    // (Se probo a quitar las aristas largas, >4 veces la del vecino mas cercano: arreglaba
    // Nogales pero partia las areas poco pobladas en ciudades sueltas. Retirado el 06-10-2026.)
    const adj: Map<number, number>[] = Array.from({ length: U }, () => new Map<number, number>());
    if (tri) {
        const tr = tri;
        const link = (a: number, b: number): void => {
            const ua = unitOf[a], ub = unitOf[b];
            if (ua === ub || !statesTouch(uState[ua], uState[ub])) return;
            const d = Math.hypot(x[a] - x[b], y[a] - y[b]);
            const old = adj[ua].get(ub);
            if (old === undefined || d < old) { adj[ua].set(ub, d); adj[ub].set(ua, d); }
        };
        for (let t = 0; t < tr.length; t += 3) { link(tr[t], tr[t + 1]); link(tr[t + 1], tr[t + 2]); link(tr[t], tr[t + 2]); }
    }
    // contigüidad: los trozos sueltos de un area pasan enteros al area vecina con mas frontera
    let extraPieces = 0;
    const reparar = (): void => {
        for (let round = 0; round < 30; round++) {
            const seen = new Int32Array(U).fill(-1); let cambios = 0;
            const comps: number[][][] = Array.from({ length: KT }, () => []);
            for (let u = 0; u < U; u++) {
                if (seen[u] >= 0) continue;
                const a = aOf[u]; const comp = [u]; seen[u] = 1;
                for (let h = 0; h < comp.length; h++) for (const v of adj[comp[h]].keys()) if (seen[v] < 0 && aOf[v] === a) { seen[v] = 1; comp.push(v); }
                comps[a].push(comp);
            }
            extraPieces = 0;
            for (let a = 0; a < KT; a++) {
                if (comps[a].length <= 1) continue;
                extraPieces += comps[a].length - 1;
                let main = 0, mw = -1;
                comps[a].forEach((c, j) => { let s = 0; for (const u of c) s += uw[u]; if (s > mw) { mw = s; main = j; } });
                comps[a].forEach((c, j) => {
                    if (j === main) return;
                    const shared = new Map<number, number>();
                    for (const u of c) for (const v of adj[u].keys()) if (aOf[v] !== a) shared.set(aOf[v], (shared.get(aOf[v]) ?? 0) + 1);
                    let dest = -1, bv = -1; for (const [d, v] of [...shared.entries()].sort((p, q) => p[0] - q[0])) if (v > bv) { bv = v; dest = d; }
                    // Sin ninguna arista hacia otra area: al area con la unidad mas cercana de SU
                    // estado o de un estado con frontera terrestre comun; si ni eso (Alaska: llega
                    // por tierra a traves de Canada, sin clientes alli), del mismo grupo de tierra.
                    // Sin candidata (una isla), se queda donde esta.
                    // La candidata puede ser de la PROPIA area (otro trozo): entonces se queda. Un
                    // cliente repetido en la misma coordenada no tiene aristas de Delaunay y, sin
                    // esto, saltaba de area en area (86 trozos sueltos en Espana, 06-10-2026).
                    const enTrozo = new Set(c);
                    for (const regla of [0, 1]) {
                        if (dest >= 0) break;
                        let bd = Infinity;
                        for (const u of c) for (let v = 0; v < U; v++) {
                            if (enTrozo.has(v) || uState[u] < 0 || isIsland(v) !== isIsland(u)) continue;
                            if (regla === 0 ? !statesTouch(uState[u], uState[v]) : uGroup[u] !== uGroup[v]) continue;
                            const d = (ux[u] - ux[v]) ** 2 + (uy[u] - uy[v]) ** 2;
                            if (d < bd) { bd = d; dest = aOf[v]; }
                        }
                    }
                    if (dest >= 0 && dest !== a) { for (const u of c) aOf[u] = dest; cambios++; }
                });
            }
            if (!cambios) { extraPieces = 0; break; }
        }
    };
    reparar();
    // REZAGADOS por VECINOS MAS CERCANOS (07-10-2026, idea de Tino). Cada unidad mira los 10
    // clientes mas cercanos que no son suyos, pesados por cercania (1/d); si mas del 60% del
    // peso es de otra area con frontera terrestre comun, pasa a esa area. La version anterior
    // votaba con los vecinos de Delaunay: un grupito de 2-3 clientes a 5-8 km de un pueblo de
    // otra area (Ronda, Zamora) tenia pocas aristas hacia el pueblo y varias largas hacia su
    // area, y no se movia. Con 1/d^2 tampoco: tres clientes sueltos a 3 km entre si y a 6 km de
    // Ronda se votaban unos a otros (55%). Las fronteras normales quedan cerca del 50%.
    {
        const KV = 10, CEL = 3;   // rejilla de 3 km
        const rej = new Map<string, number[]>();
        for (let i = 0; i < n; i++) { const k = Math.floor(x[i] / CEL) + "," + Math.floor(y[i] / CEL); const a = rej.get(k); if (a) a.push(i); else rej.set(k, [i]); }
        // vecinos de cada unidad pequena: los KV clientes mas cercanos a su CENTRO, fuera de ella.
        // La busqueda se amplia hasta tenerlos (tope ~120 km): dos clientes a 50 km de Nogales no
        // encontraban a nadie con un radio fijo de 24 km y no votaban.
        const vecinos: [number, number][][] = Array.from({ length: U }, () => []);
        for (let u = 0; u < U; u++) {
            // solo grupos pequenos: un rezagado nunca es un pueblo de 30 clientes, y buscar
            // vecinos para Madrid costaba segundos en el dataset de Espana
            if (isIsland(u) || members[u].length > 30) continue;
            const cx = Math.floor(ux[u] / CEL), cy = Math.floor(uy[u] / CEL);
            const cand: [number, number][] = [];
            for (let r = 0; r <= 40; r++) {
                for (let gx = cx - r; gx <= cx + r; gx++) for (let gy = cy - r; gy <= cy + r; gy++) {
                    if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== r) continue;
                    for (const j of rej.get(gx + "," + gy) ?? []) {
                        if (unitOf[j] === u || !statesTouch(uState[u], uState[unitOf[j]])) continue;
                        cand.push([j, Math.hypot(x[j] - ux[u], y[j] - uy[u])]);
                    }
                }
                // todo lo no explorado esta a mas de r*CEL del centro
                if (cand.length >= KV) { cand.sort((p, q) => p[1] - q[1]); if (cand[KV - 1][1] <= r * CEL) break; }
            }
            cand.sort((p, q) => p[1] - q[1]);
            vecinos[u] = cand.slice(0, KV);
            // y cuentan como CONEXION para la contigüidad (hasta 10 km): si no, la reparacion
            // veia el grupito movido como trozo suelto de su nueva area y lo devolvia (Ronda)
            for (const [j, d] of vecinos[u]) if (d <= 10) { const v = unitOf[j]; const o = adj[u].get(v); if (o === undefined || d < o) { adj[u].set(v, d); adj[v].set(u, d); } }
        }
        for (let pasada = 0; pasada < 5; pasada++) {
            let movidos = 0;
            for (let u = 0; u < U; u++) {
                if (!vecinos[u].length) continue;
                const peso = new Map<number, number>(); let tot = 0;
                for (const [j, d] of vecinos[u]) { const a = aOf[unitOf[j]], wv = 1 / (d + 0.5); peso.set(a, (peso.get(a) ?? 0) + wv); tot += wv; }
                let best = aOf[u], bw = peso.get(aOf[u]) ?? 0;
                for (const [a, wa] of peso) if (wa > bw) { bw = wa; best = a; }
                if (best !== aOf[u] && bw / tot > 0.6) { aOf[u] = best; movidos++; }
            }
            if (!movidos) break;
            reparar();
        }
    }
    // areas vacias fuera, numeradas de norte a sur
    const used = [...new Set(Array.from(aOf))];
    const cyA = new Map<number, number>(); for (const a of used) { let s = 0, sw = 0; for (let u = 0; u < U; u++) if (aOf[u] === a) { s += uy[u] * uw[u]; sw += uw[u]; } cyA.set(a, s / sw); }
    used.sort((p, q) => (p >= K ? 1 : 0) - (q >= K ? 1 : 0) || cyA.get(q)! - cyA.get(p)! || p - q);
    const ren = new Map<number, number>(); used.forEach((a, j) => ren.set(a, j));
    const areaOf = new Int32Array(n); for (let i = 0; i < n; i++) areaOf[i] = ren.get(aOf[unitOf[i]])!;
    // nombre de un area insular: su region con mas carga, y "+N" si el grupo tiene mas
    const fixedNames: (string | null)[] = used.map(a => {
        if (a < K) return null;
        const carga = new Map<number, number>();
        for (let u = 0; u < U; u++) if (aOf[u] === a && uState[u] >= 0) carga.set(uState[u], (carga.get(uState[u]) ?? 0) + uw[u]);
        const orden = [...carga.entries()].sort((p, q) => q[1] - p[1] || p[0] - q[0]);
        return orden.length ? ADMIN1_NAMES[orden[0][0]] + (orden.length > 1 ? ` +${orden.length - 1}` : "") : null;
    });
    let num = 0;
    return { areaOf, names: used.map((a, j) => fixedNames[j] ?? `Area ${++num}`), fixedNames, units: U, extraPieces, postalIgnored, postalCoherence, postalSplit };
}
