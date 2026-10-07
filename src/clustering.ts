"use strict";

/**
 * Territorios de venta por carga de trabajo. Especificacion completa, con referencias a linea,
 * en notes/especificacion-algoritmo.md; explicacion para usuarios en docs/methodology.html.
 *
 * Cada territorio es el mes de UN comercial: su carga (visitas + desplazamiento) no pasa de las
 * horas de la barra (tope duro). El numero de territorios no se pide: sale de la carga.
 *
 * CAMINO DE PRODUCCION (el visual llama con growthOnly = true y tolerance = 0):
 *   1. Carga y desplazamiento por cliente (aproximacion continua de rutas: salto a los 3 vecinos
 *      mas cercanos + viaje diario a la base repartido entre las visitas del dia).
 *   2. Pueblos: grupos densos de clientes. El que no cabe en un comercial se parte (diagrama de
 *      potencia sobre ese pueblo; partes que aun se pasan, biseccion por el eje principal).
 *   3. Clientes de campo a la semilla de pueblo mas cercana con hueco.
 *   4. Lo que queda: diagrama de potencia con ascenso dual (cada zona lleva un sesgo w; cada
 *      cliente va a la que minimiza d^2 + w; la que se pasa sube su sesgo), sembrado por
 *      crecimiento desde el foco mas denso, alternado con Lloyd, y reparacion local por voto de
 *      los 10 vecinos (drain).
 *   5. Posproceso: reclamar clientes hacia centros mas cercanos (directo o en cadena), seguridad
 *      del tope, fusion de zonas cortas. Los restos que no caben en nadie quedan como TERRITORIO
 *      PARCIAL: toda la carga cuenta en los comerciales necesarios.
 *
 * La rama sin growthOnly (rondas de Lloyd + reparacion de banda +/-tolerancia) solo se usa hoy
 * dentro de las subllamadas de los pasos 2 y 4.
 *
 * Origen: version O(n^2) con haversine (22 s solo en la matriz de vecinos con 30.000 filas);
 * aqui cada punto mira a sus ~30 centros mas cercanos con una rejilla espacial. Mediciones de
 * la version Python de referencia en test_visuales/zonificar.py (28-09-2026).
 */

export interface ClusterPoint {
    customerId: string;
    lat: number;
    lon: number;
    /** Peso del punto en HORAS de visita al mes. Si hay visitas y minutos, se recalcula. */
    value: number;
    /** Visitas al mes (opcional; si falta, 1). */
    visits?: number;
    /** Minutos por visita (opcional; si falta, value*60 es todo el tiempo de visita). */
    minutes?: number;
    /** Carga efectiva asignada, en minutos/mes, INCLUIDO el desplazamiento. Sale del calculo. */
    load?: number;
    /** Area comercial del pozo Area (opcional). */
    area?: string;
    /** Codigo postal (opcional): las areas se construyen siempre con codigos postales enteros. */
    postal?: string;
    /** Valores del pozo Tooltips, ya formateados. */
    tips?: { name: string; value: string }[];
    /** Velocidad media en km/h alrededor de ESTE punto (opcional: urbano 25, rural 70...). Sin ella, la de la barra. */
    speedKmh?: number;
    /** Fila del dataView de origen (para la seleccion de Power BI). */
    rowIndex?: number;
    /** Marcado como outlier (demasiado lejos de cualquier otro cliente): fuera del reparto. */
    outlier?: boolean;
    clusterId: number; // -1 = sin asignar
}

export interface ZoningOptions {
    /** Horas utiles al mes por comercial: el TAMANO del cluster. */
    capacityHours: number;
    /** Tolerancia sobre la capacidad, 0.10 = +/-10%. */
    tolerance: number;
    /** km/h medios, para convertir distancia en tiempo. */
    speedKmh: number;
    /** Factor carretera sobre linea recta: 1.3 = un 30% mas que en linea recta. */
    detour: number;
    /**
     * Dias laborables al mes (20 por defecto): jornada = capacidad / dias. De ahi salen las
     * visitas por dia que reparten el viaje diario a la base (ver DESPLAZAMIENTO).
     */
    workDays?: number;
    /**
     * OBSOLETO desde el 06-10-2026 en clusterPoints (modelo de rutas continuo). Solo lo leen los
     * modulos experimentales que el visual no usa (basicareas, contiguity, pmedian).
     */
    routeFactor?: number;
    /** Vueltas externas (ajuste de k e intercambio). 5 en referencia; 3 para interactivo. */
    rounds?: number;
    /** Pasos de Lloyd por vuelta. 12 en referencia: es la palanca principal. */
    lloydSteps?: number;
    /** Iteraciones del bucle de sesgos por paso de Lloyd. */
    biasSteps?: number;
    /** Tope del sesgo en radios^2 de zona, para zonas con puntos. */
    biasCap?: number;
    /** Semilla del generador: mismos datos + misma semilla = mismas zonas. */
    seed?: number;
    /**
     * Fraccion de la tolerancia que se deja de holgura POR DEBAJO de la capacidad. Con
     * k = total/capacidad la media cae exactamente en la capacidad, la mitad de las zonas
     * nacen por encima y no hay sitio para redondear los puntos de frontera (hasta k-1
     * puntos partidos, Brieden-Gritzmann-Klemm 2017). Con 0,5 y +/-10% se apunta al 95%:
     * cada zona tiene 5% hacia abajo y 15% hacia arriba, que es el lado por el que fallan.
     */
    margin?: number;
    /** Pasadas de la reparacion final que deja TODAS las zonas dentro de la banda. 0 la anula. */
    repairPasses?: number;
    /** true = quedarse con el reparto del crecimiento (del denso al disperso) sin reequilibrar. */
    growthOnly?: boolean;
    /** true = sin deteccion de pueblos (solo crecimiento desde los focos). */
    noTowns?: boolean;
    /** Como se parte un pueblo en comerciales: "power" (diagrama, por defecto) o "bisect". */
    townSplit?: "power" | "bisect";
    /** Radio maximo de una zona en el crecimiento (km). Sin el (o <= 0): 100 km. El visual pasa 1e6 (sin radio). */
    outlierKm?: number;
    /** Centros vecinos que cuentan como "frontera" en la reparacion. 12 por defecto; menos = mas estricto. */
    repairNeighbours?: number;
    /**
     * Holgura EXTRA de banda que se acepta para quitar una isla (fraccion de la capacidad).
     * 0 por defecto = banda exacta. Se probo 0,05 y se retiro con numeros (29-09-2026):
     * en EE. UU. costaba 157 zonas fuera de banda (frente a 3) para bajar las islas del
     * 5,1% al 4,6%; en Espana, 93 frente a 2. Las islas se mueven o intercambian solo
     * cuando cabe en la banda.
     */
    islandSlack?: number;
}

export interface ZoningResult {
    /** Numero de zonas resultante (= comerciales necesarios). */
    k: number;
    /** Centro de cada zona, en lat/lon. */
    centers: { lat: number; lon: number }[];
    /** Carga por zona en horas/mes, desplazamiento incluido. */
    zoneHours: Float64Array;
    /** Fraccion de zonas dentro de la banda de tolerancia. */
    withinTolerance: number;
    /** Fraccion de las horas totales que es desplazamiento. */
    travelShare: number;
    /** Zonas que la reparacion no ha podido meter en la banda (0 = equilibrio completo). */
    outOfBand: number;
    /** Clientes para los que aun existe un movimiento de mejora (debe ser 0: optimo local verificado). */
    unresolved: number;
    /** Clientes SIN territorio: ninguna zona con hueco a su alcance (mas lejos que el radio maximo). */
    unassigned: number;
}

/** Haversine en km. Se conserva para quien la use fuera; el algoritmo trabaja proyectado. */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6371;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const sinDLat = Math.sin(dLat / 2);
    const sinDLon = Math.sin(dLon / 2);
    const a = sinDLat * sinDLat +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * sinDLon * sinDLon;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const R_TIERRA = 6371;

/** Generador determinista (mulberry32). Math.random cambiaria las zonas en cada refresco y
 *  nadie se fia de un reparto que se mueve solo. */
function prng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/** Eleccion ponderada por un array de pesos (no normalizado). */
function pickWeighted(weights: Float64Array, total: number, rnd: () => number): number {
    let u = rnd() * total;
    for (let i = 0; i < weights.length; i++) {
        u -= weights[i];
        if (u <= 0) return i;
    }
    return weights.length - 1;
}

/**
 * Rejilla espacial sobre los CENTROS. Para cada punto devuelve los V centros mas cercanos
 * mirando solo las celdas vecinas: esto es lo que convierte O(n*k) en O(n*V).
 */
class CenterGrid {
    private cell: number;
    private minX: number;
    private minY: number;
    private cols: number;
    private rows: number;
    private buckets: Int32Array[];

    constructor(cx: Float64Array, cy: Float64Array, k: number, areaKm2: number) {
        // celda ~ tamano de zona: en una vecindad 3x3 caben, de media, ~9 centros
        this.cell = Math.max(0.5, Math.sqrt(areaKm2 / Math.max(k, 1)));
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let c = 0; c < k; c++) {
            if (cx[c] < minX) minX = cx[c]; if (cx[c] > maxX) maxX = cx[c];
            if (cy[c] < minY) minY = cy[c]; if (cy[c] > maxY) maxY = cy[c];
        }
        this.minX = minX; this.minY = minY;
        this.cols = Math.max(1, Math.floor((maxX - minX) / this.cell) + 1);
        this.rows = Math.max(1, Math.floor((maxY - minY) / this.cell) + 1);
        const counts = new Int32Array(this.cols * this.rows);
        const idx = new Int32Array(k);
        for (let c = 0; c < k; c++) {
            const b = this.bucketOf(cx[c], cy[c]);
            idx[c] = b; counts[b]++;
        }
        this.buckets = new Array(this.cols * this.rows);
        for (let b = 0; b < counts.length; b++) this.buckets[b] = new Int32Array(counts[b]);
        counts.fill(0);
        for (let c = 0; c < k; c++) {
            const b = idx[c];
            this.buckets[b][counts[b]++] = c;
        }
    }

    private bucketOf(x: number, y: number): number {
        const i = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
        const j = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)));
        return j * this.cols + i;
    }

    /**
     * Los V centros mas cercanos a (x, y). Se amplia el anillo de celdas hasta reunir al
     * menos V candidatos y un anillo mas, para que ninguno mas cercano quede fuera.
     */
    nearest(x: number, y: number, cx: Float64Array, cy: Float64Array, V: number,
            outIdx: Int32Array, outD2: Float64Array): number {
        const i0 = Math.min(this.cols - 1, Math.max(0, Math.floor((x - this.minX) / this.cell)));
        const j0 = Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cell)));
        let found = 0;
        const maxRing = Math.max(this.cols, this.rows);
        let ring = 0;
        let ringsSinceEnough = 0;
        // candidatos provisionales: se insertan ordenados por d2 (V es pequeno, insercion vale)
        while (ring <= maxRing) {
            for (let j = j0 - ring; j <= j0 + ring; j++) {
                if (j < 0 || j >= this.rows) continue;
                for (let i = i0 - ring; i <= i0 + ring; i++) {
                    if (i < 0 || i >= this.cols) continue;
                    if (ring > 0 && Math.abs(i - i0) !== ring && Math.abs(j - j0) !== ring) continue;
                    const b = this.buckets[j * this.cols + i];
                    for (let t = 0; t < b.length; t++) {
                        const c = b[t];
                        const dx = cx[c] - x, dy = cy[c] - y;
                        const d2 = dx * dx + dy * dy;
                        if (found < V) {
                            let p = found++;
                            while (p > 0 && outD2[p - 1] > d2) { outD2[p] = outD2[p - 1]; outIdx[p] = outIdx[p - 1]; p--; }
                            outD2[p] = d2; outIdx[p] = c;
                        } else if (d2 < outD2[V - 1]) {
                            let p = V - 1;
                            while (p > 0 && outD2[p - 1] > d2) { outD2[p] = outD2[p - 1]; outIdx[p] = outIdx[p - 1]; p--; }
                            outD2[p] = d2; outIdx[p] = c;
                        }
                    }
                }
            }
            if (found >= V) {
                ringsSinceEnough++;
                if (ringsSinceEnough >= 2) break;   // un anillo extra de margen
            }
            ring++;
        }
        return found;
    }
}

/**
 * El reparto. Escribe clusterId y load en cada punto y devuelve el resumen.
 */
export function clusterPoints(points: ClusterPoint[], opt: ZoningOptions): ZoningResult {
    const n = points.length;
    const empty: ZoningResult = { k: 0, centers: [], zoneHours: new Float64Array(0), withinTolerance: 0, travelShare: 0, outOfBand: 0, unresolved: 0, unassigned: 0 };
    if (n === 0) return empty;

    const rounds = opt.rounds ?? 12;
    void rounds;
    const lloydSteps = opt.lloydSteps ?? 12;
    const biasSteps = opt.biasSteps ?? 150;
    const biasCap = opt.biasCap ?? 20;
    const rnd = prng((opt.seed ?? 20260928) ^ n);
    const capMin = opt.capacityHours * 60;          // trabajamos en minutos
    const tol = opt.tolerance;
    // el ascenso dual apunta por debajo de la capacidad; la BANDA sigue siendo la del usuario
    const target = capMin * (1 - (opt.margin ?? 0.5) * tol);
    const V = 30;

    // --- proyeccion a km planos (equirectangular centrada: error de decimas de % a escala
    //     de un pais, irrelevante frente al factor de rodeo) ------------------------------
    let latMean = 0;
    for (const p of points) latMean += p.lat;
    latMean /= n;
    const kx = (Math.PI / 180) * R_TIERRA * Math.cos(latMean * Math.PI / 180);
    const ky = (Math.PI / 180) * R_TIERRA;
    const x = new Float64Array(n), y = new Float64Array(n);
    const visits = new Float64Array(n), minutes = new Float64Array(n);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) {
        const p = points[i];
        x[i] = p.lon * kx; y[i] = p.lat * ky;
        if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i];
        if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i];
        // Peso: si vienen visitas y minutos, mandan; si no, value son horas de visita al mes
        // y se asume una visita (el desplazamiento se cuenta una vez).
        const v = p.visits != null && p.visits > 0 ? p.visits : 1;
        const m = p.minutes != null && p.minutes > 0 ? p.minutes : (p.value * 60) / v;
        visits[i] = v; minutes[i] = m;
    }
    const areaKm2 = Math.max(1, (maxX - minX) * (maxY - minY));
    const visitLoad = new Float64Array(n);
    let totalVisit = 0;
    for (let i = 0; i < n; i++) { visitLoad[i] = visits[i] * minutes[i]; totalVisit += visitLoad[i]; }
    // --- DESPLAZAMIENTO: aproximacion continua de rutas (Beardwood-Halton-Hammersley 1959,
    //     Daganzo 1984). Antes se cobraba a CADA visita el viaje desde el centro, como si el
    //     comercial volviera a la base entre cliente y cliente: 10 clientes en una carretera
    //     pagaban 10 viajes en vez de uno. Medido el 04-10-2026: el doble de km por visita que
    //     el modelo de rutas y un 7-17% mas de comerciales. Ahora, por visita:
    //
    //       Road x ( salto al siguiente cliente  +  2 x d / visitas del dia ) / velocidad
    //
    //   - salto: media de la distancia a los 3 vecinos mas cercanos. En un reparto de Poisson
    //     vale 0,73/sqrt(densidad), y la constante de BHH para una ruta por esos clientes es
    //     0,71/sqrt(densidad): mismo orden, y medido sobre los datos, no supuesto.
    //   - visitas del dia: las que caben en una jornada (capacidad / dias laborables) con la
    //     visita media del vecindario del cliente. SALE DEL MES, no es un parametro: un
    //     territorio urbano de visitas cortas reparte el viaje entre 8, uno rural entre 3.
    //     (Sin el propio viaje en la estimacion: la sobreestima un poco; minimo 1.)
    //   - d: distancia al centro del territorio (la base), como siempre.
    // La velocidad es la del entorno del cliente si viene en el pozo Speed, si no la de la barra.
    const travelPerKm = new Float64Array(n), hopMin = new Float64Array(n);
    const minPerKm = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const s = points[i].speedKmh;
        minPerKm[i] = (opt.detour / (s != null && s > 0 ? s : opt.speedKmh)) * 60;
    }
    const dayMin = capMin / (opt.workDays != null && opt.workDays > 0 ? opt.workDays : 20);
    if (n > 1) {
        const K3 = Math.min(3, n - 1), nb3 = exactKnn(x, y, n, K3, areaKm2);
        for (let i = 0; i < n; i++) {
            let s = 0, c = 0;
            for (let q = 0; q < K3; q++) { const j = nb3[i * K3 + q]; if (j >= 0) { s += Math.hypot(x[i] - x[j], y[i] - y[j]); c++; } }
            hopMin[i] = c ? (s / c) * minPerKm[i] : 0;
        }
        const KV = Math.min(30, n - 1), nbV = exactKnn(x, y, n, KV, areaKm2);
        for (let i = 0; i < n; i++) {
            let sv = visits[i], sc = visits[i] * (minutes[i] + hopMin[i]);
            for (let q = 0; q < KV; q++) { const j = nbV[i * KV + q]; if (j >= 0) { sv += visits[j]; sc += visits[j] * (minutes[j] + hopMin[j]); } }
            const perDay = Math.max(1, dayMin / Math.max(1e-6, sc / sv));
            travelPerKm[i] = 2 * minPerKm[i] / perDay;
        }
    } else {
        travelPerKm[0] = 2 * minPerKm[0];
    }
    // el salto entra en la carga como tiempo fijo de la visita: visits*(minutes + d*travelPerKm)
    // sigue siendo la carga en todo el algoritmo. visitLoad (arriba) ya se calculo SIN el salto,
    // asi que travelShare cuenta salto + viaje.
    for (let i = 0; i < n; i++) minutes[i] += hopMin[i];

    // --- semillas por CRECIMIENTO desde los focos (regla del usuario, 30-09-2026) ---------
    // "Que se asigne a partir del centroide del grupo mayor": se ordenan los clientes por
    // densidad local; desde el mas denso sin asignar se toman los clientes mas cercanos, con
    // su viaje, hasta llenar un comercial (la capacidad nominal); lo que sobra queda para el
    // siguiente foco; y asi hasta acabar. Eso fija CUANTAS zonas hay y DONDE nacen, de los
    // concentrados a los dispersos. El diagrama de potencia solo afina despues las
    // fronteras entre ellas (celdas convexas), sin inventar centros. Con k-means++ el numero
    // de centros era globalmente correcto pero localmente no (Madison: 4 donde caben 3), y
    // lo que sobraba se quedaba como zona resto en el casco.
    const seeds: { x: number; y: number }[] = [];
    const growAsig = new Int32Array(n).fill(-1);
    const isTown = new Uint8Array(n);   // cliente de pueblo: su reparto no se toca despues
    let unassignedCount = 0;
    // radio maximo de una zona: Outlier km si el usuario lo da; si no, 100 km (medido en
    // EE. UU.: 60 km deja 165 sin territorio y 283 zonas cortas; 100 km, 23 y 176; 200 km, 0
    // y 114 pero con restos de 6 puntos a 200 km, que es justo lo que no queremos)
    const maxRadio = opt.outlierKm && opt.outlierKm > 0 ? opt.outlierKm : 100;
    {
        // densidad local: clientes en un radio ~ el de una zona media urbana (rejilla)
        const cell = Math.max(0.5, Math.sqrt(areaKm2 / Math.max(n, 1)) * 4);
        const cols = Math.max(1, Math.floor((maxX - minX) / cell) + 1), rows = Math.max(1, Math.floor((maxY - minY) / cell) + 1);
        const gcount = new Float64Array(cols * rows);
        const cellOf = (i: number): number => Math.min(rows - 1, Math.floor((y[i] - minY) / cell)) * cols + Math.min(cols - 1, Math.floor((x[i] - minX) / cell));
        for (let i = 0; i < n; i++) gcount[cellOf(i)] += visitLoad[i];
        const dens = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const a = Math.min(cols - 1, Math.floor((x[i] - minX) / cell)), b = Math.min(rows - 1, Math.floor((y[i] - minY) / cell));
            let s = 0;
            for (let db = -1; db <= 1; db++) for (let da = -1; da <= 1; da++) { const aa = a + da, bb = b + db; if (aa >= 0 && aa < cols && bb >= 0 && bb < rows) s += gcount[bb * cols + aa]; }
            dens[i] = s;
        }
        const order = Array.from({ length: n }, (_, i) => i).sort((p, q) => dens[q] - dens[p] || p - q);
        const taken = new Uint8Array(n);
        // ===== REGLA A (usuario, 30-09-2026): PUEBLOS ENTEROS PRIMERO =====================
        // Un pueblo = grupo continuo de clientes (enlace entre vecinos a menos de eps, con eps
        // = 2x la mediana de la distancia al 5o vecino). Si un pueblo da para mas de un
        // comercial, se parte en MITADES geograficas por biseccion recursiva a lo largo de su
        // eje principal, equilibrando carga: el borde va siempre con su pueblo. Antes se
        // llenaba el casco con lo mas cercano y los bordes de tres pueblos acababan juntos en
        // un comercial "de carretera" que se mezclaba con los cascos. Lo que no es pueblo
        // (grupos de menos de medio comercial) sigue con el crecimiento de abajo.
        if (!opt.noTowns) {
            const K5 = 10;
            const nbT = exactKnn(x, y, n, K5, areaKm2);
            const d5: number[] = [];
            for (let i = 0; i < n; i++) { const j = nbT[i * K5 + 4]; if (j >= 0) d5.push(Math.hypot(x[j] - x[i], y[j] - y[i])); }
            d5.sort((p, q) => p - q);
            const eps = 2 * (d5.length ? d5[Math.floor(d5.length / 2)] : 1);
            // union-find sobre vecinos a menos de eps
            const par = new Int32Array(n); for (let i = 0; i < n; i++) par[i] = i;
            const find = (i: number): number => { while (par[i] !== i) { par[i] = par[par[i]]; i = par[i]; } return i; };
            for (let i = 0; i < n; i++) for (let s = 0; s < K5; s++) {
                const j = nbT[i * K5 + s]; if (j < 0) continue;
                if (Math.hypot(x[j] - x[i], y[j] - y[i]) > eps) break;
                const a1 = find(i), b1 = find(j); if (a1 !== b1) par[a1] = b1;
            }
            const comps = new Map<number, number[]>();
            for (let i = 0; i < n; i++) { const r0 = find(i); let arr = comps.get(r0); if (!arr) { arr = []; comps.set(r0, arr); } arr.push(i); }
            const loadAt = (ids: number[]): { L: number; gx: number; gy: number } => {
                let sw = 0, sx = 0, sy = 0;
                for (const i of ids) { const w = visits[i] * minutes[i] + 1e-9; sw += w; sx += x[i] * w; sy += y[i] * w; }
                const gx = sx / sw, gy = sy / sw;
                let L = 0; for (const i of ids) L += visits[i] * (minutes[i] + Math.hypot(x[i] - gx, y[i] - gy) * travelPerKm[i]);
                return { L, gx, gy };
            };
            const capT = capMin * (1 + tol) * 0.97;
            const parts: number[][] = [];
            // biseccion recursiva equilibrada; si una parte sigue sobre el tope, se parte otra vez
            const split = (ids: number[], m: number, depth: number): void => {
                if (m <= 1 || ids.length < 2 || depth > 12) {
                    if (ids.length >= 2 && depth <= 12 && loadAt(ids).L > capT) { split(ids, 2, depth + 1); return; }
                    parts.push(ids); return;
                }
                const { gx, gy } = loadAt(ids);
                let sxx = 0, sxy = 0, syy = 0, sw = 0;
                for (const i of ids) { const w = visits[i] * minutes[i] + 1e-9, dx = x[i] - gx, dy = y[i] - gy; sxx += w * dx * dx; sxy += w * dx * dy; syy += w * dy * dy; sw += w; }
                const tr = sxx + syy, det = sxx * syy - sxy * sxy, l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
                let ax = sxy, ay = l1 - sxx; if (Math.abs(ax) + Math.abs(ay) < 1e-12) { ax = 1; ay = 0; }
                const proj = ids.map(i => ({ i, p: (x[i] - gx) * ax + (y[i] - gy) * ay, w: visits[i] * (minutes[i] + Math.hypot(x[i] - gx, y[i] - gy) * travelPerKm[i] / m) }));
                proj.sort((p, q) => p.p - q.p || p.i - q.i);
                const m1 = Math.floor(m / 2); let total = 0; for (const e of proj) total += e.w;
                const objetivo = total * m1 / m; let acc = 0, cut = 0;
                for (; cut < proj.length - 1; cut++) { acc += proj[cut].w; if (acc >= objetivo) { cut++; break; } }
                cut = Math.max(1, Math.min(proj.length - 1, cut));
                split(proj.slice(0, cut).map(e => e.i), m1, depth + 1);
                split(proj.slice(cut).map(e => e.i), m - m1, depth + 1);
            };
            const keys = [...comps.keys()].sort((p, q) => p - q);
            for (const key of keys) {
                const ids = comps.get(key)!;
                const { L } = loadAt(ids);
                if (L < capMin * 0.5) continue;                     // no es pueblo: crecimiento
                const mTown = Math.max(1, Math.ceil(L / capT));
                if (mTown === 1 || opt.townSplit === "bisect") { split(ids, mTown, 0); continue; }
                // Dentro del pueblo, DIAGRAMA DE POTENCIA con sus comerciales: celdas convexas y
                // equilibradas. (La biseccion por eje dejaba partes no contiguas en pueblos
                // irregulares: 14% de mezcla. El diagrama vaciaba cascos solo cuando se aplicaba
                // a todo el mapa a la vez, pueblos y campo mezclados.)
                const sub: ClusterPoint[] = ids.map(i => ({ ...points[i], clusterId: -1 }));
                const rs = clusterPoints(sub, { ...opt, growthOnly: false, noTowns: true, rounds: 6, outlierKm: 0, seed: (opt.seed ?? 20260928) ^ (key * 2654435761 >>> 0) });
                const byZone = new Map<number, number[]>();
                for (let q = 0; q < ids.length; q++) { const z = sub[q].clusterId; if (z < 0) continue; let arr = byZone.get(z); if (!arr) { arr = []; byZone.set(z, arr); } arr.push(ids[q]); }
                for (const zk of [...byZone.keys()].sort((p, q) => p - q)) parts.push(byZone.get(zk)!);
                void rs;
            }
            // toda parte que, medida con su propio centro, pase del tope, se biseca (regla dura)
            const hiT = capMin * (1 + tol);
            const fitOrSplit = (pt: number[]): void => { if (pt.length >= 2 && loadAt(pt).L > hiT) split(pt, 2, 0); else parts.push(pt); };
            { const orig = parts.splice(0); for (const pt of orig) fitOrSplit(pt); }
            const partLoad: number[] = [];
            for (const part of parts) {
                const sid = seeds.length;
                let sx = 0, sy = 0, sw = 0;
                for (const i of part) { taken[i] = 1; isTown[i] = 1; growAsig[i] = sid; const w = visits[i] * minutes[i] + 1e-9; sx += x[i] * w; sy += y[i] * w; sw += w; }
                const gx = sx / sw, gy = sy / sw;
                seeds.push({ x: gx, y: gy });
                let L = 0; for (const i of part) L += visits[i] * (minutes[i] + Math.hypot(x[i] - gx, y[i] - gy) * travelPerKm[i]);
                partLoad.push(L);
            }
            // CAMPO (clientes que no son de ningun pueblo): (1) al comercial de pueblo mas
            // cercano que tenga hueco, del mas cercano al mas lejano; (2) lo que quede, con su
            // propio diagrama de potencia (celdas convexas entre ellos). Antes crecian desde el
            // resto mas denso y serpenteaban entre pueblos: 17-31% de mezcla en el campo.
            if (seeds.length > 0) {
                const rural: { i: number; s: number; d: number }[] = [];
                const sx = Float64Array.from(seeds.map(s => s.x)), sy = Float64Array.from(seeds.map(s => s.y));
                const g = new CenterGrid(sx, sy, seeds.length, areaKm2);
                const ti2 = new Int32Array(8), td2 = new Float64Array(8);
                for (let i = 0; i < n; i++) if (!taken[i]) { const m = g.nearest(x[i], y[i], sx, sy, 8, ti2, td2); if (m) rural.push({ i, s: ti2[0], d: Math.sqrt(td2[0]) }); }
                rural.sort((p, q) => p.d - q.d || p.i - q.i);
                for (const r0 of rural) {
                    const i = r0.i;
                    const m = g.nearest(x[i], y[i], sx, sy, 8, ti2, td2);
                    for (let q = 0; q < m; q++) {
                        const d = Math.sqrt(td2[q]); if (d > maxRadio) break;
                        const c = visits[i] * (minutes[i] + d * travelPerKm[i]);
                        if (partLoad[ti2[q]] + c <= capT) { partLoad[ti2[q]] += c; taken[i] = 1; growAsig[i] = ti2[q]; break; }
                    }
                }
            }
            {
                const left: number[] = []; for (let i = 0; i < n; i++) if (!taken[i]) left.push(i);
                if (left.length >= 2) {
                    const sub: ClusterPoint[] = left.map(i => ({ ...points[i], clusterId: -1 }));
                    clusterPoints(sub, { ...opt, growthOnly: false, noTowns: true, rounds: 6, outlierKm: 0, seed: (opt.seed ?? 20260928) ^ 0x5eed });
                    const byZone = new Map<number, number[]>();
                    for (let q = 0; q < left.length; q++) { const z = sub[q].clusterId; if (z < 0) continue; let arr = byZone.get(z); if (!arr) { arr = []; byZone.set(z, arr); } arr.push(left[q]); }
                    const before = parts.length;
                    for (const zk of [...byZone.keys()].sort((p, q) => p - q)) fitOrSplit(byZone.get(zk)!);
                    for (const part of parts.slice(before)) {
                        const sid = seeds.length;
                        let sx = 0, sy = 0, sw = 0;
                        for (const i of part) { taken[i] = 1; growAsig[i] = sid; const w = visits[i] * minutes[i] + 1e-9; sx += x[i] * w; sy += y[i] * w; sw += w; }
                        seeds.push({ x: sx / sw, y: sy / sw });
                    }
                }
            }
        }
        let ptr = 0;
        const fill = capMin;                     // llenar un comercial nominal (140 h)
        // radio maximo de una zona: maxRadio (outlierKm si se da; si no, 100 km)
            const d2s = new Float64Array(n), idx: number[] = [];
        while (true) {
            while (ptr < n && taken[order[ptr]]) ptr++;
            if (ptr >= n) break;
            const s = order[ptr];
            // candidatos: los no asignados, por distancia al foco
            idx.length = 0;
            for (let i = 0; i < n; i++) if (!taken[i]) { const dx = x[i] - x[s], dy = y[i] - y[s]; d2s[i] = dx * dx + dy * dy; idx.push(i); }
            idx.sort((p, q) => d2s[p] - d2s[q]);
            // el viaje se mide contra el CENTROIDE que se va formando (no contra el punto
            // semilla): un resto rural medido contra un centroide a 200 km daba zonas de 516 h.
            // Y no se coge un punto que este a mas de maxRadio del centroide: eso es un
            // outlier, no un cliente de esta zona.
            let acc = 0, sx = 0, sy = 0, sw = 0, m = 0, gx = x[s], gy = y[s];
            for (const i of idx) {
                const dx = x[i] - gx, dy = y[i] - gy, d = Math.sqrt(dx * dx + dy * dy);
                if (m > 0 && d > maxRadio) break;
                const c = visits[i] * (minutes[i] + d * travelPerKm[i]);
                if (m > 0 && acc + c > fill) break;
                acc += c; taken[i] = 1; m++; growAsig[i] = seeds.length;
                sx += x[i] * c; sy += y[i] * c; sw += c; gx = sx / sw; gy = sy / sw;
            }
            // Con el centroide FINAL, si la zona se pasa (el centroide se movio mientras
            // crecia), sobran los MAS LEJANOS del centroide: se sueltan y quedan para los
            // siguientes focos (regla del usuario: "que sobren los lejanos, no el centro").
            {
                const mine: number[] = []; for (const i of idx) if (growAsig[i] === seeds.length) mine.push(i);
                let total = 0; for (const i of mine) total += visits[i] * (minutes[i] + Math.hypot(x[i] - gx, y[i] - gy) * travelPerKm[i]);
                if (total > fill && mine.length > 1) {
                    mine.sort((p, q) => (Math.hypot(x[q] - gx, y[q] - gy)) - (Math.hypot(x[p] - gx, y[p] - gy)));
                    for (const i of mine) {
                        if (total <= fill || mine.length <= 1) break;
                        total -= visits[i] * (minutes[i] + Math.hypot(x[i] - gx, y[i] - gy) * travelPerKm[i]);
                        taken[i] = 0; growAsig[i] = -1;
                    }
                }
            }
            seeds.push({ x: sw > 0 ? sx / sw : x[s], y: sw > 0 ? sy / sw : y[s] });
        }
    }
    let k = Math.min(seeds.length, n);
    let cx = new Float64Array(k), cy = new Float64Array(k);
    for (let c = 0; c < k; c++) { cx[c] = seeds[c].x; cy[c] = seeds[c].y; }
    void target; void pickWeighted;

    // buffers reutilizados
    const candIdx = new Int32Array(n * V);
    const candD2 = new Float64Array(n * V);
    const candN = new Int32Array(n);
    const asig = new Int32Array(n);
    const load = new Float64Array(n);
    const tmpIdx = new Int32Array(V), tmpD2 = new Float64Array(V);

    const assignFrom = (w: Float64Array): void => {
        for (let i = 0; i < n; i++) {
            const base = i * V, m = candN[i];
            let best = -1, bestCost = Infinity;
            for (let t = 0; t < m; t++) {
                const c = candIdx[base + t];
                const cost = candD2[base + t] + w[c];
                if (cost < bestCost) { bestCost = cost; best = t; }
            }
            asig[i] = candIdx[base + best];
            load[i] = visits[i] * (minutes[i] + Math.sqrt(candD2[base + best]) * travelPerKm[i]);
        }
    };

    const zoneTotals = (kk: number, out: Float64Array, cnt: Int32Array): void => {
        out.fill(0); cnt.fill(0);
        for (let i = 0; i < n; i++) { out[asig[i]] += load[i]; cnt[asig[i]]++; }
    };

    let bestRound: { score: number; asig: Int32Array; load: Float64Array; cx: Float64Array; cy: Float64Array; k: number } | null = null;
    if (opt.growthOnly) {
        asig.set(growAsig);
        for (let i = 0; i < n; i++) { const c = asig[i]; const dx = x[i] - cx[c], dy = y[i] - cy[c]; load[i] = visits[i] * (minutes[i] + Math.sqrt(dx * dx + dy * dy) * travelPerKm[i]); }
        // RECLAMAR: cada cliente pasa al centro mas cercano que tenga hueco bajo el TOPE (no
        // bajo las 140 nominales en que paro el crecimiento), sin recentrar, hasta que nadie
        // mejore. Caso real: un cliente a 74 km de su centro con una zona a 54 km que tenia
        // 24 h de hueco. Los centros no se mueven: lo que cambia es solo quien esta mal lejos.
        const hiCap = capMin * (1 + tol);
        const totG = new Float64Array(k); for (let i = 0; i < n; i++) totG[asig[i]] += load[i];
        const grid = new CenterGrid(cx, cy, k, areaKm2);
        const ti = new Int32Array(V), td = new Float64Array(V);
        const membersG: number[][] = Array.from({ length: k }, () => []);
        for (let i = 0; i < n; i++) membersG[asig[i]].push(i);
        const moveG = (i: number, c: number, nl: number): void => {
            const a = asig[i]; const arr = membersG[a]; arr.splice(arr.indexOf(i), 1);
            totG[a] -= load[i]; asig[i] = c; load[i] = nl; totG[c] += nl; membersG[c].push(i);
        };
        const tj = new Int32Array(V), tdj = new Float64Array(V);
        const MAXLEN = 6;
        // mejor salida de la zona z hacia otra zona: por cada vecina, el cliente de z que menos
        // pierde al pasarse (excluyendo `skip`); devuelve [{to, j, cost, nl}]
        const salidas = (z: number, skip: number): { to: number; j: number; cost: number; nl: number }[] => {
            const best = new Map<number, { j: number; cost: number; nl: number }>();
            for (const j of membersG[z]) {
                if (j === skip || isTown[j]) continue;
                const dxj = x[j] - cx[z], dyj = y[j] - cy[z]; const dJ = dxj * dxj + dyj * dyj;
                const mj = grid.nearest(x[j], y[j], cx, cy, V, tj, tdj);
                for (let q = 0; q < mj; q++) {
                    const c2 = tj[q]; if (c2 === z) continue;
                    if (Math.sqrt(tdj[q]) > maxRadio) break;
                    const cost = tdj[q] - dJ;
                    const prev = best.get(c2);
                    if (!prev || cost < prev.cost) best.set(c2, { j, cost, nl: visits[j] * (minutes[j] + Math.sqrt(tdj[q]) * travelPerKm[j]) });
                }
            }
            return [...best.entries()].map(([to, v]) => ({ to, j: v.j, cost: v.cost, nl: v.nl }));
        };
        // camino de coste minimo desde `from` (que recibe a i con carga nlIn) hasta una zona con
        // hueco; cada paso saca un cliente. Dijkstra acotado a MAXLEN pasos y coste < budget.
        const chainPath = (from: number, i: number, nlIn: number, budget: number): { j: number; to: number; nl: number }[] | null => {
            type Node = { z: number; cost: number; inLoad: number; skip: number; path: { j: number; to: number; nl: number }[] };
            const open: Node[] = [{ z: from, cost: 0, inLoad: nlIn, skip: i, path: [] }];
            const bestCost = new Map<number, number>([[from, 0]]);
            while (open.length) {
                let bi = 0; for (let q = 1; q < open.length; q++) if (open[q].cost < open[bi].cost) bi = q;
                const cur = open.splice(bi, 1)[0];
                if (cur.cost >= budget) return null;
                if (cur.path.length >= MAXLEN) continue;
                for (const s of salidas(cur.z, cur.skip)) {
                    const cost = cur.cost + s.cost;
                    if (cost >= budget) continue;
                    // la zona actual cede s.j y recibe cur.inLoad: tiene que caber
                    if (totG[cur.z] - load[s.j] + cur.inLoad > hiCap) continue;
                    const path = cur.path.concat([{ j: s.j, to: s.to, nl: s.nl }]);
                    if (totG[s.to] + s.nl <= hiCap) return path;           // zona con hueco: fin
                    const prev = bestCost.get(s.to);
                    if (prev !== undefined && prev <= cost) continue;
                    bestCost.set(s.to, cost);
                    open.push({ z: s.to, cost, inLoad: s.nl, skip: s.j, path });
                }
            }
            return null;
        };
        for (let sweep = 0; sweep < 6; sweep++) {
            let cambios = 0;
            for (let i = 0; i < n; i++) {
                if (isTown[i]) continue;          // el reparto de los pueblos no se toca
                const a = asig[i]; const dxa = x[i] - cx[a], dya = y[i] - cy[a]; const dA = dxa * dxa + dya * dya;
                const m = grid.nearest(x[i], y[i], cx, cy, V, ti, td);
                let hecho = false;
                for (let s = 0; s < m && !hecho; s++) {
                    const c = ti[s]; if (td[s] >= dA) break;          // ordenados por distancia
                    if (c === a) continue;
                    const nl = visits[i] * (minutes[i] + Math.sqrt(td[s]) * travelPerKm[i]);
                    if (totG[c] + nl <= hiCap) { moveG(i, c, nl); cambios++; hecho = true; break; }
                    // CADENA de cualquier longitud (usuario: "los azules al de al lado, y los
                    // sobrantes de este al otro en cadena"). Camino de coste minimo en el grafo
                    // de zonas desde c (llena) hasta una zona con hueco: ir de B a C cuesta lo
                    // que pierde el cliente de B que mejor encaja en C (distancia al centro).
                    // Se acepta si el coste total es menor que lo que gana i al entrar en c.
                    const gainI = dA - td[s];
                    const chain = chainPath(c, i, nl, gainI);
                    if (chain) {
                        // aplicar desde el final: cada zona cede antes de recibir
                        for (let q = chain.length - 1; q >= 0; q--) moveG(chain[q].j, chain[q].to, chain[q].nl);
                        moveG(i, c, nl); cambios++; hecho = true;
                    }
                }
            }
            if (cambios === 0) break;
        }
        // SEGURIDAD DEL TOPE: las cadenas dejan alguna zona unas decimas por encima (154,04 h,
        // 155,3 h): se cede el cliente mas lejano del centro a la zona mas cercana con hueco.
        for (let sweep = 0; sweep < 3; sweep++) {
            let fixed = 0;
            for (let c = 0; c < k; c++) {
                if (totG[c] <= hiCap + 1e-9) continue;
                const m = membersG[c].slice().sort((p, q) => ((x[q] - cx[c]) ** 2 + (y[q] - cy[c]) ** 2) - ((x[p] - cx[c]) ** 2 + (y[p] - cy[c]) ** 2));
                for (const i of m) {
                    if (totG[c] <= hiCap + 1e-9) break;
                    const mm = grid.nearest(x[i], y[i], cx, cy, V, ti, td);
                    for (let s = 0; s < mm; s++) {
                        const z = ti[s]; if (z === c) continue;
                        if (Math.sqrt(td[s]) > maxRadio) break;
                        const nl = visits[i] * (minutes[i] + Math.sqrt(td[s]) * travelPerKm[i]);
                        if (totG[z] + nl <= hiCap) { moveG(i, z, nl); fixed++; break; }
                    }
                }
            }
            if (fixed === 0) break;
        }
        // FUNDIR zonas cortas: todos sus clientes a zonas con hueco bajo el tope y a menos de
        // maxRadio (las mas cercanas primero); solo si caben TODOS. Sin esto los restos
        // quedaban como cientos de mini-zonas (1.012 zonas, 105 de <= 3 puntos).
        {
            const lo = capMin * (1 - tol);
            const orden = Array.from({ length: k }, (_, c) => c).filter(c => membersG[c].length > 0 && totG[c] < lo).sort((a, b) => totG[a] - totG[b]);
            for (const c of orden) {
                if (membersG[c].length === 0 || totG[c] >= lo) continue;
                const plan: { i: number; dest: number; nl: number }[] = [];
                const extra = new Map<number, number>();
                let ok = true;
                for (const i of membersG[c]) {
                    const m = grid.nearest(x[i], y[i], cx, cy, V, ti, td);
                    let dest = -1, nl = 0;
                    for (let s = 0; s < m; s++) {
                        const z = ti[s]; if (z === c || membersG[z].length === 0) continue;
                        if (Math.sqrt(td[s]) > maxRadio) break;
                        const l = visits[i] * (minutes[i] + Math.sqrt(td[s]) * travelPerKm[i]);
                        if (totG[z] + (extra.get(z) ?? 0) + l <= hiCap) { dest = z; nl = l; break; }
                    }
                    if (dest < 0) { ok = false; break; }
                    plan.push({ i, dest, nl }); extra.set(dest, (extra.get(dest) ?? 0) + nl);
                }
                if (!ok) continue;
                for (const p of plan) moveG(p.i, p.dest, p.nl);
            }
        }
        // RESTOS de <= 6 clientes que la fusion no pudo disolver: se intenta de nuevo cliente a
        // cliente con CADENAS (presupuesto = lo que el entrante paga por entrar), todo o nada
        // con deshacer. Caso real: 5 puntos (17 h) junto a una zona de 133 h que no los
        // absorbia por 1,4 h de viaje; con una cadena, si.
        for (let c = 0; c < k; c++) {
            if (membersG[c].length === 0 || membersG[c].length > 6 || totG[c] >= capMin * (1 - tol)) continue;
            const m = membersG[c].slice();
            const hechos: { i: number; from: number; nlOld: number }[] = [];
            let todos = true;
            for (const i of m) {
                const mm = grid.nearest(x[i], y[i], cx, cy, V, ti, td);
                let hecho = false;
                for (let s = 0; s < mm && !hecho; s++) {
                    const z = ti[s]; if (z === c || membersG[z].length === 0) continue;
                    if (Math.sqrt(td[s]) > maxRadio) break;
                    const nl = visits[i] * (minutes[i] + Math.sqrt(td[s]) * travelPerKm[i]);
                    if (totG[z] + nl <= hiCap) { hechos.push({ i, from: asig[i], nlOld: load[i] }); moveG(i, z, nl); hecho = true; break; }
                    const chain = chainPath(z, i, nl, td[s]);
                    if (chain) {
                        for (let q = chain.length - 1; q >= 0; q--) { hechos.push({ i: chain[q].j, from: asig[chain[q].j], nlOld: load[chain[q].j] }); moveG(chain[q].j, chain[q].to, chain[q].nl); }
                        hechos.push({ i, from: asig[i], nlOld: load[i] }); moveG(i, z, nl); hecho = true;
                    }
                }
                if (!hecho) { todos = false; break; }
            }
            if (!todos) for (let q = hechos.length - 1; q >= 0; q--) moveG(hechos[q].i, hechos[q].from, hechos[q].nlOld);
        }
        // Lo que sigue en zonas cortas son restos que no caben en ningun territorio vecino: se
        // quedan como TERRITORIO PARCIAL (p. ej. "La Gomera: 0,3 comerciales"). Hasta el
        // 07-10-2026 los restos de <= 3 clientes quedaban sin territorio y su carga no contaba
        // en los comerciales necesarios: un visual que dimensiona plantilla se quedaba corto
        // (un area de 2 clientes daba 0 h). Decision de Tino: toda la carga cuenta.
        //
        // SIN TERRITORIO solo queda un cliente a mas de maxRadio de su centro. En produccion el
        // visual pasa outlierKm = 1e6, asi que no ocurre: los apartados se marcan antes, con
        // "Outlier km" del panel (markOutliers), y lo decide el director.
        for (let i = 0; i < n; i++) {
            const c = asig[i]; if (c < 0) continue;
            const d = Math.hypot(x[i] - cx[c], y[i] - cy[c]);
            if (d > maxRadio) { totG[c] -= load[i]; asig[i] = -1; load[i] = visits[i] * minutes[i]; unassignedCount++; }
        }
        // zonas que se han quedado vacias al reclamar: fuera, y renumerar
        const cntG = new Int32Array(k); for (let i = 0; i < n; i++) if (asig[i] >= 0) cntG[asig[i]]++;
        const map = new Int32Array(k).fill(-1); const ncx: number[] = [], ncy: number[] = [];
        for (let c = 0; c < k; c++) if (cntG[c] > 0) { map[c] = ncx.length; ncx.push(cx[c]); ncy.push(cy[c]); }
        for (let i = 0; i < n; i++) if (asig[i] >= 0) asig[i] = map[asig[i]];
        cx = Float64Array.from(ncx); cy = Float64Array.from(ncy); k = cx.length;
        bestRound = { score: 0, asig: asig.slice(), load: load.slice(), cx: cx.slice(), cy: cy.slice(), k };
    }

    for (let round = 0; round < (opt.growthOnly ? 0 : rounds); round++) {
        // ================= equilibrar (Lloyd por fuera, sesgos por dentro) ==============
        const w = new Float64Array(k);
        const tot = new Float64Array(k), cnt = new Int32Array(k);
        const scale = new Float64Array(k);
        let bestLloyd: { score: number; asig: Int32Array; load: Float64Array; cx: Float64Array; cy: Float64Array } | null = null;

        for (let step = 0; step < lloydSteps; step++) {
            // candidatos con los centros fijos
            const grid = new CenterGrid(cx, cy, k, areaKm2);
            for (let i = 0; i < n; i++) {
                const m = grid.nearest(x[i], y[i], cx, cy, V, tmpIdx, tmpD2);
                candN[i] = m;
                candIdx.set(tmpIdx.subarray(0, m), i * V);
                candD2.set(tmpD2.subarray(0, m), i * V);
            }
            // escala global: mediana aproximada de d2 al mas cercano (muestra)
            let gScale = 0;
            {
                const step2 = Math.max(1, Math.floor(n / 2000));
                const sample: number[] = [];
                for (let i = 0; i < n; i += step2) sample.push(candD2[i * V]);
                sample.sort((a, b) => a - b);
                gScale = sample[Math.floor(sample.length / 2)] + 1e-9;
            }
            scale.fill(gScale);

            let cv = 1;
            for (let it = 0; it < biasSteps; it++) {
                assignFrom(w);
                zoneTotals(k, tot, cnt);
                let mean = 0; for (let c = 0; c < k; c++) mean += tot[c]; mean /= k;
                let var_ = 0; for (let c = 0; c < k; c++) { const d = tot[c] - mean; var_ += d * d; }
                cv = Math.sqrt(var_ / k) / Math.max(mean, 1e-9);
                if (cv < 0.04) break;
                if (it % 5 === 0) {
                    // radio^2 PROPIO de cada zona: la media de d2 de sus puntos al centro elegido.
                    // No la distancia al segundo centro, que en un nucleo denso es 0,3 km^2 y
                    // dejaba el tope del sesgo corto.
                    scale.fill(0);
                    for (let i = 0; i < n; i++) {
                        const base = i * V, m = candN[i];
                        for (let t = 0; t < m; t++) if (candIdx[base + t] === asig[i]) { scale[asig[i]] += candD2[base + t]; break; }
                    }
                    for (let c = 0; c < k; c++) scale[c] = cnt[c] > 0 ? scale[c] / cnt[c] + 1e-9 : gScale;
                }
                for (let c = 0; c < k; c++) {
                    let exc = tot[c] / target - 1;
                    if (exc > 0.5) exc = 0.5; else if (exc < -0.5) exc = -0.5;
                    w[c] += 0.10 * scale[c] * exc;
                    // ACOTAR: holgado para zonas con puntos, estricto para vacias. Una zona vacia
                    // sin tope bajaba a -3.000 km^2 y, al entrar en la lista de un punto, se
                    // tragaba a todas sus vecinas: agujero negro.
                    const lim = (cnt[c] > 0 ? biasCap : 3) * scale[c];
                    if (w[c] > lim) w[c] = lim; else if (w[c] < -lim) w[c] = -lim;
                }
            }

            // mejor paso de Lloyd, no el ultimo: mover los centros puede empeorar
            let empties = 0; for (let c = 0; c < k; c++) if (cnt[c] === 0) empties++;
            const score = cv + 0.05 * empties;
            if (!bestLloyd || score < bestLloyd.score) {
                bestLloyd = { score, asig: asig.slice(), load: load.slice(), cx: cx.slice(), cy: cy.slice() };
            }

            // recentrar AMORTIGUADO: la mitad del camino, o la geometria cambia bajo unos
            // sesgos ajustados a la anterior y la siguiente pasada arranca peor
            const sx = new Float64Array(k), sy = new Float64Array(k), sw = new Float64Array(k);
            for (let i = 0; i < n; i++) { const c = asig[i]; sx[c] += x[i] * load[i]; sy[c] += y[i] * load[i]; sw[c] += load[i]; }
            for (let c = 0; c < k; c++) if (sw[c] > 0) { cx[c] = 0.5 * cx[c] + 0.5 * sx[c] / sw[c]; cy[c] = 0.5 * cy[c] + 0.5 * sy[c] / sw[c]; }

            // recolocar centros VACIOS dentro de las zonas saturadas: pocos por paso, en un
            // punto interior elegido por carga, con sesgo neutro (la mediana). Heredar el de la
            // zona saturada -grande y repulsivo- hacia que el nuevo no captara nada.
            const emptyC: number[] = [], satC: number[] = [];
            for (let c = 0; c < k; c++) { if (cnt[c] === 0) emptyC.push(c); if (tot[c] > 1.5 * target) satC.push(c); }
            if (emptyC.length && satC.length) {
                satC.sort((a, b) => tot[b] - tot[a]);
                const ws = Array.from(w).sort((a, b) => a - b);
                const wMed = ws[Math.floor(ws.length / 2)];
                const cap_ = Math.max(1, Math.floor(k / 50));
                for (let j = 0; j < Math.min(cap_, emptyC.length); j++) {
                    const cs = satC[j % satC.length];
                    // punto interior ponderado por carga
                    let tl = 0; for (let i = 0; i < n; i++) if (asig[i] === cs) tl += load[i];
                    let u = rnd() * tl, pick = -1;
                    for (let i = 0; i < n; i++) if (asig[i] === cs) { u -= load[i]; if (u <= 0) { pick = i; break; } }
                    if (pick < 0) continue;
                    const ce = emptyC[j];
                    cx[ce] = x[pick]; cy[ce] = y[pick]; w[ce] = wMed;
                }
            }
            if (cv < 0.04 && step >= 3 && !(emptyC.length && satC.length)) break;
        }

        // resultado de esta vuelta = mejor paso de Lloyd
        asig.set(bestLloyd!.asig); load.set(bestLloyd!.load); cx = bestLloyd!.cx; cy = bestLloyd!.cy;
        // recalcular carga coherente con los centros devueltos
        for (let i = 0; i < n; i++) {
            const c = asig[i]; const dx = x[i] - cx[c], dy = y[i] - cy[c];
            load[i] = visits[i] * (minutes[i] + Math.sqrt(dx * dx + dy * dy) * travelPerKm[i]);
        }
        zoneTotals(k, tot, cnt);

        // mejor vuelta por el criterio que ve el usuario: zonas dentro de la banda; a
        // igualdad, menor desviacion
        // REGLA B: primero ninguna zona sobre el tope; despues las de la banda
        let within = 0, mean = 0, overCap = 0;
        for (let c = 0; c < k; c++) { mean += tot[c]; if (tot[c] > capMin * (1 + tol)) overCap++; if (tot[c] >= capMin * (1 - tol) && tot[c] <= capMin * (1 + tol)) within++; }
        mean /= k;
        let sd = 0; for (let c = 0; c < k; c++) { const d = tot[c] - mean; sd += d * d; } sd = Math.sqrt(sd / k);
        const score = -overCap * 1e3 + within / k - sd / capMin * 1e-3;
        if (!bestRound || score > bestRound.score) {
            bestRound = { score, asig: asig.slice(), load: load.slice(), cx: cx.slice(), cy: cy.slice(), k };
        }
        if (round === rounds - 1) break;

        // ================= tope por MITADES + ajuste de k ================================
        // Una zona que pasa del tope recibe un centro nuevo en un punto interior elegido por
        // carga: la vuelta siguiente la parte en dos mitades convexas. NUNCA se sacan puntos
        // sueltos de una zona para que quepa (eso creaba mini-zonas de 7 puntos, regla B).
        // El intercambio flojas/saturadas y el ajuste global de k se mantienen para el resto.
        const weak: number[] = [], sat: number[] = [], over: number[] = [];
        for (let c = 0; c < k; c++) { if (tot[c] < capMin * (1 - tol)) weak.push(c); if (tot[c] > capMin * (1 + tol)) over.push(c); if (tot[c] > target * 1.15) sat.push(c); }
        weak.sort((a, b) => tot[a] - tot[b]); sat.sort((a, b) => tot[b] - tot[a]);
        const nSwap = Math.min(weak.length, sat.length, Math.max(1, Math.floor(k / 40)));
        const removed = new Set<number>();
        for (let j = 0; j < nSwap; j++) {
            const cs = sat[j];
            if (over.includes(cs)) continue;               // las que pasan del tope se parten, no se les acerca una floja
            let tl = 0; for (let i = 0; i < n; i++) if (asig[i] === cs) tl += load[i];
            let u = rnd() * tl, pick = -1;
            for (let i = 0; i < n; i++) if (asig[i] === cs) { u -= load[i]; if (u <= 0) { pick = i; break; } }
            if (pick < 0) continue;
            cx[weak[j]] = x[pick]; cy[weak[j]] = y[pick];
            removed.add(weak[j]);
        }
        // Partir en MITADES: los dos centros nacen separados a lo largo del eje principal de
        // la zona (una desviacion tipica a cada lado del centroide). Plantar el centro nuevo
        // en un punto interior por carga lo ponia en el casco, se llenaba con 8 clientes
        // gordos y salia "nucleo + anillo", no dos mitades.
        const addX: number[] = [], addY: number[] = [];
        for (const c of over) {
            let sw = 0, mx = 0, my = 0;
            for (let i = 0; i < n; i++) if (asig[i] === c) { sw += load[i]; mx += x[i] * load[i]; my += y[i] * load[i]; }
            if (sw <= 0) continue;
            mx /= sw; my /= sw;
            let sxx = 0, sxy = 0, syy = 0;
            for (let i = 0; i < n; i++) if (asig[i] === c) { const dx = x[i] - mx, dy = y[i] - my; sxx += load[i] * dx * dx; sxy += load[i] * dx * dy; syy += load[i] * dy * dy; }
            sxx /= sw; sxy /= sw; syy /= sw;
            // eje principal de la covarianza 2x2
            const tr = sxx + syy, det = sxx * syy - sxy * sxy;
            const l1 = tr / 2 + Math.sqrt(Math.max(0, tr * tr / 4 - det));
            let ax = sxy, ay = l1 - sxx;
            if (Math.abs(ax) + Math.abs(ay) < 1e-12) { ax = 1; ay = 0; }
            const na = Math.hypot(ax, ay); ax /= na; ay /= na;
            const s = Math.sqrt(Math.max(l1, 1e-6));
            cx[c] = mx - ax * s; cy[c] = my - ay * s;
            addX.push(mx + ax * s); addY.push(my + ay * s);
        }
        // QUITAR el centro a una zona corta cuya carga cabe en el hueco de sus 3 vecinas mas
        // cercanas: la vuelta siguiente reparte sus clientes por cercania y las vecinas se
        // recentran hacia ellos. Caso real: Madison, 4 zonas donde caben 3 (44 h + 3x128 h);
        // fundirla punto a punto no cabia porque los urbanos cuestan el doble en un centro a
        // 20 km, pero con 3 centros el diagrama la reparte bien. Hasta un 5% de k por vuelta.
        const dropShort = new Set<number>();
        {
            const spare = new Float64Array(k); for (let c = 0; c < k; c++) spare[c] = Math.max(0, capMin * (1 + tol) - tot[c]);
            const cand = Array.from({ length: k }, (_, c) => c).filter(c => tot[c] < capMin * (1 - tol) && !removed.has(c) && !over.includes(c)).sort((a, b) => tot[a] - tot[b]);
            // en las 3 ultimas vueltas no se quita ninguno: quitar un centro puede dejar una
            // vecina sobre el tope, y hacen falta vueltas despues para partirla
            const maxDrop = round < rounds - 3 ? Math.max(1, Math.floor(k * 0.05)) : 0;
            for (const c of cand) {
                if (dropShort.size >= maxDrop) break;
                const near = Array.from({ length: k }, (_, z) => z).filter(z => z !== c && !dropShort.has(z) && !removed.has(z))
                    .sort((a, b) => ((cx[a] - cx[c]) ** 2 + (cy[a] - cy[c]) ** 2) - ((cx[b] - cx[c]) ** 2 + (cy[b] - cy[c]) ** 2)).slice(0, 3);
                let hueco = 0; for (const z of near) hueco += spare[z];
                if (hueco < tot[c] * 1.2) continue;
                let resto = tot[c]; for (const z of near) { const take = Math.min(spare[z], resto); spare[z] -= take; resto -= take; }
                dropShort.add(c);
            }
        }
        let totalLoad = 0; for (let i = 0; i < n; i++) totalLoad += load[i];
        const kNew = Math.min(n, Math.max(k - dropShort.size + addX.length, Math.round(totalLoad / target)));
        const ncx: number[] = [], ncy: number[] = [];
        for (let c = 0; c < k; c++) if (!dropShort.has(c)) { ncx.push(cx[c]); ncy.push(cy[c]); }
        for (let j = 0; j < addX.length; j++) { ncx.push(addX[j]); ncy.push(addY[j]); }
        if (kNew > ncx.length) {
            const order = Array.from({ length: k }, (_, c) => c).sort((a, b) => tot[b] - tot[a]);
            for (let j = 0; j < kNew - ncx.length; j++) {
                const cs = order[j % k];
                let tl = 0; for (let i = 0; i < n; i++) if (asig[i] === cs) tl += load[i];
                let u = rnd() * tl, pick = -1;
                for (let i = 0; i < n; i++) if (asig[i] === cs) { u -= load[i]; if (u <= 0) { pick = i; break; } }
                if (pick >= 0) { ncx.push(x[pick]); ncy.push(y[pick]); }
            }
        }
        cx = Float64Array.from(ncx); cy = Float64Array.from(ncy);
        k = cx.length;
    }

    // ================= reparacion: la banda como restriccion dura =======================
    const best = bestRound!;
    // En el reparto por crecimiento no hay reparacion ni fusion posterior: lo que sobra se
    // reclama por cercania o queda sin territorio; nada mas. (repairBand no admite -1.)
    if (!opt.growthOnly) {
        const repaired = repairBand(n, x, y, visits, minutes, travelPerKm, best.asig, best.load,
            best.cx, best.cy, capMin, tol, areaKm2, rnd, opt.repairPasses ?? 0, opt.repairNeighbours ?? 12, opt.islandSlack ?? 0);
        best.cx = repaired.cx; best.cy = repaired.cy; best.k = repaired.k;
    }
    const unresolved = 0;

    // ================= volcar el mejor resultado ==========================================
    k = best.k;
    for (let i = 0; i < n; i++) { points[i].clusterId = best.asig[i]; points[i].load = best.load[i]; }
    const zoneMin = new Float64Array(k);
    let travel = 0, totalAll = 0;
    for (let i = 0; i < n; i++) {
        if (best.asig[i] < 0) continue;
        zoneMin[best.asig[i]] += best.load[i];
        totalAll += best.load[i];
        travel += best.load[i] - visitLoad[i];
    }
    const zoneHours = new Float64Array(k);
    let within = 0;
    for (let c = 0; c < k; c++) {
        zoneHours[c] = zoneMin[c] / 60;
        if (zoneMin[c] >= capMin * (1 - tol) && zoneMin[c] <= capMin * (1 + tol)) within++;
    }
    const centers: { lat: number; lon: number }[] = [];
    for (let c = 0; c < k; c++) centers.push({ lat: best.cy[c] / ky, lon: best.cx[c] / kx });

    return { k, centers, zoneHours, withinTolerance: k > 0 ? within / k : 0, travelShare: totalAll > 0 ? travel / totalAll : 0, outOfBand: k - within, unresolved, unassigned: unassignedCount };
}

/**
 * Fase final: la banda de tolerancia como RESTRICCION DURA.
 *
 * El diagrama de potencia deja el 85-90% de las zonas dentro y compactas; lo que queda fuera
 * es el redondeo de los puntos de frontera, y para el director de ventas una zona fuera es
 * una zona que arregla a mano. Busqueda local sobre un reparto ya bueno, como hace Open Door
 * Logistics: primero la violacion de la banda, despues la forma.
 *   1) mover puntos de FRONTERA de las zonas que se pasan a vecinas con hueco;
 *   2) atraer puntos hacia las que se quedan cortas desde vecinas que puedan cederlos;
 *   2b) INTERCAMBIAR un punto pesado por uno ligero cuando la vecina esta ella misma al tope
 *       (con clientes del 10% y banda del 10% se esta en el limite teorico y los flips
 *       solos no llegan);
 *   3) recentrar;
 *   4) si dos pasadas no bajan las zonas fuera: dividir las sobrecargadas atascadas
 *      (centro nuevo dentro) y disolver las cortas que caben en sus vecinas.
 * Un punto movido queda TABU para la zona que dejo: sin eso 8 puntos hacian ping-pong.
 * Solo se mueven puntos que tienen el destino entre sus centros mas cercanos: la forma no
 * se rompe (la contiguidad se mantiene en el 85% medido antes y despues).
 */
/**
 * Los K vecinos mas cercanos de cada punto, EXACTOS, con una rejilla: se amplian anillos de
 * celdas hasta tener K candidatos y que el K-esimo este mas cerca que el borde del ultimo
 * anillo explorado (todo lo no explorado esta mas lejos). Devuelve n*K indices, -1 si faltan.
 */
export function exactKnn(x: Float64Array, y: Float64Array, n: number, K: number, areaKm2: number): Int32Array {
    const out = new Int32Array(n * K).fill(-1);
    if (n === 0) return out;
    const cell = Math.max(0.05, Math.sqrt(areaKm2 / Math.max(n, 1)) * 2);
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) { if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i]; if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i]; }
    const cols = Math.max(1, Math.floor((maxX - minX) / cell) + 1), rows = Math.max(1, Math.floor((maxY - minY) / cell) + 1);
    const cellOf = (px: number, py: number): [number, number] => [Math.min(cols - 1, Math.floor((px - minX) / cell)), Math.min(rows - 1, Math.floor((py - minY) / cell))];
    const counts = new Int32Array(cols * rows);
    for (let i = 0; i < n; i++) { const [a, b] = cellOf(x[i], y[i]); counts[b * cols + a]++; }
    const start = new Int32Array(cols * rows + 1);
    for (let b = 0; b < cols * rows; b++) start[b + 1] = start[b] + counts[b];
    const order = new Int32Array(n); const fill = start.slice(0, cols * rows);
    for (let i = 0; i < n; i++) { const [a, b] = cellOf(x[i], y[i]); order[fill[b * cols + a]++] = i; }
    const bestD = new Float64Array(K), bestI = new Int32Array(K);
    for (let i = 0; i < n; i++) {
        const [i0, j0] = cellOf(x[i], y[i]);
        let found = 0;
        const maxRing = Math.max(cols, rows);
        for (let ring = 0; ring <= maxRing; ring++) {
            for (let j = j0 - ring; j <= j0 + ring; j++) {
                if (j < 0 || j >= rows) continue;
                for (let a = i0 - ring; a <= i0 + ring; a++) {
                    if (a < 0 || a >= cols) continue;
                    if (ring > 0 && Math.abs(a - i0) !== ring && Math.abs(j - j0) !== ring) continue;
                    const b = j * cols + a;
                    for (let q = start[b]; q < start[b + 1]; q++) {
                        const p = order[q]; if (p === i) continue;
                        const dx = x[p] - x[i], dy = y[p] - y[i], d = dx * dx + dy * dy;
                        if (found < K) { let s = found++; while (s > 0 && bestD[s - 1] > d) { bestD[s] = bestD[s - 1]; bestI[s] = bestI[s - 1]; s--; } bestD[s] = d; bestI[s] = p; }
                        else if (d < bestD[K - 1]) { let s = K - 1; while (s > 0 && bestD[s - 1] > d) { bestD[s] = bestD[s - 1]; bestI[s] = bestI[s - 1]; s--; } bestD[s] = d; bestI[s] = p; }
                    }
                }
            }
            // todo lo no explorado esta a >= ring*cell: si el K-esimo esta mas cerca, es exacto
            if (found >= K && bestD[K - 1] <= (ring * cell) * (ring * cell)) break;
        }
        for (let s = 0; s < found; s++) out[i * K + s] = bestI[s];
    }
    return out;
}

function repairBand(n: number, x: Float64Array, y: Float64Array, visits: Float64Array, minutes: Float64Array,
                    travelPerKm: Float64Array, asig: Int32Array, load: Float64Array,
                    cx0: Float64Array, cy0: Float64Array, capMin: number, tol: number, areaKm2: number,
                    rnd: () => number, passes: number, V: number, islandSlack: number): { cx: Float64Array; cy: Float64Array; k: number; unresolved: number } {
    const cx: number[] = Array.from(cx0), cy: number[] = Array.from(cy0);
    const alive: boolean[] = new Array(cx.length).fill(true);
    const lo = capMin * (1 - tol), hi = capMin * (1 + tol);

    const d2To = (i: number, c: number): number => { const dx = x[i] - cx[c], dy = y[i] - cy[c]; return dx * dx + dy * dy; };
    const loadIn = (i: number, c: number): number => visits[i] * (minutes[i] + Math.sqrt(d2To(i, c)) * travelPerKm[i]);

    const dejo = new Int32Array(n).fill(-1);            // tabu: zona que cada punto ha DEJADO
    const moved = new Uint8Array(n);
    let tot = new Float64Array(cx.length);
    const recompute = (): void => {
        tot = new Float64Array(cx.length);
        for (let i = 0; i < n; i++) { load[i] = loadIn(i, asig[i]); tot[asig[i]] += load[i]; }
    };
    recompute();

    // --- VECINOS EXACTOS: los 10 mas cercanos de cada punto, una sola vez ----------------
    // Todo lo que sigue (frontera de la reparacion, busqueda local, fusion, verificacion)
    // usa la misma lista de vecinos. Antes habia una rejilla aproximada aqui y otra en el
    // verificador, y "0 movimientos pendientes" no significaba lo mismo en los dos sitios.
    const K = 10;
    const nb = exactKnn(x, y, n, K, areaKm2);
    const rev: number[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) for (let s = 0; s < K; s++) { const j = nb[i * K + s]; if (j >= 0) rev[j].push(i); }
    // VECINDAD SIMETRICA: i y j son vecinos si uno esta entre los 10 mas cercanos del otro. Es
    // lo que ve el ojo, y hace que "mayoria de vecinos propios" sea un POTENCIAL: mover un
    // punto solo cambia sus propias aristas, asi que subirlo para el sube el total y la
    // busqueda termina. Con "mis 10" a secas, 289 puntos rodeados de otro color no se movian
    // porque muchos los tenian a ellos de vecino.
    const sym: Int32Array[] = new Array(n);
    for (let i = 0; i < n; i++) {
        const s = new Set<number>();
        for (let q = 0; q < K; q++) { const j = nb[i * K + q]; if (j >= 0) s.add(j); }
        for (const j of rev[i]) s.add(j);
        sym[i] = Int32Array.from(s);
    }
    const symCount = (i: number, z: number, skip = -1): number => { let m = 0; for (const j of sym[i]) if (j !== skip && asig[j] === z) m++; return m; };
    const nbCount = (i: number, z: number, skip = -1): number => { let m = 0; const base = i * K; for (let s = 0; s < K; s++) { const j = nb[base + s]; if (j >= 0 && j !== skip && asig[j] === z) m++; } return m; };
    // FRONTERA por vecinos: un punto puede pasar a la zona z solo si al menos 3 de sus 10
    // vecinos ya estan en z. "Destino entre los 12 centros mas cercanos" en una geografia
    // rala es media region, y la reparacion triplicaba los puntos aislados.
    const border = (i: number, z: number): boolean => nbCount(i, z) >= 3;

    let fueraPrev = -1, sinMejora = 0;
    // KEEP-BEST. En geografias ralas (EE. UU.: 0,004 puntos/km2) la cirugia empeoraba el
    // reparto pasada a pasada (724 -> 884 zonas, 187 -> 290 fuera) y se devolvia lo ultimo.
    // Se guarda el mejor estado visto -menos zonas fuera; a igualdad, menos horas fuera- y
    // es lo que se devuelve. La reparacion nunca puede dejarlo peor que lo encontro.
    let best: { score: number; asig: Int32Array; load: Float64Array; cx: number[]; cy: number[]; alive: boolean[] } | null = null;
    const snapshot = (): void => {
        // ASIMETRICO (regla de producto, 29-09-2026): una zona puede quedar corta, nunca larga.
        // A un comercial con poca carga se le anade despues; a uno al 158% no se le puede
        // pedir. El exceso pesa 10 veces mas que el defecto.
        let fuera = 0, viol = 0;
        for (let c = 0; c < cx.length; c++) if (alive[c]) { if (tot[c] < lo) { fuera++; viol += lo - tot[c]; } else if (tot[c] > hi) { fuera++; viol += 10 * (tot[c] - hi); } }
        // horas fuera de banda primero, numero de zonas fuera despues: contar solo zonas
        // premiaba fundir Dakota del Norte entera en una zona de 1.218 h ("solo 1 fuera")
        const score = viol + fuera * 0.05 * capMin;
        if (!best || score < best.score) best = { score, asig: asig.slice(), load: load.slice(), cx: cx.slice(), cy: cy.slice(), alive: alive.slice() };
    };
    snapshot();
    const candIdx = new Int32Array(n * V), candD2 = new Float64Array(n * V), candN = new Int32Array(n);
    const tmpIdx = new Int32Array(V), tmpD2 = new Float64Array(V);

    for (let pass = 0; pass < passes; pass++) {
        const k = cx.length;
        // --- vecinos: los V centros vivos mas cercanos de cada punto ---------------------
        const aliveIds: number[] = [];
        for (let c = 0; c < k; c++) if (alive[c]) aliveIds.push(c);
        const ka = aliveIds.length;
        const acx = new Float64Array(ka), acy = new Float64Array(ka);
        for (let a = 0; a < ka; a++) { acx[a] = cx[aliveIds[a]]; acy[a] = cy[aliveIds[a]]; }
        const grid = new CenterGrid(acx, acy, ka, areaKm2);
        const vv = Math.min(V, ka);
        const members: number[][] = Array.from({ length: k }, () => []);
        const seen: number[][] = Array.from({ length: k }, () => []);   // puntos que tienen c entre sus vecinos
        for (let i = 0; i < n; i++) {
            const m = grid.nearest(x[i], y[i], acx, acy, vv, tmpIdx, tmpD2);
            candN[i] = m;
            for (let t = 0; t < m; t++) { const c = aliveIds[tmpIdx[t]]; candIdx[i * V + t] = c; candD2[i * V + t] = tmpD2[t]; seen[c].push(i); }
            members[asig[i]].push(i);
        }
        // Frontera = el destino esta entre los V centros mas cercanos del punto. Se probo
        // exigir ademas d < 1,5x la distancia al centro mas cercano (o al propio): sin islas,
        // pero 20-70 zonas se quedaban fuera de banda sin salida. Las islas que esto deja
        // (3,5% de puntos con capacidad 1400 h) las quita la limpieza final, que si respeta
        // la banda porque actua sobre un reparto ya equilibrado.
        const near = (i: number, c: number): boolean => {
            const base = i * V;
            for (let t = 0; t < candN[i]; t++) if (candIdx[base + t] === c) return true;
            return false;
        };
        moved.fill(0);
        const order = aliveIds.slice();

        // --- 1) vaciar las que se pasan -------------------------------------------------
        order.sort((a, b) => tot[b] - tot[a]);
        for (const c of order) {
            if (tot[c] <= hi) continue;
            const opts: { cost: number; i: number; dest: number; nl: number }[] = [];
            for (const i of members[c]) {
                if (moved[i]) continue;
                for (let t = 0; t < Math.min(4, candN[i]); t++) {
                    const dest = candIdx[i * V + t];
                    if (dest === c || dest === dejo[i]) continue;
                    if (!border(i, dest)) continue;   // no es frontera de verdad
                    const nl = loadIn(i, dest);
                    if (tot[dest] + nl > hi) continue;
                    opts.push({ cost: candD2[i * V + t] - d2To(i, c) - (tot[dest] < lo ? 1e6 : 0), i, dest, nl });
                    break;
                }
            }
            opts.sort((a, b) => a.cost - b.cost);
            for (const o of opts) {
                if (tot[c] <= hi) break;
                if (tot[o.dest] + o.nl > hi || moved[o.i]) continue;
                tot[c] -= load[o.i]; dejo[o.i] = c; asig[o.i] = o.dest; load[o.i] = o.nl; tot[o.dest] += o.nl; moved[o.i] = 1;
            }
        }

        // --- 2) llenar las que se quedan cortas -----------------------------------------
        order.sort((a, b) => tot[a] - tot[b]);
        for (const c of order) {
            if (tot[c] >= lo) continue;
            const opts: { cost: number; i: number; src: number; nl: number }[] = [];
            for (const i of seen[c]) {
                if (asig[i] === c || moved[i] || dejo[i] === c || !border(i, c)) continue;
                const src = asig[i], nl = loadIn(i, c);
                if (tot[src] - load[i] < lo || tot[c] + nl > hi) continue;
                opts.push({ cost: d2To(i, c) - d2To(i, src), i, src, nl });
            }
            opts.sort((a, b) => a.cost - b.cost);
            for (const o of opts) {
                if (tot[c] >= lo) break;
                if (tot[o.src] - load[o.i] < lo || tot[c] + o.nl > hi || moved[o.i]) continue;
                tot[o.src] -= load[o.i]; dejo[o.i] = o.src; asig[o.i] = c; load[o.i] = o.nl; tot[c] += o.nl; moved[o.i] = 1;
            }
        }

        // --- 2b) intercambios para las que siguen fuera ---------------------------------
        order.sort((a, b) => tot[b] - tot[a]);
        for (const c of order) {
            if (tot[c] >= lo && tot[c] <= hi) continue;
            const over = tot[c] > hi;
            const mc = members[c].filter(i => asig[i] === c && !moved[i]);
            if (mc.length === 0) continue;
            const neigh = new Set<number>();
            for (const i of mc) for (let t = 0; t < candN[i]; t++) { const d = candIdx[i * V + t]; if (d !== c) neigh.add(d); }
            let best: { score: number; i: number; j: number; d: number; li: number; lj: number } | null = null;
            for (const d of neigh) {
                const jd = seen[c].filter(j => asig[j] === d && !moved[j] && dejo[j] !== c && border(j, c));
                if (jd.length === 0) continue;
                const ic = mc.filter(i => dejo[i] !== d && border(i, d));
                for (const i of ic) {
                    const li = loadIn(i, d);
                    const geoI = Math.max(0, d2To(i, d) - d2To(i, c));
                    for (const j of jd) {
                        const lj = loadIn(j, c);
                        const nc = tot[c] - load[i] + lj, nd = tot[d] + li - load[j];
                        if (nd < lo || nd > hi) continue;
                        if (over ? nc >= tot[c] : nc <= tot[c]) continue;
                        const score = Math.abs(nc - (over ? hi : lo)) + 1e-3 * (geoI + Math.max(0, d2To(j, c) - d2To(j, d)));
                        if (!best || score < best.score) best = { score, i, j, d, li, lj };
                    }
                }
            }
            if (!best) continue;
            const { i, j, d, li, lj } = best;
            tot[c] += lj - load[i]; tot[d] += li - load[j];
            dejo[i] = c; dejo[j] = d; asig[i] = d; asig[j] = c; load[i] = li; load[j] = lj; moved[i] = 1; moved[j] = 1;
        }

        // --- 3) recentrar y recalcular ----------------------------------------------------
        {
            const sx = new Float64Array(k), sy = new Float64Array(k), sw = new Float64Array(k);
            for (let i = 0; i < n; i++) { const c = asig[i]; sx[c] += x[i] * load[i]; sy[c] += y[i] * load[i]; sw[c] += load[i]; }
            for (let c = 0; c < k; c++) if (alive[c] && sw[c] > 0) { cx[c] = sx[c] / sw[c]; cy[c] = sy[c] / sw[c]; }
            recompute();
        }
        let fuera = 0;
        for (const c of aliveIds) if (tot[c] < lo || tot[c] > hi) fuera++;
        snapshot();
        if (fuera === 0) break;
        sinMejora = (fueraPrev >= 0 && fuera >= fueraPrev) ? sinMejora + 1 : 0;
        fueraPrev = fuera;
        if (sinMejora < 2) continue;
        sinMejora = 0;

        // --- 4) cambios estructurales para las atascadas --------------------------------
        // members se calculo al empezar la pasada; las fases 1-2b han movido puntos, y
        // disolver una zona con la lista vieja dejaba fuera a los recien llegados (14 puntos
        // sin zona en una prueba con capacidad 1400 h). Se recalcula sobre asig actual.
        for (let c = 0; c < k; c++) members[c].length = 0;
        for (let i = 0; i < n; i++) members[asig[i]].push(i);
        let changed = false;
        // 4-pre) zonas MINUSCULAS (menos de la mitad del minimo): una zona de 1 punto y 1 h no
        // es un territorio. Cada punto va al centro vivo mas cercano de sus candidatos,
        // aunque este lejos y aunque la deje por encima; los flips lo reconducen o el
        // keep-best lo descarta. Sin esto quedaban 19 zonas asi en EE. UU.
        for (const c of aliveIds) {
            if (!alive[c] || tot[c] >= 0.25 * lo || members[c].length === 0) continue;
            const m = members[c].slice();
            let ok = true;
            for (const i of m) {
                let dest = -1;
                // destino: el centro vivo mas cercano que no quede por encima de 1,5x el tope
                // (sin ese limite, en Dakota del Norte todo acababa en una sola zona)
                for (let t = 0; t < candN[i]; t++) { const d = candIdx[i * V + t]; if (d !== c && alive[d] && tot[d] + loadIn(i, d) <= 1.5 * hi) { dest = d; break; } }
                if (dest < 0) { ok = false; break; }
                const nl = loadIn(i, dest);
                tot[c] -= load[i]; asig[i] = dest; load[i] = nl; tot[dest] += nl; members[dest].push(i);
            }
            members[c].length = 0;
            if (ok) { alive[c] = false; changed = true; }
        }
        const over = aliveIds.filter(c => alive[c] && tot[c] > hi).sort((a, b) => tot[b] - tot[a]);
        for (const c of over) {
            const m = members[c];
            if (m.length < 2) continue;
            // Se divide SIEMPRE que se pase: una zona nueva corta es aceptable, una larga no.
            // (Antes se exigia que sobrara medio territorio, y una zona al +58% se quedaba asi.)
            let tl = 0; for (const i of m) tl += load[i];
            let u = rnd() * tl, seed = m[m.length - 1];
            for (const i of m) { u -= load[i]; if (u <= 0) { seed = i; break; } }
            const nz = cx.length;
            cx.push(x[seed]); cy.push(y[seed]); alive.push(true);
            const nt = new Float64Array(nz + 1); nt.set(tot); tot = nt;
            m.sort((a, b) => ((x[a] - x[seed]) ** 2 + (y[a] - y[seed]) ** 2) - ((x[b] - x[seed]) ** 2 + (y[b] - y[seed]) ** 2));
            for (const i of m) {
                if (tot[c] <= capMin || tot[nz] >= capMin * 0.6) break;
                const nl = loadIn(i, nz);
                tot[c] -= load[i]; asig[i] = nz; load[i] = nl; tot[nz] += nl;
            }
            changed = true;
        }
        if (!changed) {
            // DISOLVER las cortas atascadas: cada punto a la zona vecina (de frontera) con mas
            // hueco, aunque la deje por encima; los flips de las pasadas siguientes la bajan.
            // Exigir que todas cupieran bajo el tope dejaba 35 zonas cortas sin salida.
            const under = aliveIds.filter(c => tot[c] < lo).sort((a, b) => tot[a] - tot[b]);
            const received = new Set<number>();   // una zona que acaba de recibir no se disuelve
            for (const c of under) {
                if (received.has(c)) continue;
                const m = members[c];
                const plan: { i: number; dest: number }[] = [];
                let ok = true;
                for (const i of m) {
                    let dest = -1, room = -Infinity;
                    for (let t = 0; t < candN[i]; t++) {
                        const d = candIdx[i * V + t];
                        if (d === c || !alive[d] || !near(i, d)) continue;
                        const r = hi - tot[d];
                        if (r > room) { room = r; dest = d; }
                    }
                    // en zona rala el propio centro es el unico "cercano": vale el siguiente vivo
                    if (dest < 0) for (let t = 0; t < candN[i]; t++) { const d = candIdx[i * V + t]; if (d !== c && alive[d]) { dest = d; break; } }
                    if (dest < 0) { ok = false; break; }
                    plan.push({ i, dest });
                }
                if (!ok || !plan.length) continue;
                for (const p of plan) {
                    const nl = loadIn(p.i, p.dest);
                    tot[c] -= load[p.i]; asig[p.i] = p.dest; load[p.i] = nl; tot[p.dest] += nl;
                    members[p.dest].push(p.i); received.add(p.dest);
                }
                alive[c] = false; changed = true;
            }
        }
        if (!changed) break;
    }

    // restaurar el mejor estado visto antes de limpiar islas
    if (best) {
        const b = best as { asig: Int32Array; load: Float64Array; cx: number[]; cy: number[]; alive: boolean[] };
        asig.set(b.asig); load.set(b.load);
        cx.length = 0; cy.length = 0; alive.length = 0;
        for (let c = 0; c < b.cx.length; c++) { cx.push(b.cx[c]); cy.push(b.cy[c]); alive.push(b.alive[c]); }
        recompute();
    }

    // =============== BUSQUEDA LOCAL EXACTA hasta el punto fijo ==========================
    // Un reparto es correcto si (1) ninguna zona pasa del tope, (2) no queda ningun cliente
    // cuya zona mayoritaria entre sus 10 vecinos sea otra Y pueda moverse, intercambiarse o
    // encadenarse alli sin romper (1) ni empeorar la banda, (3) no queda ninguna zona corta
    // cuyos clientes quepan enteros en las vecinas bajo (1), y (4) el resultado es
    // determinista. Aqui se garantiza (2) y (3) por construccion: cola de trabajo que
    // reevalua solo los puntos cuyo entorno cambio, hasta que la cola se vacia. Al final se
    // recuentan los movimientos de mejora que quedan (unresolved): debe ser 0, y el harness lo
    // comprueba con un verificador independiente. Sustituye a tres pasadas encadenadas
    // (limpieza de islas, pulido, fusion) que no convergian (23-78 movimientos pendientes).
    const viol = (v: number): number => v > hi ? v - hi : v < lo ? lo - v : 0;
    const okBand = (a: number, b: number, na: number, nbv: number): boolean => {
        if (nbv > hi + 1e-9 || na > hi + 1e-9) return false;   // (1) tope duro
        const outBefore = (viol(tot[a]) > 0 ? 1 : 0) + (viol(tot[b]) > 0 ? 1 : 0), outAfter = (viol(na) > 0 ? 1 : 0) + (viol(nbv) > 0 ? 1 : 0);
        return outAfter <= outBefore && viol(na) + viol(nbv) <= viol(tot[a]) + viol(tot[b]) + 1e-9;
    };
    // miembros por zona con posicion, para quitar en O(1)
    const members: number[][] = Array.from({ length: cx.length }, () => []);
    const pos = new Int32Array(n);
    for (let i = 0; i < n; i++) { pos[i] = members[asig[i]].length; members[asig[i]].push(i); }
    const moveTo = (i: number, z: number, nl: number): void => {
        const a = asig[i], arr = members[a], last = arr[arr.length - 1];
        arr[pos[i]] = last; pos[last] = pos[i]; arr.pop();
        tot[a] -= load[i]; asig[i] = z; load[i] = nl; tot[z] += nl;
        pos[i] = members[z].length; members[z].push(i);
    };
    // cola de trabajo
    const queued = new Uint8Array(n); const queue: number[] = []; let qHead = 0;
    const push = (i: number): void => { if (!queued[i]) { queued[i] = 1; queue.push(i); } };
    const touch = (i: number): void => { push(i); for (const j of sym[i]) push(j); };
    // votos = los 10 mas cercanos de i (lo que ve el ojo), no la vecindad simetrica: un punto
    // con 8 de sus 10 vecinos en otra zona esta mal colocado aunque muchos puntos de una zona
    // rala lo tengan a el de vecino.
    const votesOf = (i: number, skip: number): Map<number, number> => {
        const v = new Map<number, number>();
        for (let s = 0; s < K; s++) { const j = nb[i * K + s]; if (j < 0 || j === skip) continue; v.set(asig[j], (v.get(asig[j]) ?? 0) + 1); }
        return v;
    };
    // mal colocado = su zona mayoritaria entre los 10 mas cercanos es otra
    const misplaced = (i: number): boolean => {
        const a = asig[i]; let own = 0; const v = new Map<number, number>();
        for (let s = 0; s < K; s++) { const j = nb[i * K + s]; if (j < 0) continue; if (asig[j] === a) own++; else v.set(asig[j], (v.get(asig[j]) ?? 0) + 1); }
        for (const m of v.values()) if (m > own) return true;
        return false;
    };
    // POTENCIAL = numero de puntos MAL COLOCADOS (el criterio del usuario, literal). Un
    // movimiento se acepta si ese numero BAJA contando a todos los afectados: i, j, y quienes
    // tienen a i o a j entre sus 10 (los unicos cuya condicion puede cambiar). Se aplica en
    // tentativa sobre asig, se cuenta y se deshace. Entero y acotado: la busqueda termina.
    const affected: number[] = [];
    const seenAff = new Uint8Array(n);
    const collect = (i: number): void => { if (!seenAff[i]) { seenAff[i] = 1; affected.push(i); } for (const j of rev[i]) if (!seenAff[j]) { seenAff[j] = 1; affected.push(j); } };
    const badCount = (): number => { let s = 0; for (const p of affected) if (misplaced(p)) s++; return s; };
    const pairCount = (): number => { let s = 0; for (const p of affected) s += nbCount(p, asig[p]); return s; };
    const clearAff = (): void => { for (const p of affected) seenAff[p] = 0; affected.length = 0; };
    // LEXICOGRAFICO: (1) los mal colocados no pueden subir; (2) a igualdad, los pares
    // vecino-misma-zona tienen que subir. Solo con (1), arreglar un punto que deja a un
    // vecino justo en el limite se rechazaba y la cascada no avanzaba (450 puntos a la vista).
    // Ambos enteros y acotados: la busqueda termina.
    const deltaPhi = (i: number, b: number, j: number): number => {
        const a = asig[i];
        clearAff(); collect(i); if (j >= 0) collect(j);
        const badBefore = badCount(), pairBefore = pairCount();
        asig[i] = b; if (j >= 0) asig[j] = a;
        const badAfter = badCount(), pairAfter = pairCount();
        asig[i] = a; if (j >= 0) asig[j] = b;
        const dBad = badBefore - badAfter, dPair = pairAfter - pairBefore;
        if (dBad < 0) return 0;
        if (dBad > 0) return dBad * 100000 + Math.max(0, dPair);
        return dPair > 0 ? dPair : 0;
    };
    // mejor accion para el punto i: {gain, kind, b, j}; gain <= 0 = ninguna
    const bestAction = (i: number): { gain: number; kind: 0 | 1 | 2 | 3; b: number; j: number; li: number; lj: number } => {
        const a = asig[i];
        const v = votesOf(i, -1);
        const ownA = v.get(a) ?? 0;
        let best = { gain: 0, kind: 0 as 0 | 1 | 2 | 3, b: -1, j: -1, li: 0, lj: 0 };
        for (const [b, cnt] of v) {
            if (b === a || !alive[b] || cnt <= ownA) continue;   // solo hacia zonas con mas vecinos que la propia
            const li = loadIn(i, b);
            // movimiento simple
            if (okBand(a, b, tot[a] - load[i], tot[b] + li)) {
                const g = deltaPhi(i, b, -1);
                if (g > best.gain) best = { gain: g, kind: 1, b, j: -1, li, lj: 0 };
            }
            // intercambio con un vecino j de b
            for (const j of sym[i]) {   // j vecino (en cualquier sentido) de i, de la zona b
                if (asig[j] !== b) continue;
                const lj = loadIn(j, a);
                if (!okBand(a, b, tot[a] - load[i] + lj, tot[b] + li - load[j])) continue;
                const g = deltaPhi(i, b, j);
                if (g > best.gain) best = { gain: g, kind: 2, b, j, li, lj };
            }
            // cadena: i entra en b y b cede a a un punto j de su frontera con a (>= 3 vecinos en a)
            let cj = -1, cGain = best.gain, clj = 0;
            for (const j of members[b]) {
                if (j === i || nbCount(j, a, i) < 3) continue;
                const lj = loadIn(j, a);
                if (!okBand(a, b, tot[a] - load[i] + lj, tot[b] + li - load[j])) continue;
                const g = deltaPhi(i, b, j);
                if (g > cGain) { cGain = g; cj = j; clj = lj; }
            }
            if (cj >= 0) best = { gain: cGain, kind: 3, b, j: cj, li, lj: clj };
        }
        return best;
    };

    const apply = (i: number, act: { kind: number; b: number; j: number; li: number; lj: number }): void => {
        const a = asig[i];
        if (act.kind === 1) { moveTo(i, act.b, act.li); touch(i); return; }
        moveTo(i, act.b, act.li); moveTo(act.j, a, act.lj); touch(i); touch(act.j);
    };
    // fusion de zonas cortas: todos sus puntos deben caber bajo el tope en las vecinas
    // (votadas por sus vecinos + 6 mas cercanas), probando tres ordenes de empaquetado
    const fuseShort = (): boolean => {
        let alguna = false;
        const cortas: number[] = [];
        for (let c = 0; c < cx.length; c++) if (alive[c] && tot[c] < lo && members[c].length > 0) cortas.push(c);
        cortas.sort((p, q) => tot[p] - tot[q]);
        for (const c of cortas) {
            if (!alive[c] || tot[c] >= lo) continue;
            const m = members[c].slice();
            const planFor = (orden: number[]): { i: number; dest: number; nl: number }[] | null => {
                const plan: { i: number; dest: number; nl: number }[] = [];
                const extra = new Map<number, number>();
                for (const i of orden) {
                    const v = votesOf(i, -1); v.delete(c);
                    const cands = [...v.entries()].filter(e => alive[e[0]]).sort((p, q) => q[1] - p[1]).map(e => e[0]);
                    const near: { d: number; z: number }[] = [];
                    for (let z = 0; z < cx.length; z++) if (z !== c && alive[z] && !cands.includes(z)) near.push({ d: d2To(i, z), z });
                    near.sort((p, q) => p.d - q.d);
                    for (const e of near.slice(0, 6)) cands.push(e.z);
                    let dest = -1, nl = 0;
                    for (const z of cands) { const l = loadIn(i, z); if (tot[z] + (extra.get(z) ?? 0) + l <= hi) { dest = z; nl = l; break; } }
                    if (dest < 0) return null;
                    plan.push({ i, dest, nl }); extra.set(dest, (extra.get(dest) ?? 0) + nl);
                }
                return plan;
            };
            const pesados = m.slice().sort((p, q) => load[q] - load[p]);
            const plan = planFor(m) ?? planFor(pesados) ?? planFor(pesados.slice().reverse());
            if (!plan) continue;
            for (const p of plan) { moveTo(p.i, p.dest, p.nl); touch(p.i); }
            alive[c] = false; alguna = true;
        }
        return alguna;
    };
    // bucle principal: busqueda local hasta vaciar la cola; fusion; repetir si hubo fusion
    for (let i = 0; i < n; i++) push(i);
    const maxOps = 40 * n;
    let ops = 0;
    const drain = (): void => {
        for (let vuelta = 0; vuelta < 20; vuelta++) {
            while (qHead < queue.length && ops < maxOps) {
                const i = queue[qHead++]; queued[i] = 0; ops++;
                if (!alive[asig[i]]) continue;
                const act = bestAction(i);
                if (act.gain > 0) apply(i, act);
            }
            if (qHead >= queue.length) { queue.length = 0; qHead = 0; }
            if (ops >= maxOps) break;
            // Barrido completo: un punto bloqueado por la BANDA cuando se evaluo puede haberse
            // desbloqueado por movimientos de puntos que no son vecinos suyos (la carga de su
            // zona cambio), y nadie lo reencola. Si el barrido no encuentra nada, punto fijo.
            let re = 0;
            for (let i = 0; i < n; i++) if (alive[asig[i]] && bestAction(i).gain > 0) { push(i); re++; }
            if (re === 0) break;
        }
    };
    // Fusion de zonas cortas, y al final (tras la seguridad del tope) la busqueda local por
    // voto de los 10 vecinos (drain). Solo se ejecuta en las subllamadas del diagrama de
    // potencia; el nivel superior (growthOnly) no pasa por aqui.
    for (let ronda = 0; ronda < 8; ronda++) { if (!fuseShort()) break; }
    // Seguridad del TOPE: el recentrado de la reparacion puede dejar una zona unas decimas por
    // encima (154,9 h en un caso). Se ceden clientes ligeros de frontera a vecinas con hueco,
    // sin mirar el potencial; si no hay vecina con hueco, se queda y el panel lo dice.
    for (let c = 0; c < cx.length; c++) {
        if (!alive[c] || tot[c] <= hi + 1e-9) continue;
        const m = members[c].slice().sort((p, q) => load[p] - load[q]);
        for (const i of m) {
            if (tot[c] <= hi + 1e-9) break;
            const v = votesOf(i, -1);
            const cands = [...v.entries()].filter(e => e[0] !== c && alive[e[0]] && e[1] >= 3).sort((p, q) => q[1] - p[1]).map(e => e[0]);
            for (const z of cands) { const l = loadIn(i, z); if (tot[z] + l <= hi + 1e-9) { moveTo(i, z, l); touch(i); break; } }
        }
    }
    drain();

    // recuento final: movimientos de mejora que quedan (debe ser 0)
    let unresolved = 0;
    for (let i = 0; i < n; i++) if (bestAction(i).gain > 0) unresolved++;


    // compactar: solo zonas vivas, ids 0..k-1
    const map = new Int32Array(cx.length).fill(-1);
    const ncx: number[] = [], ncy: number[] = [];
    for (let c = 0; c < cx.length; c++) if (alive[c]) { map[c] = ncx.length; ncx.push(cx[c]); ncy.push(cy[c]); }
    for (let i = 0; i < n; i++) asig[i] = map[asig[i]];
    return { cx: Float64Array.from(ncx), cy: Float64Array.from(ncy), k: ncx.length, unresolved };
}

/**
 * AREAS COMERCIALES automaticas: k-means ponderado por carga sobre las coordenadas, sin
 * restriccion de tamano. Celdas de Voronoi: convexas, sin bolsas, por construccion. Es el
 * primer nivel del reparto -areas geograficamente logicas- y el tamano no importa: dentro
 * de cada una se calculan despues los territorios de un comercial con la banda de horas.
 * Se probo al reves (territorios y luego agruparlos en regiones equilibradas) y la
 * geografia se rompia en cuanto las regiones tenian que cuadrar horas.
 */
export function geographicAreas(points: ClusterPoint[], k: number, seed = 20260928): Int32Array {
    const n = points.length;
    const areaOf = new Int32Array(n);
    if (n === 0 || k <= 1) return areaOf;
    k = Math.min(k, n);
    const rnd = prng(seed ^ (n * 7 + k));
    let latMean = 0; for (const p of points) latMean += p.lat; latMean /= n;
    const kx = (Math.PI / 180) * R_TIERRA * Math.cos(latMean * Math.PI / 180), ky = (Math.PI / 180) * R_TIERRA;
    const x = new Float64Array(n), y = new Float64Array(n), w = new Float64Array(n);
    let tw = 0;
    for (let i = 0; i < n; i++) {
        const p = points[i];
        x[i] = p.lon * kx; y[i] = p.lat * ky;
        const v = p.visits != null && p.visits > 0 ? p.visits : 1;
        const m = p.minutes != null && p.minutes > 0 ? p.minutes : p.value * 60 / v;
        w[i] = Math.max(v * m, 1e-9); tw += w[i];
    }
    const cx = new Float64Array(k), cy = new Float64Array(k);
    {
        const first = pickWeighted(w, tw, rnd);
        cx[0] = x[first]; cy[0] = y[first];
        const d2 = new Float64Array(n), pw = new Float64Array(n);
        for (let i = 0; i < n; i++) { const dx = x[i] - cx[0], dy = y[i] - cy[0]; d2[i] = dx * dx + dy * dy; }
        for (let c = 1; c < k; c++) {
            let tp = 0; for (let i = 0; i < n; i++) { pw[i] = d2[i] * w[i]; tp += pw[i]; }
            const s = tp > 0 ? pickWeighted(pw, tp, rnd) : Math.floor(rnd() * n);
            cx[c] = x[s]; cy[c] = y[s];
            for (let i = 0; i < n; i++) { const dx = x[i] - cx[c], dy = y[i] - cy[c]; const d = dx * dx + dy * dy; if (d < d2[i]) d2[i] = d; }
        }
    }
    const sx = new Float64Array(k), sy = new Float64Array(k), sw = new Float64Array(k);
    for (let it = 0; it < 60; it++) {
        let changed = 0;
        for (let i = 0; i < n; i++) {
            let best = 0, bd = Infinity;
            for (let c = 0; c < k; c++) { const dx = x[i] - cx[c], dy = y[i] - cy[c]; const d = dx * dx + dy * dy; if (d < bd) { bd = d; best = c; } }
            if (areaOf[i] !== best) { areaOf[i] = best; changed++; }
        }
        if (changed === 0 && it > 0) break;
        sx.fill(0); sy.fill(0); sw.fill(0);
        for (let i = 0; i < n; i++) { const c = areaOf[i]; sx[c] += x[i] * w[i]; sy[c] += y[i] * w[i]; sw[c] += w[i]; }
        for (let c = 0; c < k; c++) if (sw[c] > 0) { cx[c] = sx[c] / sw[c]; cy[c] = sy[c] / sw[c]; }
    }
    return areaOf;
}

/** Resultado del reparto por areas: el ZoningResult global mas a que area pertenece cada territorio. */
export interface AreaZoningResult extends ZoningResult {
    /** Area de cada territorio (indice = clusterId). */
    areaOfTerritory: Int32Array;
    /** Horas por area (suma de sus territorios). */
    areaHours: Float64Array;
    /** Territorios por area. */
    areaTerritories: Int32Array;
    nAreas: number;
}

/**
 * Territorios DENTRO de cada area: el reparto de siempre, area por area, con los ids de
 * territorio consecutivos. Un territorio nunca cruza un area. Un area con menos carga que
 * una capacidad da un territorio corto, y se dice.
 */
export function clusterByArea(points: ClusterPoint[], areaOf: Int32Array, nAreas: number, opt: ZoningOptions,
                              landOf: Int32Array | null = null): AreaZoningResult {
    const n = points.length;
    const centers: { lat: number; lon: number }[] = [];
    const zoneHours: number[] = [], areaOfT: number[] = [];
    const areaHours = new Float64Array(nAreas), areaTerritories = new Int32Array(nAreas);
    let within = 0, outOfBand = 0, travelW = 0, totalMin = 0, unresolved = 0, unassigned = 0;
    for (let a = 0; a < nAreas; a++) {
        const idxA: number[] = [];
        for (let i = 0; i < n; i++) if (areaOf[i] === a) idxA.push(i);
        if (idxA.length === 0) continue;
        // UN TERRITORIO NO CRUZA EL MAR (decision de Tino, 06-10-2026): dentro del area, cada
        // masa de tierra (isla) se reparte por separado. Las Palmas = Gran Canaria, Lanzarote y
        // Fuerteventura: tres repartos. Una isla pequena da un territorio parcial ("La Gomera:
        // 0,3 comerciales"), que dice que esa isla la cubre alguien a tiempo parcial.
        const porTierra = new Map<number, number[]>();
        for (const i of idxA) { const l = landOf ? landOf[i] : 0; const arr = porTierra.get(l); if (arr) arr.push(i); else porTierra.set(l, [i]); }
        let parte = 0;
        for (const idx of [...porTierra.entries()].sort((p, q) => p[0] - q[0]).map(e => e[1])) {
        const sub = idx.map(i => points[i]);
        const r = clusterPoints(sub, { ...opt, seed: (opt.seed ?? 20260928) ^ (a * 2654435761 >>> 0) ^ (parte++ * 40503) });
        const base = centers.length;
        for (let c = 0; c < r.k; c++) { centers.push(r.centers[c]); zoneHours.push(r.zoneHours[c]); areaOfT.push(a); areaHours[a] += r.zoneHours[c]; }
        areaTerritories[a] += r.k;
        for (const p of sub) if (p.clusterId >= 0) p.clusterId += base;
        unassigned += r.unassigned;
        within += Math.round(r.withinTolerance * r.k); outOfBand += r.outOfBand; unresolved += r.unresolved;
        let sm = 0; for (const p of sub) if (p.clusterId >= 0) sm += p.load ?? 0;
        travelW += r.travelShare * sm; totalMin += sm;
        }
    }
    const k = centers.length;
    return {
        k, centers, zoneHours: Float64Array.from(zoneHours), withinTolerance: k > 0 ? within / k : 0,
        travelShare: totalMin > 0 ? travelW / totalMin : 0, outOfBand, unresolved, unassigned,
        areaOfTerritory: Int32Array.from(areaOfT), areaHours, areaTerritories, nAreas
    };
}

/** Estadisticas por zona, en horas. */
export interface ClusterStats {
    /** Horas de visita puras (sin desplazamiento). totalValue - visitHours = viaje. */
    visitHours: number;
    clusterId: number;
    count: number;
    totalValue: number;     // horas/mes, desplazamiento incluido
    variationPct: number;   // respecto a la capacidad
}

/**
 * OUTLIERS: clientes tan apartados que no pertenecen a ningun territorio. Criterio: su TERCER
 * vecino mas cercano esta a mas de outlierKm (asi un punto solo o un grupito de 2-3 cuentan
 * como apartados, y un pueblo de 4 no). Quedan con clusterId -1 y su carga de visita (sin
 * viaje). Devuelve cuantos. Con outlierKm <= 0 no marca ninguno. Se llama ANTES del reparto y
 * el reparto recibe solo los demas.
 */
export function markOutliers(points: ClusterPoint[], outlierKm: number): number {
    const n = points.length;
    if (n === 0 || !(outlierKm > 0)) return 0;
    let latMean = 0; for (const p of points) latMean += p.lat; latMean /= n;
    const kx = (Math.PI / 180) * R_TIERRA * Math.cos(latMean * Math.PI / 180), ky = (Math.PI / 180) * R_TIERRA;
    const x = new Float64Array(n), y = new Float64Array(n);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < n; i++) { x[i] = points[i].lon * kx; y[i] = points[i].lat * ky; if (x[i] < minX) minX = x[i]; if (x[i] > maxX) maxX = x[i]; if (y[i] < minY) minY = y[i]; if (y[i] > maxY) maxY = y[i]; }
    const K = 3, nb = exactKnn(x, y, n, K, Math.max(1, (maxX - minX) * (maxY - minY)));
    const lim2 = outlierKm * outlierKm;
    let count = 0;
    for (let i = 0; i < n; i++) {
        const j = nb[i * K + K - 1];
        const far = j < 0 || ((x[j] - x[i]) ** 2 + (y[j] - y[i]) ** 2) > lim2;
        const p = points[i];
        p.outlier = far;
        if (far) {
            const v = p.visits != null && p.visits > 0 ? p.visits : 1;
            const m = p.minutes != null && p.minutes > 0 ? p.minutes : p.value * 60 / v;
            p.clusterId = -1; p.load = v * m; count++;
        }
    }
    return count;
}

export function computeStats(points: ClusterPoint[], numClusters: number, capacityHours: number): ClusterStats[] {
    const stats: ClusterStats[] = Array.from({ length: numClusters }, (_, i) => ({
        clusterId: i, count: 0, totalValue: 0, visitHours: 0, variationPct: 0
    }));
    for (const p of points) {
        if (p.clusterId >= 0 && p.clusterId < numClusters) {
            stats[p.clusterId].count++;
            stats[p.clusterId].totalValue += (p.load ?? p.value * 60) / 60;
            const v = p.visits != null && p.visits > 0 ? p.visits : 1;
            const m = p.minutes != null && p.minutes > 0 ? p.minutes : p.value * 60 / v;
            stats[p.clusterId].visitHours += v * m / 60;
        }
    }
    for (const s of stats) {
        s.variationPct = capacityHours > 0 ? ((s.totalValue - capacityHours) / capacityHours * 100) : 0;
    }
    return stats;
}
