"use strict";

/**
 * Geographic weighted clustering algorithm.
 *
 * Uses a region-growing approach (farthest-first seeding + greedy neighbor expansion)
 * to produce geographically contiguous clusters balanced by workload value.
 *
 * Guarantees:
 *  - Seeds are maximally spread across the geographic space
 *  - Each cluster grows by absorbing the nearest unassigned neighbor of any cluster member
 *  - Capacity constraints (target ± maxVariation%) are respected greedily
 *  - Overflow: if all clusters are full, the point goes to the nearest cluster
 */

export interface ClusterPoint {
    customerId: string;
    lat: number;
    lon: number;
    value: number;
    clusterId: number; // -1 = unassigned
}

/** Haversine distance in km between two lat/lon coordinates */
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

/**
 * Farthest-first traversal: selects k seed point indices that are
 * maximally spread geographically.
 */
function farthestFirstSeeds(points: ClusterPoint[], k: number): number[] {
    if (points.length === 0 || k <= 0) return [];

    const n = points.length;
    const seeds: number[] = [];

    // Pick the point closest to the centroid as first seed (more central start)
    const centLat = points.reduce((s, p) => s + p.lat, 0) / n;
    const centLon = points.reduce((s, p) => s + p.lon, 0) / n;

    let minDist = Infinity;
    let firstSeed = 0;
    for (let i = 0; i < n; i++) {
        const d = haversineKm(centLat, centLon, points[i].lat, points[i].lon);
        if (d < minDist) { minDist = d; firstSeed = i; }
    }
    seeds.push(firstSeed);

    // Pre-compute distance from each point to nearest seed (O(n*k))
    const minDistToSeed = new Float64Array(n).fill(Infinity);
    minDistToSeed[firstSeed] = 0;
    for (let j = 0; j < n; j++) {
        minDistToSeed[j] = haversineKm(points[j].lat, points[j].lon,
            points[firstSeed].lat, points[firstSeed].lon);
    }

    for (let s = 1; s < Math.min(k, n); s++) {
        let maxD = -1;
        let nextSeed = 0;
        for (let j = 0; j < n; j++) {
            if (minDistToSeed[j] > maxD) { maxD = minDistToSeed[j]; nextSeed = j; }
        }
        seeds.push(nextSeed);

        // Update min distances with the new seed
        for (let j = 0; j < n; j++) {
            const d = haversineKm(points[j].lat, points[j].lon,
                points[nextSeed].lat, points[nextSeed].lon);
            if (d < minDistToSeed[j]) minDistToSeed[j] = d;
        }
    }

    return seeds;
}

/**
 * Main clustering function.
 *
 * Assigns `clusterId` (0-based) to each point in-place.
 *
 * Algorithm:
 * 1. Select k seeds using farthest-first traversal
 * 2. Build a k-NN neighbor graph (each point → its N nearest neighbors)
 * 3. Region-grow: maintain a priority queue of (cluster, candidate, distance)
 *    triples. In each step, take the shortest-distance candidate that fits
 *    within the cluster's capacity.
 * 4. If no candidate fits within capacity, fall back to nearest-cluster
 *    assignment (overflow mode).
 */
export function clusterPoints(
    points: ClusterPoint[],
    numClusters: number,
    targetSize: number,
    maxVariationPct: number,
    minVariationPct: number = 10
): void {
    const n = points.length;
    if (n === 0 || numClusters <= 0) return;

    const k = Math.min(numClusters, n);
    const maxCapacity = targetSize * (1 + maxVariationPct / 100);

    // Reset
    for (const p of points) p.clusterId = -1;

    // --- Step 1: Seeds ---
    const seedIndices = farthestFirstSeeds(points, k);
    const clusterValues = new Float64Array(k);

    for (let ci = 0; ci < k; ci++) {
        const p = points[seedIndices[ci]];
        p.clusterId = ci;
        clusterValues[ci] = p.value;
    }

    // --- Step 2: Build neighbor lists ---
    // For each point, find its NN_COUNT nearest neighbors (by haversine)
    const NN_COUNT = Math.min(n - 1, 10);
    // neighbors[i] = sorted list of {idx, dist} for point i
    const neighbors: Array<Array<{ idx: number; dist: number }>> = [];

    for (let i = 0; i < n; i++) {
        const dists: { idx: number; dist: number }[] = [];
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            dists.push({
                idx: j,
                dist: haversineKm(points[i].lat, points[i].lon, points[j].lat, points[j].lon)
            });
        }
        dists.sort((a, b) => a.dist - b.dist);
        neighbors.push(dists.slice(0, NN_COUNT));
    }

    // --- Step 3: Region-growing frontier ---
    // frontier: for each cluster, a set of candidate (border) point indices
    // We use a simple array and pick the nearest each round
    interface Candidate { pointIdx: number; dist: number; }
    const frontiers: Candidate[][] = Array.from({ length: k }, () => []);

    // Initialize frontiers from seeds' neighbors
    for (let ci = 0; ci < k; ci++) {
        const seedIdx = seedIndices[ci];
        for (const nb of neighbors[seedIdx]) {
            if (points[nb.idx].clusterId === -1) {
                frontiers[ci].push({ pointIdx: nb.idx, dist: nb.dist });
            }
        }
    }

    // Count unassigned
    let unassigned = n - k;

    // Grow until all points assigned
    let safety = n * k * 2; // prevent infinite loop
    while (unassigned > 0 && safety-- > 0) {
        let bestCi = -1;
        let bestCandIdx = -1;
        let bestDist = Infinity;

        // Find the cluster with the nearest valid candidate that fits in capacity
        for (let ci = 0; ci < k; ci++) {
            if (clusterValues[ci] >= maxCapacity) continue;
            const front = frontiers[ci];
            for (let fi = 0; fi < front.length; fi++) {
                const cand = front[fi];
                if (points[cand.pointIdx].clusterId !== -1) continue; // already assigned
                if (cand.dist < bestDist) {
                    bestDist = cand.dist;
                    bestCi = ci;
                    bestCandIdx = fi;
                }
            }
        }

        if (bestCi === -1) {
            // Overflow: all clusters at capacity — assign remaining points to nearest cluster
            for (let i = 0; i < n; i++) {
                if (points[i].clusterId !== -1) continue;
                let nearestCi = 0;
                let nearestDist = Infinity;
                for (let ci = 0; ci < k; ci++) {
                    const seedPt = points[seedIndices[ci]];
                    const d = haversineKm(points[i].lat, points[i].lon, seedPt.lat, seedPt.lon);
                    if (d < nearestDist) { nearestDist = d; nearestCi = ci; }
                }
                points[i].clusterId = nearestCi;
                clusterValues[nearestCi] += points[i].value;
                unassigned--;
            }
            break;
        }

        // Assign the candidate
        const pointIdx = frontiers[bestCi][bestCandIdx].pointIdx;
        // Remove from frontier (swap with last)
        frontiers[bestCi].splice(bestCandIdx, 1);

        // Double-check it's still unassigned (concurrent frontier updates)
        if (points[pointIdx].clusterId !== -1) continue;

        points[pointIdx].clusterId = bestCi;
        clusterValues[bestCi] += points[pointIdx].value;
        unassigned--;

        // Add this point's unassigned neighbors to the cluster's frontier
        for (const nb of neighbors[pointIdx]) {
            if (points[nb.idx].clusterId === -1) {
                frontiers[bestCi].push({ pointIdx: nb.idx, dist: nb.dist });
            }
        }
    }

    // Failsafe: assign any remaining points to nearest cluster
    for (let i = 0; i < n; i++) {
        if (points[i].clusterId !== -1) continue;
        let nearestCi = 0;
        let nearestDist = Infinity;
        for (let ci = 0; ci < k; ci++) {
            const d = haversineKm(points[i].lat, points[i].lon,
                points[seedIndices[ci]].lat, points[seedIndices[ci]].lon);
            if (d < nearestDist) { nearestDist = d; nearestCi = ci; }
        }
        points[i].clusterId = nearestCi;
    }
}

/** Compute per-cluster statistics */
export interface ClusterStats {
    clusterId: number;
    count: number;
    totalValue: number;
    variationPct: number; // vs targetSize
}

export function computeStats(points: ClusterPoint[], numClusters: number, targetSize: number): ClusterStats[] {
    const stats: ClusterStats[] = Array.from({ length: numClusters }, (_, i) => ({
        clusterId: i,
        count: 0,
        totalValue: 0,
        variationPct: 0
    }));

    for (const p of points) {
        if (p.clusterId >= 0 && p.clusterId < numClusters) {
            stats[p.clusterId].count++;
            stats[p.clusterId].totalValue += p.value;
        }
    }

    for (const s of stats) {
        s.variationPct = targetSize > 0
            ? ((s.totalValue - targetSize) / targetSize * 100)
            : 0;
    }

    return stats;
}
