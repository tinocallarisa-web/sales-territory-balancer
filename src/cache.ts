"use strict";

/**
 * RESULTADO GUARDADO EN EL NAVEGADOR (07-10-2026: "cambio de hoja y vuelvo, y me recalcula todo").
 * Power BI destruye el visual al salir de la pagina y descarta tambien el modulo, asi que la unica
 * forma de no recalcular al volver es el almacenamiento local de Power BI (IVisualLocalStorageV2Service,
 * privilegio LocalStorage). Microsoft lo presenta como una forma de mejorar el rendimiento; el
 * interruptor del administrador esta activado por defecto.
 *
 * Que se guarda: SOLO el numero de territorio de cada cliente (por posicion; los clientes
 * llegan siempre ordenados por Customer ID) y el resumen de areas y territorios. Ni coordenadas, ni
 * identificadores, ni nombres de cliente. Una sola entrada, que se sobrescribe, con una huella de los
 * datos y los parametros: si no coincide, no se usa. Comprimido con gzip del propio navegador.
 * Las cargas por cliente NO se guardan (con ellas, 40.000 clientes pasaban de 100 KB): se recalculan
 * al restaurar (clustering.cargasDesde); las horas por territorio y area si van en el resumen.
 *
 * Limites de la API: 100 KB por visual, sesion iniciada, se borra a los 29 dias, no disponible al
 * exportar a PDF/PowerPoint. Si algo falla o no cabe, se recalcula como siempre: es solo una cache.
 */

import type powerbi from "powerbi-visuals-api";
import type { AreaZoningResult, ClusterPoint, ZoningResult } from "./clustering";

const CLAVE = "stb-ultimo-resultado";
/** Ultimo estado de guardar/leer, para la marca de las builds de test (diagnostico en Desktop). */
export const diag = { guardar: "-", leer: "-" };
const MAX_BYTES = 95000;   // margen bajo los 100 KB

export interface Instantanea {
    huella: string;
    cid: Int16Array; outlier: Uint8Array;
    lastAreas: { res: AreaZoningResult; names: string[] } | null;
    lastResult: ZoningResult;
    lastOutliers: number; postalIgnored: boolean; postalFilterOk: boolean;
}

/** Huella corta (FNV-1a de 64 bits en dos mitades) de los datos + parametros. */
export function huella(texto: string): string {
    let h1 = 0x811c9dc5, h2 = 0x01000193 ^ texto.length;
    for (let i = 0; i < texto.length; i++) {
        const c = texto.charCodeAt(i);
        h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
        h2 = Math.imul(h2 ^ c, 0x5bd1e995) >>> 0;
    }
    return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/**
 * ORDEN GEOGRAFICO (curva de Morton sobre lat/lon cuantizadas a 16 bits): los territorios son
 * compactos, asi que en este orden clientes consecutivos comparten territorio y salen rachas que
 * gzip comprime muchisimo. En orden de Customer ID los numeros eran aleatorios: 41.260 clientes
 * ocupaban 83.000 caracteres y Power BI rechazaba el guardado (07-10-2026). Se recalcula igual al
 * restaurar, porque depende solo de las coordenadas.
 */
function ordenGeografico(points: ClusterPoint[]): Uint32Array {
    let la0 = 90, la1 = -90, lo0 = 180, lo1 = -180;
    for (const p of points) { if (p.lat < la0) la0 = p.lat; if (p.lat > la1) la1 = p.lat; if (p.lon < lo0) lo0 = p.lon; if (p.lon > lo1) lo1 = p.lon; }
    const sx = 65535 / Math.max(1e-9, lo1 - lo0), sy = 65535 / Math.max(1e-9, la1 - la0);
    const expandir = (v: number): number => { v &= 0xffff; v = (v | (v << 8)) & 0x00ff00ff; v = (v | (v << 4)) & 0x0f0f0f0f; v = (v | (v << 2)) & 0x33333333; v = (v | (v << 1)) & 0x55555555; return v >>> 0; };
    const clave = new Float64Array(points.length);
    points.forEach((p, i) => { clave[i] = (expandir(Math.round((p.lon - lo0) * sx)) | (expandir(Math.round((p.lat - la0) * sy)) << 1)) >>> 0; });
    return Uint32Array.from(points.map((_, i) => i)).sort((a, b) => clave[a] - clave[b] || a - b);
}

export function capturar(h: string, points: ClusterPoint[], lastAreas: Instantanea["lastAreas"], lastResult: ZoningResult,
                         lastOutliers: number, postalIgnored: boolean, postalFilterOk: boolean): Instantanea {
    return {
        huella: h,
        cid: (() => { const o = ordenGeografico(points); return Int16Array.from(o, i => points[i].clusterId); })(),   // en orden geografico
        outlier: Uint8Array.from(points, p => (p.outlier ? 1 : 0)),
        lastAreas, lastResult, lastOutliers, postalIgnored, postalFilterOk
    };
}

export function aplicar(s: Instantanea, points: ClusterPoint[]): void {
    const o = ordenGeografico(points);
    o.forEach((i, k) => { points[i].clusterId = s.cid[k]; });
    points.forEach((p, i) => { p.outlier = s.outlier[i] === 1; });
}

// ── serializacion ───────────────────────────────────────────────────────────────────────────
const aB64 = (u: Uint8Array): string => { let s = ""; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const deB64 = (s: string): Uint8Array => { const b = atob(s); const u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; };
const bytes = (a: Uint8Array): string => aB64(a);
// territorios en dos planos (bytes bajos, luego altos): los altos casi siempre son 0-2 y gzip los
// reduce a nada; intercalados, un Int16 aleatorio comprimia mal (40.000 clientes no cabian)
const planos = (c: Int16Array): Uint8Array => { const n = c.length, o = new Uint8Array(2 * n); for (let i = 0; i < n; i++) { const v = c[i] & 0xffff; o[i] = v & 0xff; o[n + i] = v >> 8; } return o; };
const dePlanos = (b: Uint8Array): Int16Array => { const n = b.length / 2, c = new Int16Array(n); for (let i = 0; i < n; i++) c[i] = ((b[n + i] << 8) | b[i]) << 16 >> 16; return c; };
const arr = (a: ArrayLike<number>): number[] => Array.from(a, v => Math.round(v * 1000) / 1000);

function resumen(r: ZoningResult): unknown {
    const a = r as AreaZoningResult;
    return {
        // centros y horas en binario (Float32): en JSON eran ~20.000 caracteres con 700 territorios
        k: r.k, cz: aB64(new Uint8Array(Float32Array.from(r.centers.flatMap(c => [c.lat, c.lon]).concat(Array.from(r.zoneHours))).buffer)),
        withinTolerance: r.withinTolerance, travelShare: r.travelShare, outOfBand: r.outOfBand, unresolved: r.unresolved, unassigned: r.unassigned,
        areaOfTerritory: a.areaOfTerritory ? Array.from(a.areaOfTerritory) : undefined, areaHours: a.areaHours ? arr(a.areaHours) : undefined,
        areaTerritories: a.areaTerritories ? Array.from(a.areaTerritories) : undefined, nAreas: a.nAreas
    };
}
function deResumen(o: any): ZoningResult {
    const r: any = {
        k: o.k,
        withinTolerance: o.withinTolerance, travelShare: o.travelShare, outOfBand: o.outOfBand, unresolved: o.unresolved, unassigned: o.unassigned
    };
    const czB = deB64(o.cz), cz = new Float32Array(czB.buffer, czB.byteOffset, czB.byteLength / 4);
    r.centers = Array.from({ length: o.k }, (_, i) => ({ lat: cz[2 * i], lon: cz[2 * i + 1] }));
    r.zoneHours = Float64Array.from(cz.subarray(2 * o.k, 3 * o.k));
    if (o.areaOfTerritory) { r.areaOfTerritory = Int32Array.from(o.areaOfTerritory); r.areaHours = Float64Array.from(o.areaHours); r.areaTerritories = Int32Array.from(o.areaTerritories); r.nAreas = o.nAreas; }
    return r as ZoningResult;
}

async function gzip(texto: string): Promise<Uint8Array> {
    const datos = new TextEncoder().encode(texto);
    const CS = (globalThis as any).CompressionStream;
    if (!CS) throw new Error("no gzip");
    const flujo = new Blob([datos]).stream().pipeThrough(new CS("gzip"));
    return new Uint8Array(await new Response(flujo).arrayBuffer());
}
async function gunzip(datos: Uint8Array): Promise<string> {
    const DS = (globalThis as any).DecompressionStream;
    if (!DS) throw new Error("no gzip");
    const flujo = new Blob([datos]).stream().pipeThrough(new DS("gzip"));
    return new TextDecoder().decode(await new Response(flujo).arrayBuffer());
}

/** Guarda la instantanea si la API esta permitida y cabe. Nunca lanza. */
export async function guardar(svc: powerbi.extensibility.IVisualLocalStorageV2Service | undefined, s: Instantanea): Promise<void> {
    try {
        if (!svc) { diag.guardar = "sin servicio"; return; }
        const st = (await svc.status()) as unknown as number;
        if (st !== 0 /* PrivilegeStatus.Allowed (const enum) */) { diag.guardar = "status " + st; return; }
        const json = JSON.stringify({
            v: 5, huella: s.huella, n: s.cid.length, cid: bytes(planos(s.cid)), outlier: bytes(s.outlier),
            names: s.lastAreas ? s.lastAreas.names : null, res: resumen(s.lastResult),
            lastOutliers: s.lastOutliers, postalIgnored: s.postalIgnored, postalFilterOk: s.postalFilterOk
        });
        const z = aB64(await gzip(json));
        if (z.length > MAX_BYTES) { diag.guardar = "no cabe " + z.length; return; }
        // Power BI parece sumar lo ya guardado al comprobar los 100 KB: con un resultado anterior de
        // 60.000 caracteres, uno nuevo de 82.800 se rechazaba ("set fallo", 07-10-2026). Se borra antes.
        try { svc.remove(CLAVE); } catch { /* nada guardado */ }
        const r = await svc.set(CLAVE, z);
        diag.guardar = (r && r.success ? "ok " : "set fallo ") + z.length + " n=" + s.cid.length + " h=" + s.huella.slice(0, 6);
    } catch (e) { diag.guardar = "error " + String(e).slice(0, 40); /* solo es una cache */ }
}

/** Devuelve la instantanea guardada si coincide la huella y el numero de clientes; si no, null. Nunca lanza. */
export async function leer(svc: powerbi.extensibility.IVisualLocalStorageV2Service | undefined, h: string, n: number): Promise<Instantanea | null> {
    try {
        if (!svc) { diag.leer = "sin servicio"; return null; }
        const st = (await svc.status()) as unknown as number;
        if (st !== 0 /* PrivilegeStatus.Allowed (const enum) */) { diag.leer = "status " + st; return null; }
        let crudo: string;
        try { crudo = await svc.get(CLAVE); } catch (e) { diag.leer = "get vacio/error"; return null; }
        const o = JSON.parse(await gunzip(deB64(crudo)));
        if (o.v !== 5 || o.huella !== h || o.n !== n) { diag.leer = `no coincide (h ${String(o.huella).slice(0, 6)} vs ${h.slice(0, 6)}, n ${o.n} vs ${n})`; return null; }
        diag.leer = "acierto";
        const cidB = deB64(o.cid);
        const res = deResumen(o.res);
        return {
            huella: h,
            cid: dePlanos(cidB),
            outlier: deB64(o.outlier),
            lastAreas: o.names ? { res: res as AreaZoningResult, names: o.names } : null,
            lastResult: res, lastOutliers: o.lastOutliers, postalIgnored: o.postalIgnored, postalFilterOk: o.postalFilterOk
        };
    } catch (e) { diag.leer = "error " + String(e).slice(0, 40); return null; }
}
