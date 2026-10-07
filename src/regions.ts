"use strict";

/**
 * ESTADO / PROVINCIA DE CADA PUNTO, con los contornos embebidos (src/outlines.ts). Sirve para
 * que las areas automaticas solo unan regiones con frontera terrestre comun: sin esto, el
 * k-medias en linea recta juntaba Baja California Sur con Sinaloa cruzando el Golfo de
 * California (06-10-2026). Sin red: todo esta en el paquete.
 *
 * Los anillos estan simplificados (~2-5 km): un punto en la costa o pegado a una frontera puede
 * caer fuera de todos (-1) o en el vecino. Ninguna de las dos cosas rompe nada: -1 no restringe
 * y el vecino es, por definicion, contiguo.
 */

import { ADMIN1_NEIGHBOURS, ADMIN1_RING_LAND, ADMIN1_RING_STATE, OUTLINE_ADMIN1 } from "./outlines";

interface RingBox { r: number[]; s: number; l: number; x0: number; x1: number; y0: number; y1: number; }
let boxes: RingBox[] | null = null;

function ringBoxes(): RingBox[] {
    if (boxes) return boxes;
    boxes = OUTLINE_ADMIN1.map((r, k) => {
        let x0 = 180, x1 = -180, y0 = 90, y1 = -90;
        for (let i = 0; i < r.length; i += 2) { const x = r[i], y = r[i + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        return { r, s: ADMIN1_RING_STATE[k], l: ADMIN1_RING_LAND[k], x0, x1, y0, y1 };
    });
    return boxes;
}

function inRing(lon: number, lat: number, r: number[]): boolean {
    let inside = false;
    for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
        const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
        if ((yi > lat) !== (yj > lat) && lon < xi + (lat - yi) * (xj - xi) / (yj - yi)) inside = !inside;
    }
    return inside;
}

/** Indice de estado (ADMIN1_NAMES) de cada punto, o -1 si no cae en ninguno. */
export function statesOfPoints(points: { lat: number; lon: number }[]): Int32Array {
    return regionsOfPoints(points).state;
}

/**
 * Estado y MASA DE TIERRA de cada punto. La masa de tierra (ADMIN1_RING_LAND) separa islas de
 * una misma provincia: Gran Canaria, Lanzarote y Fuerteventura son Las Palmas, pero tres masas.
 */
export function regionsOfPoints(points: { lat: number; lon: number }[]): { state: Int32Array; land: Int32Array } {
    const out = new Int32Array(points.length).fill(-1), land = new Int32Array(points.length).fill(-1);
    if (!points.length) return { state: out, land };
    // solo los anillos que tocan la caja de los datos, y una rejilla de 1 grado sobre ellos
    let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
    for (const p of points) { if (p.lat < la0) la0 = p.lat; if (p.lat > la1) la1 = p.lat; if (p.lon < lo0) lo0 = p.lon; if (p.lon > lo1) lo1 = p.lon; }
    const cand = ringBoxes().filter(b => b.x1 >= lo0 && b.x0 <= lo1 && b.y1 >= la0 && b.y0 <= la1);
    const gx0 = Math.floor(lo0), gy0 = Math.floor(la0);
    const W = Math.floor(lo1) - gx0 + 1, H = Math.floor(la1) - gy0 + 1;
    const grid: RingBox[][] = Array.from({ length: W * H }, () => []);
    for (const b of cand) {
        for (let gx = Math.max(0, Math.floor(b.x0) - gx0); gx <= Math.min(W - 1, Math.floor(b.x1) - gx0); gx++)
            for (let gy = Math.max(0, Math.floor(b.y0) - gy0); gy <= Math.min(H - 1, Math.floor(b.y1) - gy0); gy++) grid[gy * W + gx].push(b);
    }
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        const cell = grid[(Math.floor(p.lat) - gy0) * W + (Math.floor(p.lon) - gx0)];
        for (const b of cell) {
            if (p.lon < b.x0 || p.lon > b.x1 || p.lat < b.y0 || p.lat > b.y1) continue;
            if (inRing(p.lon, p.lat, b.r)) { out[i] = b.s; land[i] = b.l; break; }
        }
    }
    // los que caen fuera (costa recortada por la simplificacion) toman el estado del punto con
    // estado mas cercano. Dejarlos en -1 no era inocuo: -1 no restringe, y unos pocos puntos de
    // costa sin estado hacian de puente sobre el Golfo de California.
    const sin: number[] = [], con: number[] = [];
    for (let i = 0; i < points.length; i++) (out[i] < 0 ? sin : con).push(i);
    if (sin.length && con.length) {
        const kx = Math.cos(((la0 + la1) / 2) * Math.PI / 180);
        const C = 0.25, cols = Math.max(1, Math.ceil((lo1 - lo0) / C) + 1), rows = Math.max(1, Math.ceil((la1 - la0) / C) + 1);
        const g = new Map<number, number[]>();
        for (const j of con) { const k = Math.floor((points[j].lat - la0) / C) * cols + Math.floor((points[j].lon - lo0) / C); const a = g.get(k); if (a) a.push(j); else g.set(k, [j]); }
        for (const i of sin) {
            const p = points[i], cy = Math.floor((p.lat - la0) / C), cx = Math.floor((p.lon - lo0) / C);
            let best = -1, bd = Infinity;
            for (let ring = 0; ring <= Math.max(cols, rows) && (best < 0 || (ring - 1) * C * Math.min(1, kx) <= Math.sqrt(bd)); ring++) {
                for (let y = cy - ring; y <= cy + ring; y++) for (let x = cx - ring; x <= cx + ring; x++) {
                    if (Math.max(Math.abs(y - cy), Math.abs(x - cx)) !== ring || x < 0 || y < 0 || x >= cols || y >= rows) continue;
                    const a = g.get(y * cols + x); if (!a) continue;
                    for (const j of a) { const dx = (points[j].lon - p.lon) * kx, dy = points[j].lat - p.lat, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = j; } }
                }
            }
            if (best >= 0) { out[i] = out[best]; land[i] = land[best]; }
        }
    }
    return { state: out, land };
}

/**
 * GRUPO DE TIERRA de cada estado: componente conexa del grafo de fronteras terrestres del mundo
 * entero. La peninsula Iberica, Francia y el resto de Europa son un grupo; Baleares, cada
 * provincia canaria, Sicilia (varias provincias que se tocan), Cerdena, Creta, Azores o Hawai
 * son otros. Alaska no: llega a Washington por tierra a traves de Canada.
 */
let comps: Int32Array | null = null;
export function landGroup(s: number): number {
    if (s < 0) return -1;
    if (!comps) {
        const n = ADMIN1_NEIGHBOURS.length;
        comps = new Int32Array(n).fill(-1);
        let c = 0;
        for (let i = 0; i < n; i++) {
            if (comps[i] >= 0) continue;
            const q = [i]; comps[i] = c;
            for (let h = 0; h < q.length; h++) for (const j of ADMIN1_NEIGHBOURS[q[h]]) if (comps[j] < 0) { comps[j] = c; q.push(j); }
            c++;
        }
    }
    return comps[s];
}

/** true si los dos estados son el mismo o tienen frontera terrestre comun; -1 no restringe. */
export function statesTouch(a: number, b: number): boolean {
    if (a < 0 || b < 0 || a === b) return true;
    return ADMIN1_NEIGHBOURS[a].indexOf(b) >= 0;
}
