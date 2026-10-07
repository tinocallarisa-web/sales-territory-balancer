"use strict";

import powerbi from "powerbi-visuals-api";
import DataView = powerbi.DataView;

/**
 * Los cuatro parametros del reparto. El numero de zonas NO es uno de ellos: sale de la
 * carga total dividida por la capacidad, que es la pregunta que se hace un director de
 * ventas -cuantos comerciales necesito- y no al reves.
 *
 * Lo que hay aqui son los valores por DEFECTO, que el autor fija en el panel de formato.
 * Los valores VIVOS estan en la barra de controles dentro del visual, porque el reparto
 * tiene que poder cambiarse en vista de lectura, y el panel de formato solo existe en
 * diseno. En edicion, tocar la barra persiste el valor aqui; en lectura, no se escribe
 * nada (el lector explora, no le cambia el informe a nadie).
 */
export interface IClusterSettings {
    /** Horas utiles al mes por comercial: el TAMANO del cluster. */
    capacityHours: number;
    /** km/h medios para convertir distancia en tiempo de desplazamiento. */
    speedKmh: number;
    /** Factor carretera sobre linea recta: 1.3 = 30% mas que en linea recta. */
    detour: number;
    /** Areas comerciales automaticas (si no hay pozo Area). 0 = sin areas. */
    areas: number;
    /** Un cliente cuyo tercer vecino esta a mas de estos km queda fuera del reparto. 0 = nunca. */
    outlierKm: number;
    /** Dias laborables al mes: jornada = horas del comercial / dias (modelo de rutas continuo). */
    workDays: number;
}

export interface IMapSettings {
    markerSize: number;
}

/** Circulo sobre cada area con sus comerciales necesarios (usuario, 30-09-2026). */
export interface IAreaBadgeSettings {
    show: boolean;
    /** Forma: circulo o rectangulo redondeado ajustado al numero. */
    shape: "circle" | "rect";
    fontSize: number;
    fontFamily: string;
    fillColor: string;
    textColor: string;
    borderColor: string;
    borderWidth: number;
}

export class VisualSettings {

    public clusterSettings: IClusterSettings = {
        capacityHours: 140,
        speedKmh: 45,
        detour: 1.3,
        areas: 0,
        outlierKm: 0,
        workDays: 20
    };

    public mapSettings: IMapSettings = {
        markerSize: 4
    };

    public areaBadges: IAreaBadgeSettings = {
        show: true,
        shape: "circle",
        fontSize: 14,
        fontFamily: "'Segoe UI', wf_segoe-ui_normal, helvetica, arial, sans-serif",
        fillColor: "#FFFFFF",
        textColor: "#3B3A34",
        borderColor: "#C96442",
        borderWidth: 2
    };

    private static color(obj: powerbi.DataViewObject, key: string, fallback: string): string {
        const v = obj[key] as { solid?: { color?: string } } | undefined;
        const c = v && v.solid && v.solid.color;
        return typeof c === "string" && /^#[0-9a-fA-F]{3,8}$/.test(c) ? c : fallback;
    }

    private static num(obj: powerbi.DataViewObject, key: string, lo: number, hi: number, fallback: number): number {
        const v = obj[key];
        if (v === undefined || v === null) return fallback;
        const n = Number(v);
        if (!isFinite(n)) return fallback;
        return Math.max(lo, Math.min(hi, n));
    }

    public static parse(dataView: DataView): VisualSettings {
        const s = new VisualSettings();
        const objects = dataView?.metadata?.objects;
        if (!objects) return s;

        const cs = objects["clusterSettings"];
        if (cs) {
            s.clusterSettings.capacityHours = VisualSettings.num(cs, "capacityHours", 1, 10000, s.clusterSettings.capacityHours);
            s.clusterSettings.speedKmh      = VisualSettings.num(cs, "speedKmh", 1, 200, s.clusterSettings.speedKmh);
            s.clusterSettings.detour        = VisualSettings.num(cs, "detour", 1, 3, s.clusterSettings.detour);
            s.clusterSettings.areas         = Math.round(VisualSettings.num(cs, "areas", 0, 500, s.clusterSettings.areas));
            s.clusterSettings.outlierKm     = VisualSettings.num(cs, "outlierKm", 0, 5000, s.clusterSettings.outlierKm);
            s.clusterSettings.workDays      = VisualSettings.num(cs, "workDays", 1, 31, s.clusterSettings.workDays);
        }
        const ab = objects["areaBadges"];
        if (ab) {
            if (typeof ab["show"] === "boolean") s.areaBadges.show = ab["show"] as boolean;
            if (ab["shape"] === "circle" || ab["shape"] === "rect") s.areaBadges.shape = ab["shape"] as "circle" | "rect";
            s.areaBadges.fontSize = VisualSettings.num(ab, "fontSize", 8, 40, s.areaBadges.fontSize);
            // solo nombres de fuente (letras, digitos, espacios, comillas, comas, guiones): va a CSS
            if (typeof ab["fontFamily"] === "string" && /^[\w\s',\-]{1,200}$/.test(ab["fontFamily"] as string)) s.areaBadges.fontFamily = ab["fontFamily"] as string;
            s.areaBadges.fillColor = VisualSettings.color(ab, "fillColor", s.areaBadges.fillColor);
            s.areaBadges.textColor = VisualSettings.color(ab, "textColor", s.areaBadges.textColor);
            s.areaBadges.borderColor = VisualSettings.color(ab, "borderColor", s.areaBadges.borderColor);
            s.areaBadges.borderWidth = VisualSettings.num(ab, "borderWidth", 0, 10, s.areaBadges.borderWidth);
        }
        const ms = objects["mapSettings"];
        if (ms) {
            s.mapSettings.markerSize = VisualSettings.num(ms, "markerSize", 0.5, 20, s.mapSettings.markerSize);
        }
        return s;
    }
}
