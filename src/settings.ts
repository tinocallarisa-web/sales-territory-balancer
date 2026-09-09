"use strict";

import powerbi from "powerbi-visuals-api";
import DataView = powerbi.DataView;

/**
 * Minimum variation is hardcoded at 10%.
 * This ensures clusters are never more than 10% below the target size.
 */
export const MIN_VARIATION_PCT = 10;

export interface IClusterSettings {
    numClusters: number;
    targetSize: number;
    maxVariation: number;
}

export interface IMapSettings {
    showAttribution: boolean;
    markerSize: number;
}

export class VisualSettings {

    public clusterSettings: IClusterSettings = {
        numClusters: 5,
        targetSize: 40,
        maxVariation: 20
    };

    public mapSettings: IMapSettings = {
        showAttribution: true,
        markerSize: 7
    };

    public static parse(dataView: DataView): VisualSettings {
        const settings = new VisualSettings();
        const objects = dataView?.metadata?.objects;

        if (!objects) return settings;

        // Cluster settings
        if (objects["clusterSettings"]) {
            const cs = objects["clusterSettings"];

            if (cs["numClusters"] !== undefined && cs["numClusters"] !== null) {
                settings.clusterSettings.numClusters = Math.max(1, Math.min(20,
                    Math.round(Number(cs["numClusters"]))));
            }

            if (cs["targetSize"] !== undefined && cs["targetSize"] !== null) {
                settings.clusterSettings.targetSize = Math.max(1, Number(cs["targetSize"]));
            }

            if (cs["maxVariation"] !== undefined && cs["maxVariation"] !== null) {
                // Enforce minimum of MIN_VARIATION_PCT
                settings.clusterSettings.maxVariation = Math.max(
                    MIN_VARIATION_PCT,
                    Math.min(100, Number(cs["maxVariation"]))
                );
            }
        }

        // Map settings
        if (objects["mapSettings"]) {
            const ms = objects["mapSettings"];

            if (ms["showAttribution"] !== undefined) {
                settings.mapSettings.showAttribution = Boolean(ms["showAttribution"]);
            }

            if (ms["markerSize"] !== undefined && ms["markerSize"] !== null) {
                settings.mapSettings.markerSize = Math.max(3, Math.min(20, Number(ms["markerSize"])));
            }
        }

        return settings;
    }

    public enumerateObjectInstances(objectName: string): powerbi.VisualObjectInstance[] {
        switch (objectName) {
            case "clusterSettings":
                return [{
                    objectName: "clusterSettings",
                    selector: (null as any),
                    properties: {
                        numClusters: this.clusterSettings.numClusters,
                        targetSize: this.clusterSettings.targetSize,
                        maxVariation: this.clusterSettings.maxVariation
                    }
                }];

            case "mapSettings":
                return [{
                    objectName: "mapSettings",
                    selector: (null as any),
                    properties: {
                        showAttribution: this.mapSettings.showAttribution,
                        markerSize: this.mapSettings.markerSize
                    }
                }];

            default:
                return [];
        }
    }
}
