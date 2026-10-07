"use strict";

import powerbi from "powerbi-visuals-api";
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import ISelectionManager = powerbi.extensibility.ISelectionManager;
import ISelectionId = powerbi.visuals.ISelectionId;
import ILocalizationManager = powerbi.extensibility.ILocalizationManager;

import * as L from "leaflet";
import { VisualSettings, IClusterSettings } from "./settings";
import { AreaZoningResult, ClusterPoint, clusterByArea, clusterPoints, geographicAreas, markOutliers, ZoningResult } from "./clustering";
import { OUTLINE_ADMIN1, OUTLINE_COUNTRIES } from "./outlines";
import { buildAreas } from "./areas";
import { regionsOfPoints } from "./regions";
import { BasicFilter } from "powerbi-models";
import { FormattingSettingsService } from "powerbi-visuals-utils-formattingmodel";
import { buildFormattingModel } from "./formatting";

/**
 * Plan de Partner Center. PENDIENTE: la oferta aun no existe. Al crearla, poner aqui el Plan ID
 * real y verificar el Service ID ("editor.oferta.plan") antes del build de produccion.
 * "partner" es el plan privado a 0 EUR para consultoras (skill pbiviz-appsource, "Plan privado
 * Partner"): una lista y no "cualquier plan activo", por si la oferta llega a tener plan gratuito.
 */
const PRO_PLAN_IDS = ["sales-territory-balancer-pro", "partner"];
/** ServicePlanState es un const enum: en runtime hacen falta los numeros. */
const STATE_ACTIVE = 1;
const STATE_WARNING = 2;
// spIdentifier = Service ID completo (editor.oferta.plan); se acepta tambien el Plan ID solo
function matchesPlan(spIdentifier: unknown, planId: string): boolean {
    const sp = String(spIdentifier ?? "");
    return sp === planId || sp.endsWith("." + planId);
}
/** Funciones Pro que se pueden usar en vista previa (el export no: es el entregable). */
const PRO_AREAS = "your own areas (Area field)";
const PRO_SPEED = "speed per point (Speed field)";
const ES_LABELS: Record<string, string> = {
    [PRO_AREAS]: "tus propias areas (campo Area)",
    [PRO_SPEED]: "la velocidad por punto (campo Speed)"
};

// ─── Colour palette ────────────────────────────────────────────────────────────
const CLUSTER_COLORS: string[] = [
    "#E63946", "#2A9D8F", "#E9C46A", "#F4A261", "#264653",
    "#A8DADC", "#457B9D", "#6A4C93", "#1982C4", "#8AC926",
    "#FF595E", "#FFCA3A", "#C96442", "#06D6A0", "#118AB2"
];

function clusterColor(ci: number): string {
    return CLUSTER_COLORS[ci % CLUSTER_COLORS.length];
}

// ─── Landing page ──────────────────────────────────────────────────────────
// Construida con DOM, no inyectando HTML. Era contenido estatico sin datos del usuario,
// pero la regla de certificacion es literal: nada de HTML como cadena en el fuente.
/** Traductor: clave del resjson con respaldo en ingles. */
type Tr = (key: string, en: string) => string;

function buildLanding(t: Tr): HTMLElement {
    const root = document.createElement("div");
    root.style.cssText =
        "display:flex;flex-direction:column;align-items:center;justify-content:center;" +
        "height:100%;padding:24px;font-family:'Segoe UI',sans-serif;color:#535146;text-align:center;";

    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", "0 0 64 64"); svg.setAttribute("width", "64"); svg.setAttribute("height", "64");
    svg.setAttribute("style", "margin-bottom:16px");
    const dots: [number, number, string][] = [[20, 44, "#E63946"], [44, 44, "#2A9D8F"], [20, 20, "#E9C46A"], [44, 20, "#F4A261"], [32, 32, "#264653"]];
    for (const [cx, cy, fill] of dots.slice(0, 4)) {
        const line = document.createElementNS(NS, "line");
        line.setAttribute("x1", String(cx)); line.setAttribute("y1", String(cy));
        line.setAttribute("x2", "32"); line.setAttribute("y2", "32");
        line.setAttribute("stroke", fill); line.setAttribute("stroke-width", "1.5"); line.setAttribute("opacity", "0.4");
        svg.appendChild(line);
    }
    for (const [cx, cy, fill] of dots) {
        const c = document.createElementNS(NS, "circle");
        c.setAttribute("cx", String(cx)); c.setAttribute("cy", String(cy)); c.setAttribute("r", "6");
        c.setAttribute("fill", fill); c.setAttribute("opacity", "0.9");
        svg.appendChild(c);
    }
    root.appendChild(svg);

    const title = document.createElement("div");
    title.style.cssText = "font-size:16px;font-weight:600;color:#3D3929;margin-bottom:8px";
    title.textContent = "Sales Territory Balancer";
    root.appendChild(title);

    const body = document.createElement("div");
    body.style.cssText = "font-size:12px;line-height:1.6;max-width:300px";
    const l1 = document.createElement("div"); l1.textContent = t("UI_AssignFields", "Assign these fields to get started:");
    const l2 = document.createElement("div");
    for (const [i, f] of [t("Role_CustomerId", "Customer ID"), t("Role_Latitude", "Latitude"), t("Role_Longitude", "Longitude")].entries()) {
        if (i) l2.appendChild(document.createTextNode(" · "));
        const b = document.createElement("b"); b.textContent = f; l2.appendChild(b);
    }
    const l3 = document.createElement("div");
    l3.appendChild(document.createTextNode(t("UI_AndWorkload", "and the workload: ")));
    const b2 = document.createElement("b"); b2.textContent = t("Role_Visits", "Visits per month"); l3.appendChild(b2);
    l3.appendChild(document.createTextNode(" + "));
    const b3 = document.createElement("b"); b3.textContent = t("Role_Minutes", "Minutes per visit"); l3.appendChild(b3);
    body.appendChild(l1); body.appendChild(l2); body.appendChild(l3);
    root.appendChild(body);

    const hint = document.createElement("div");
    hint.style.cssText = "margin-top:16px;font-size:11px;color:#83827D";
    hint.textContent = t("UI_Hint", "Hours per salesperson, speed, road factor and number of areas live in the bar above the map, in reading view too");
    root.appendChild(hint);
    return root;
}

// ─── Leaflet CSS injection ──────────────────────────────────────────────────────
// Injects the minimum Leaflet CSS needed for correct tile + marker positioning.
// This runs once and is idempotent (guarded by the id check).
function injectLeafletCSS(): void {
    const ID = "cw-leaflet-css";
    if (document.getElementById(ID)) return;
    const style = document.createElement("style");
    style.id = ID;
    style.textContent = `
.leaflet-container{position:relative;overflow:hidden;-ms-touch-action:none;touch-action:none;background:#ddd;outline:0;}
.leaflet-container a{color:#0078A8;}
.leaflet-container a.leaflet-active{outline:2px solid orange;}
.leaflet-zoom-box{border:2px dotted #38f;background:rgba(255,255,255,.5);}
.leaflet-container{font:12px/1.5 "Helvetica Neue",Arial,Helvetica,sans-serif;}
.leaflet-bar a,.leaflet-bar a:hover{display:block;width:26px;height:26px;line-height:26px;text-align:center;background-color:#fff;border-bottom:1px solid #ccc;cursor:pointer;color:#444;text-decoration:none;}
.leaflet-bar a,.leaflet-control-layers-toggle{background-position:50% 50%;background-repeat:no-repeat;display:block;}
.leaflet-bar a:hover{background-color:#f4f4f4;}
.leaflet-bar a:first-child{margin-top:0;border-top-left-radius:4px;border-top-right-radius:4px;}
.leaflet-bar a:last-child{margin-bottom:0;border-bottom-left-radius:4px;border-bottom-right-radius:4px;border-bottom:none;}
.leaflet-bar a.leaflet-disabled{cursor:default;background-color:#f4f4f4;color:#bbb;}
.leaflet-control-zoom-in,.leaflet-control-zoom-out{font:bold 18px 'Lucida Console',Monaco,monospace;text-indent:1px;}
.leaflet-touch .leaflet-bar a{width:30px;height:30px;line-height:30px;}
.leaflet-touch .leaflet-control-zoom-in{font-size:22px;}
.leaflet-touch .leaflet-control-zoom-out{font-size:20px;}
.leaflet-pane,.leaflet-tile,.leaflet-marker-icon,.leaflet-marker-shadow,.leaflet-tile-container,.leaflet-pane>svg,.leaflet-pane>canvas,.leaflet-zoom-box,.leaflet-image-layer,.leaflet-layer{position:absolute;left:0;top:0;}
.leaflet-container{overflow:hidden;}
.leaflet-tile,.leaflet-marker-icon,.leaflet-marker-shadow{-webkit-user-select:none;-moz-user-select:none;user-select:none;-webkit-user-drag:none;}
.leaflet-tile::selection{background:transparent;}
.leaflet-tile::-moz-selection{background:transparent;}
.leaflet-tile{visibility:hidden;}
.leaflet-tile-loaded{visibility:inherit;}
.leaflet-zoom-animated{-webkit-transform-origin:0 0;transform-origin:0 0;}
.leaflet-zoom-animated{will-change:transform;}
.leaflet-zoom-animated>.leaflet-image-layer,.leaflet-zoom-animated>.leaflet-layer{will-change:transform;}
.leaflet-pan-animated{will-change:transform;}
.leaflet-map-pane canvas{z-index:1;}
.leaflet-map-pane svg{z-index:2;}
.leaflet-vml-shape{width:1px;height:1px;}
.lvml{behavior:url(#default#VML);display:inline-block;position:absolute;}
.leaflet-control{position:relative;z-index:800;pointer-events:visiblePainted;pointer-events:auto;}
.leaflet-top,.leaflet-bottom{position:absolute;z-index:1000;pointer-events:none;}
.leaflet-top{top:0;}.leaflet-right{right:0;}.leaflet-bottom{bottom:0;}.leaflet-left{left:0;}
.leaflet-control{float:left;clear:both;}
.leaflet-right .leaflet-control{float:right;}
.leaflet-top .leaflet-control{margin-top:10px;}
.leaflet-bottom .leaflet-control{margin-bottom:10px;}
.leaflet-left .leaflet-control{margin-left:10px;}
.leaflet-right .leaflet-control{margin-right:10px;}
.leaflet-fade-anim .leaflet-tile{will-change:opacity;}
.leaflet-fade-anim .leaflet-popup{opacity:0;-webkit-transition:opacity .2s linear;-moz-transition:opacity .2s linear;transition:opacity .2s linear;}
.leaflet-fade-anim .leaflet-map-pane .leaflet-popup{opacity:1;}
.leaflet-zoom-animated{-webkit-transition:-webkit-transform .25s cubic-bezier(0,0,.25,1);-moz-transition:-moz-transform .25s cubic-bezier(0,0,.25,1);transition:transform .25s cubic-bezier(0,0,.25,1);}
.leaflet-pan-animated{-webkit-transition:-webkit-transform linear;-moz-transition:-moz-transform linear;transition:transform linear;}
.leaflet-notouch .leaflet-zoom-animated,.leaflet-touching .leaflet-zoom-animated{-webkit-transition:none!important;-moz-transition:none!important;transition:none!important;}
.leaflet-map-pane{z-index:auto;}
.leaflet-tile-pane{z-index:2;}
.leaflet-overlay-pane{z-index:4;}
.leaflet-shadow-pane{z-index:5;}
.leaflet-marker-pane{z-index:6;}
.leaflet-tooltip-pane{z-index:650;}
.leaflet-popup-pane{z-index:700;}
.leaflet-map-pane canvas{z-index:1;}
.leaflet-map-pane svg{z-index:2;}
.leaflet-vml-shape{width:1px;height:1px;}
.leaflet-control-layers,.leaflet-bar{box-shadow:0 1px 5px rgba(0,0,0,.4);}
.leaflet-control-layers{background:#fff;border-radius:5px;}
.leaflet-control-layers-toggle{background-image:url(data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAYAAADgdz34AAAABmJLR0QA/wD/AP+gvaeTAAAAnklEQVRIie2SwQmAIBREX/YdncVNPNqJHVzABTy5h0JBERS5hRM4gqZgJudGEMEfEHwwl/dmAMDMikgpZVXAHoCqCgCstVJrzSOXMI8IlFJORJRH6NxLKSmlFBFJrTUAQEQ451xkjDHLvDlrrQ0AQERHRFhrLQBoLIIiLlBrLALOOVcAkIgopUwAMMasswjR+rXWXgBkRHTPmVU3vbMM4w1cOCgAAAAASUVORK5CYII=);width:36px;height:36px;}
.leaflet-touch .leaflet-control-layers-toggle{width:44px;height:44px;}
.leaflet-control-layers .leaflet-control-layers-list,.leaflet-control-layers-expanded .leaflet-control-layers-toggle{display:none;}
.leaflet-control-layers-expanded .leaflet-control-layers-list{display:block;position:relative;}
.leaflet-control-layers-expanded{padding:6px 10px 6px 6px;color:#333;background:#fff;}
.leaflet-control-layers-scrollbar{overflow-y:scroll;overflow-x:hidden;padding-right:5px;}
.leaflet-control-layers-selector{margin-top:2px;position:relative;top:1px;}
.leaflet-control-layers label{display:block;}
.leaflet-control-layers-separator{height:0;border-top:1px solid #ddd;margin:5px -10px 5px -6px;}
.leaflet-control-attribution{padding:0 5px;color:#333;line-height:1.4;}
.leaflet-control-attribution a{text-decoration:none;}
.leaflet-control-attribution a:hover{text-decoration:underline;}
.leaflet-container .leaflet-control-attribution,.leaflet-container .leaflet-control-scale{background:#fff;background:rgba(255,255,255,.7);}
.leaflet-control-scale-line{padding:0 5px;line-height:1.1;font-size:11px;white-space:nowrap;overflow:hidden;-moz-box-sizing:border-box;box-sizing:border-box;background:#fff;background:rgba(255,255,255,.5);border:2px solid #777;border-top:none;}
.leaflet-control-scale-line:not(:first-child){border-top:2px solid #777;border-bottom:none;margin-top:-2px;}
.leaflet-control-scale-line:not(:first-child):not(:last-child){border-bottom:2px solid #777;}
.leaflet-touch .leaflet-control-attribution,.leaflet-touch .leaflet-control-layers,.leaflet-touch .leaflet-bar{box-shadow:none;}
.leaflet-touch .leaflet-control-layers,.leaflet-touch .leaflet-bar{border:2px solid rgba(0,0,0,.2);background-clip:padding-box;}
.leaflet-popup{position:absolute;text-align:center;margin-bottom:20px;}
.leaflet-popup-content-wrapper{padding:1px;text-align:left;border-radius:12px;}
.leaflet-popup-content{margin:13px 24px 13px 20px;line-height:1.3;}
.leaflet-popup-content p{margin:18px 0;}
.leaflet-popup-tip-container{width:40px;height:20px;position:absolute;left:50%;margin-left:-20px;overflow:hidden;pointer-events:none;}
.leaflet-popup-tip{width:17px;height:17px;padding:1px;margin:-10px auto 0;-webkit-transform:rotate(45deg) skewX(0) skewY(0);-ms-transform:rotate(45deg) skewX(0) skewY(0);transform:rotate(45deg) skewX(0) skewY(0);}
.leaflet-popup-content-wrapper,.leaflet-popup-tip{background:#fff;color:#333;box-shadow:0 3px 14px rgba(0,0,0,.4);}
.leaflet-container a.leaflet-popup-close-button{position:absolute;top:0;right:0;padding:4px 4px 0 0;border:none;text-align:center;width:18px;height:14px;font:16px/14px Tahoma,Verdana,sans-serif;color:#c3c3c3;text-decoration:none;font-weight:bold;background:transparent;}
.leaflet-container a.leaflet-popup-close-button:hover{color:#999;}
.leaflet-popup-scrolled{overflow:auto;border-bottom:1px solid #ddd;border-top:1px solid #ddd;}
.leaflet-oldie .leaflet-popup-content-wrapper{zoom:1;}.leaflet-oldie .leaflet-popup-tip{width:24px;filter:progid:DXImageTransform.Microsoft.Matrix(M11=0.70710678, M12=0.70710678, M21=-0.70710678, M22=0.70710678);margin:0 auto;}
.leaflet-oldie .leaflet-popup-tip-container{margin-top:-1px;}
.leaflet-oldie .leaflet-control-zoom,.leaflet-oldie .leaflet-control-layers,.leaflet-oldie .leaflet-popup-content-wrapper,.leaflet-oldie .leaflet-popup-tip{border:1px solid #999;}
.leaflet-div-icon{background:#fff;border:1px solid #666;}
.leaflet-tooltip{position:absolute;padding:6px;background-color:#fff;border:1px solid #fff;border-radius:3px;color:#222;white-space:nowrap;-webkit-user-select:none;-moz-user-select:none;user-select:none;pointer-events:none;box-shadow:0 1px 3px rgba(0,0,0,.4);}
.leaflet-tooltip.leaflet-clickable{cursor:pointer;pointer-events:auto;}
.leaflet-tooltip-top:before,.leaflet-tooltip-bottom:before,.leaflet-tooltip-left:before,.leaflet-tooltip-right:before{position:absolute;pointer-events:none;border:6px solid transparent;background:transparent;content:"";}
.leaflet-tooltip-bottom{margin-top:6px;}
.leaflet-tooltip-top{margin-top:-6px;}
.leaflet-tooltip-bottom:before,.leaflet-tooltip-top:before{left:50%;margin-left:-6px;}
.leaflet-tooltip-top:before{bottom:0;margin-bottom:-12px;border-top-color:#fff;}
.leaflet-tooltip-bottom:before{top:0;margin-top:-12px;margin-left:-6px;border-bottom-color:#fff;}
.leaflet-tooltip-left{margin-left:-6px;}
.leaflet-tooltip-right{margin-left:6px;}
.leaflet-tooltip-left:before,.leaflet-tooltip-right:before{top:50%;margin-top:-6px;}
.leaflet-tooltip-left:before{right:0;margin-right:-12px;border-left-color:#fff;}
.leaflet-tooltip-right:before{left:0;margin-left:-12px;border-right-color:#fff;}
`;
    document.head.appendChild(style);
}

// ─── Visual ────────────────────────────────────────────────────────────────────
export class Visual implements IVisual {

    private static ensureLeafletCSS = injectLeafletCSS;
    private host: IVisualHost;
    private selMgr: ISelectionManager;
    /** Zona o area resaltada al pulsar su tarjeta (para comprobar el reparto). */
    private focus: { kind: "area" | "terr"; id: number } | null = null;
    /** El foco actual se envio como filtro de columna (no como seleccion por filas). */
    private focusViaFilter = false;
    /** Filtros que Power BI dice que tiene este visual (marcador, informe guardado). */
    private hostFilters: powerbi.IFilter[] = [];
    /** Hasta el primer calculo: el estado guardado (marcador) no se borra al calcular. */
    private restoring = true;
    /** Id de seleccion por fila del dataView, para filtrar otros visuales desde la tarjeta. */
    private rowSel: ISelectionId[] = [];
    /** Columnas Area y Postal code del modelo (tabla y columna) para filtrar con el Filter API. */
    private areaCol: { table: string; column: string } | null = null;
    private postalCol: { table: string; column: string } | null = null;
    /** Valor original (con su tipo: un codigo postal numerico sigue siendo numero) por texto. */
    private rawArea = new Map<string, powerbi.PrimitiveValue>();
    private rawPostal = new Map<string, powerbi.PrimitiveValue>();
    /** Hay un filtro nuestro aplicado (o guardado con el informe). */
    private filterOn = false;
    /** Hay una seleccion por filas enviada (solo entonces se limpia). */
    private selOn = false;
    private container: HTMLElement;
    private barContainer: HTMLElement;
    private mapContainer: HTMLElement;
    private panelContainer: HTMLElement;
    /** Orden de las tarjetas: por numero (para buscar una) o por desviacion (para revisar). */
    private overlay: HTMLElement;
    private map: L.Map | null = null;
    private settings: VisualSettings;
    private events: powerbi.extensibility.IVisualEventService;
    private lastPoints: ClusterPoint[] = [];
    private lastResult: ZoningResult | null = null;
    private lastAreas: { res: AreaZoningResult; names: string[] } | null = null;
    private lastOutliers = 0;
    /** Sin areas definidas: solo puntos y aviso, sin calcular territorios. */
    private waitingAreas = false;
    private lastBounds: L.LatLngBounds | null = null;
    private resizeObserver: ResizeObserver | null = null;
    private hoverTip: L.Tooltip | null = null;

    /** Parametros VIVOS: los de la barra. Arrancan de los del panel de formato. */
    private live: IClusterSettings | null = null;
    private inputs: { [k in keyof IClusterSettings]?: HTMLInputElement } = {};
    private editing = false;
    /** Alto contraste de Power BI: si esta activo, todo se pinta con sus tres colores. */
    private hc = { on: false, fg: "#000000", bg: "#FFFFFF", sel: "#000000" };
    private loc!: ILocalizationManager;
    private fmtService!: FormattingSettingsService;
    // ── Licencia ──
    private isPro = false; // ISPRO_MARKER
    private licenseManager: powerbi.extensibility.IVisualLicenseManager | undefined;
    private licenseRequested = false;
    private licenseResolved = false;
    private licenseEnvUnsupported = false;
    private attemptedPro: string[] = [];
    private notifiedPro: string[] = [];
    private noticeShown = false;
    private licenseIconTimer: number | null = null;
    private watermarkEl!: HTMLDivElement;
    /** Nota en el mapa cuando se ignoran campos Pro (lectura sin licencia). */
    private proNote = "";
    /** Postal code ignorado por no ser geografico (areas.ts): ni unidades ni filtro por codigo. */
    private postalIgnored = false;
    /** El filtro de area por Postal code es exacto (ningun codigo partido entre areas). */
    private postalFilterOk = true;
    /** Parte de la clave de datos: el reparto cambia si los campos Pro se aplican o no. */
    private proKey = "free";
    private lastOptions: VisualUpdateOptions | null = null;
    private emitEvents = true;
    /** Firma de los datos del ultimo calculo, para no recalcular en un simple resize. */
    private dataKey = "";
    private computeGen = 0;

    private static readonly PANEL_H = 0;     // px: sin panel inferior (usuario, 30-09-2026: la leyenda basta)
    private static readonly BAR_H = 36;      // px

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.selMgr = options.host.createSelectionManager();
        // MARCADORES (seleccion por filas): Power BI devuelve las filas seleccionadas al aplicar
        // un marcador; el foco se re-deriva de ellas sin volver a enviarlas.
        this.selMgr.registerOnSelectCallback((ids: ISelectionId[]) => this.restoreFocusFromSelection(ids));
        this.events = options.host.eventService;
        this.settings = new VisualSettings();
        // localizacion: panel de formato y textos del visual en el idioma de Power BI
        this.loc = options.host.createLocalizationManager();
        this.fmtService = new FormattingSettingsService(this.loc);
        Visual.ensureLeafletCSS();

        this.container = document.createElement("div");
        this.container.className = "cw-root";
        this.container.style.cssText =
            "position:absolute;top:0;left:0;right:0;bottom:0;" +
            "overflow:hidden;font-family:'Segoe UI',sans-serif;box-sizing:border-box;";

        // Barra de controles ARRIBA, dentro del visual. El panel de formato solo existe en
        // diseno; el reparto tiene que poder cambiarse en vista de lectura, que es donde
        // el director de ventas prueba "y si fueran 120 horas". Cada cambio recalcula.
        this.barContainer = document.createElement("div");
        this.barContainer.className = "cw-bar";
        this.barContainer.style.cssText =
            `position:absolute;top:0;left:0;right:0;height:${Visual.BAR_H}px;` +
            "display:flex;align-items:center;gap:10px;padding:0 10px;box-sizing:border-box;" +
            "background:#FAF9F5;border-bottom:1px solid #DAD9D4;font-size:11px;color:#535146;white-space:nowrap;overflow:hidden;";

        this.mapContainer = document.createElement("div");
        this.mapContainer.className = "cw-map";
        this.mapContainer.style.cssText =
            `position:absolute;top:${Visual.BAR_H}px;left:0;right:0;overflow:hidden;`;

        this.panelContainer = document.createElement("div");
        this.panelContainer.className = "cw-panel";
        this.panelContainer.style.cssText =
            `position:absolute;bottom:0;left:0;right:0;height:${Visual.PANEL_H}px;` +
            "overflow-y:auto;overflow-x:hidden;" +
            "background:#FAF9F5;border-top:1px solid #DAD9D4;padding:6px 10px;box-sizing:border-box;";

        // Velo de "calculando": el reparto tarda segundos con decenas de miles de puntos y
        // el usuario tiene que ver que algo pasa. Sin red: es un div.
        this.overlay = document.createElement("div");
        this.overlay.style.cssText =
            "position:absolute;left:0;right:0;display:none;align-items:center;justify-content:center;" +
            `top:${Visual.BAR_H}px;bottom:${Visual.PANEL_H}px;background:rgba(250,249,245,0.75);` +
            "font-size:13px;color:#3D3929;z-index:20;pointer-events:none;";

        this.buildBar();
        // menu contextual general en el resto del visual (leyenda, bienvenida). En la barra no:
        // ahi el clic derecho es el del navegador, para copiar y pegar en los campos.
        this.container.addEventListener("contextmenu", (e: MouseEvent) => {
            if (e.defaultPrevented || this.barContainer.contains(e.target as Node)) return;
            e.preventDefault();
            if (this.host.hostCapabilities?.allowInteractions === false) return;
            this.selMgr.showContextMenu({} as ISelectionId, { x: e.clientX, y: e.clientY });
        });
        this.container.appendChild(this.barContainer);
        this.container.appendChild(this.mapContainer);
        this.panelContainer.style.display = "none";
        this.container.appendChild(this.panelContainer);
        this.container.appendChild(this.overlay);

        // Marca de agua "Pro preview" (patron de la cartera): solo editando, sin licencia, con
        // la licencia ya resuelta y con alguna funcion Pro en uso. No intercepta clics.
        this.licenseManager = options.host.licenseManager;
        this.watermarkEl = document.createElement("div");
        this.watermarkEl.setAttribute("aria-hidden", "true");
        this.watermarkEl.textContent = "Pro preview";
        this.watermarkEl.style.cssText =
            "position:absolute;left:0;top:0;right:0;bottom:0;display:none;align-items:center;" +
            "justify-content:center;pointer-events:none;z-index:1100;font:700 32px 'Segoe UI',sans-serif;" +
            "color:#FFFFFF;opacity:0.55;transform:rotate(-20deg);" +
            "text-shadow:0 0 2px rgba(51,51,51,0.85),0 1px 3px rgba(51,51,51,0.65);";
        this.container.appendChild(this.watermarkEl);
        // Marca de compilacion SOLO en builds de test (build-test.js la rellena): Desktop a veces
        // sigue usando un visual anterior al reimportar la misma version, y sin la marca no se
        // sabe que se esta probando. En produccion la cadena es vacia y no se pinta nada.
        const TEST_STAMP = ""; // TEST_STAMP_MARKER
        if (TEST_STAMP) {
            const st = document.createElement("div");
            st.style.cssText = "position:absolute;right:4px;bottom:2px;z-index:2000;font:10px 'Segoe UI',sans-serif;color:#8a8880;pointer-events:none;";
            st.textContent = TEST_STAMP;
            this.container.appendChild(st);
        }
        options.element.appendChild(this.container);

        if (typeof ResizeObserver !== "undefined") {
            this.resizeObserver = new ResizeObserver(() => {
                if (this.map && this.lastBounds) {
                    this.map.invalidateSize();
                    this.map.fitBounds(this.lastBounds, { padding: [24, 24] });
                    this.rescaleBadges();
                }
            });
            this.resizeObserver.observe(this.container);
        }
    }

    // ── Barra de controles ─────────────────────────────────────────────────────
    private buildBar(): void {
        const campo = (key: keyof IClusterSettings, label: string, step: number, min: number, max: number, width: number) => {
            const wrap = document.createElement("label");
            wrap.style.cssText = "display:flex;align-items:center;gap:4px;";
            const txt = document.createElement("span");
            txt.textContent = label;
            const inp = document.createElement("input");
            inp.type = "number"; inp.step = String(step); inp.min = String(min); inp.max = String(max);
            inp.style.cssText = `width:${width}px;font:11px 'Segoe UI',sans-serif;padding:2px 4px;border:1px solid #C9C7BF;border-radius:3px;`;
            inp.setAttribute("aria-label", label);
            inp.addEventListener("change", () => this.onBarChange());
            inp.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Enter") this.onBarChange(); });
            wrap.appendChild(txt); wrap.appendChild(inp);
            this.barContainer.appendChild(wrap);
            this.inputs[key] = inp;
        };
        campo("capacityHours", this.t("Prop_Capacity", "Hours / salesperson / month"), 5, 1, 10000, 58);
        campo("speedKmh", this.t("UI_Kmh", "km/h"), 5, 1, 200, 44);
        campo("detour", this.t("UI_Road", "Road ×"), 0.1, 1, 3, 44);
        campo("areas", this.t("UI_Areas", "Areas"), 1, 0, 500, 44);

        // botones sobrios (gris pizarra); Exportar tambien en la barra
        const boton = (texto: string, principal: boolean, accion: () => void): HTMLButtonElement => {
            const b = document.createElement("button");
            b.type = "button"; b.textContent = texto;
            b.style.cssText = principal
                ? "padding:4px 12px;background:#2F3B45;color:#fff;border:1px solid #2F3B45;border-radius:3px;cursor:pointer;" +
            "font:600 11px 'Segoe UI',sans-serif;letter-spacing:.2px;"
                : "padding:4px 12px;background:#fff;color:#2F3B45;border:1px solid #9AA5AE;border-radius:3px;cursor:pointer;font:600 11px 'Segoe UI',sans-serif;letter-spacing:.2px;";
            b.addEventListener("mouseenter", () => { b.style.filter = "brightness(1.12)"; });
            b.addEventListener("mouseleave", () => { b.style.filter = ""; });
            b.addEventListener("click", accion);
            this.barContainer.appendChild(b);
            return b;
        };
        boton(this.t("UI_Recalculate", "Recalculate"), true, () => this.onBarChange(true));
        boton(this.t("UI_Export", "Export CSV (Pro)"), false, () => { if (this.lastPoints.length) this.exportCSV(this.lastPoints); });
        boton(this.t("UI_ExportPdf", "Export map PDF (Pro)"), false, () => { if (this.lastPoints.length) this.exportPDF(); });
    }

    private readBar(): IClusterSettings | null {
        if (!this.live) return null;
        const g = (key: keyof IClusterSettings, lo: number, hi: number) => {
            const inp = this.inputs[key];
            const v = inp ? Number(inp.value) : NaN;
            return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : this.live![key];
        };
        return {
            capacityHours: g("capacityHours", 1, 10000),
            tolerance: this.live!.tolerance,
            speedKmh: g("speedKmh", 1, 200),
            detour: g("detour", 1, 3),
            areas: Math.round(g("areas", 0, 500)),
            outlierKm: this.live!.outlierKm,
            workDays: this.live.workDays
        };
    }

    private writeBar(s: IClusterSettings): void {
        (Object.keys(s) as (keyof IClusterSettings)[]).forEach(k => {
            const inp = this.inputs[k];
            if (inp) inp.value = String(s[k]);
        });
    }

    private onBarChange(force = false): void {
        const nuevo = this.readBar();
        if (!nuevo) return;
        const cambio = !this.live || (Object.keys(nuevo) as (keyof IClusterSettings)[]).some(k => nuevo[k] !== this.live![k]);
        if (!cambio && !force) return;
        this.live = nuevo;
        this.writeBar(nuevo);
        // En edicion, el valor se guarda en el informe para que el lector arranque de ahi.
        // En lectura NO se escribe nada: el lector explora, no le cambia el informe a nadie.
        if (this.editing) {
            this.host.persistProperties({
                merge: [{ objectName: "clusterSettings", selector: (null as any), properties: (({ tolerance, ...resto }) => { void tolerance; return resto; })(nuevo) }]
            } as powerbi.VisualObjectInstancesToPersist);
        }
        if (this.lastPoints.length) this.compute(this.lastPoints);
    }

    // ── Update ──────────────────────────────────────────────────────────────────
    public update(options: VisualUpdateOptions): void {
        this.lastOptions = options;
        this.run(options, true);
    }

    /** Eventos de render solo cuando llama Power BI, no al repintar porque llego la licencia. */
    private finished(options: VisualUpdateOptions): void {
        if (this.emitEvents) this.events.renderingFinished(options);
    }

    private run(options: VisualUpdateOptions, emit: boolean): void {
        this.emitEvents = emit;
        if (emit) this.events.renderingStarted(options);
        try {
            const vp = options.viewport;
            const mapH = Math.max(100, (vp?.height ?? 400) - Visual.PANEL_H - Visual.BAR_H);
            this.mapContainer.style.height = `${mapH}px`;
            void this.mapContainer.offsetHeight;

            const vm = (options as any).viewMode;
            this.editing = typeof vm === "number" && vm !== 0;

            // ALTO CONTRASTE: se lee en cada update (el usuario puede cambiar el tema de Windows
            // con el informe abierto) y se aplica al pintar, sin tocar los ajustes del panel:
            // al salir del tema vuelven los colores del usuario.
            const pal = this.host.colorPalette as powerbi.extensibility.ISandboxExtendedColorPalette;
            const hcOn = !!pal?.isHighContrast;
            const hcChanged = hcOn !== this.hc.on;
            this.hc = hcOn
                ? { on: true, fg: pal.foreground?.value ?? "#FFFFFF", bg: pal.background?.value ?? "#000000", sel: pal.foregroundSelected?.value ?? pal.foreground?.value ?? "#FFFF00" }
                : { on: false, fg: "#000000", bg: "#FFFFFF", sel: "#000000" };
            if (hcChanged) this.applyContrastChrome();

            const dataView = options?.dataViews?.[0];
            if (!dataView?.table?.rows?.length) {
                this.showLanding();
                this.finished(options);
                return;
            }

            // Power BI entrega como mucho 30.000 filas por llamada. Si el modelo tiene mas,
            // el dataView viene marcado como segmento y se piden las siguientes (agregadas
            // sobre las anteriores); se calcula cuando ya no quedan, o cuando Power BI dice
            // que no cabe mas en memoria. Con "top" no habia segmento y 40.000 puntos se
            // quedaban en 30.000 sin avisar.
            if (dataView.metadata?.segment && this.host.fetchMoreData(true)) {
                this.overlay.textContent = this.tf("UI_Loading", "Loading points… {0} so far", dataView.table.rows.length.toLocaleString());
                this.overlay.style.display = "flex";
                this.finished(options);
                return;
            }

            const settings = VisualSettings.parse(dataView);
            const settingsKey = JSON.stringify(settings.clusterSettings);
            const prevKey = JSON.stringify(this.settings.clusterSettings);
            // cambios solo de aspecto (circulos de area, tamano de punto): redibujar sin recalcular
            const looksChanged = JSON.stringify([settings.areaBadges, settings.mapSettings]) !== JSON.stringify([this.settings.areaBadges, this.settings.mapSettings]);
            this.settings = settings;
            // Los valores vivos arrancan del panel de formato, y se resincronizan solo si el
            // autor los cambia ahi: un resize no puede pisar lo que el lector ha tecleado.
            if (!this.live || settingsKey !== prevKey) {
                this.live = { ...settings.clusterSettings };
                this.writeBar(this.live);
            }

            // MARCADORES: el filtro de area viaja con el marcador y con el informe guardado
            this.hostFilters = options.jsonFilters ?? [];
            if (this.hostFilters.length) this.filterOn = true;
            const points = this.parseData(dataView);
            if (points.length === 0) {
                this.showLanding();
                this.finished(options);
                return;
            }

            // ── FREE / PRO ─────────────────────────────────────────────────────────────
            // Gratis: areas automaticas y la velocidad de la barra, resultado completo y correcto.
            // Pro: areas propias (pozo Area) y velocidad por punto (pozo Speed). Sin licencia,
            // editando, se ven funcionando bajo la marca "Pro preview"; en lectura se ignoran y
            // una nota lo dice. Con campos Pro puestos se espera a la licencia antes de calcular:
            // repartir 30.000 puntos dos veces seria peor que esperar un instante.
            const usesArea = points.some(p => p.area != null && p.area !== "");
            const usesSpeed = points.some(p => p.speedKmh != null);
            this.attemptedPro = this.isPro ? [] : [...(usesArea ? [PRO_AREAS] : []), ...(usesSpeed ? [PRO_SPEED] : [])];
            this.requestLicenseDeferred();
            if (this.attemptedPro.length && !this.licenseResolved) {
                this.overlay.textContent = this.t("UI_CheckingLicence", "Checking licence…");
                this.overlay.style.display = "flex";
                this.finished(options);
                return;
            }
            if (this.overlay.textContent === this.t("UI_CheckingLicence", "Checking licence…")) this.overlay.style.display = "none";
            const proOn = this.isPro || this.isPreview();
            this.proNote = "";
            if (this.attemptedPro.length && !proOn) {
                for (const p of points) { p.area = undefined; p.speedKmh = undefined; }
                const es = this.isSpanish();
                const items = es ? this.attemptedPro.map(a => ES_LABELS[a] || a) : this.attemptedPro;
                this.proNote = es
                    ? `${items.join(" y ")}: plan Pro. Esta vista usa areas automaticas y la velocidad de la barra.`
                    : `${items.join(" and ")}: Pro plan. This view uses automatic areas and the speed in the bar.`;
            }
            this.proKey = this.attemptedPro.length && proOn ? "pro" : "free";
            this.updateWatermark();
            this.syncLicenseNotification();

            // Solo se recalcula si han cambiado los DATOS. Power BI llama a update() en cada
            // resize; volver a repartir 40.000 puntos por mover un borde seria absurdo.
            // La clave incluye QUE columnas hay y la carga total: anadir Visits y Minutes con
            // los mismos clientes no cambiaba filas ni ids, y el visual se quedaba con el
            // reparto de "1 h por cliente" mientras el aviso decia que faltaba la carga.
            const rows = dataView.table!.rows;
            const last = points[points.length - 1];
            const cols = dataView.table!.columns.map(c => Object.keys(c.roles ?? {}).join("+")).join(",");
            let carga = 0;
            for (const p of points) carga += (p.visits ?? 0) * 1000 + (p.minutes ?? 0) + p.value + (p.speedKmh ?? 0) * 0.001;
            const key = `${rows.length}|${cols}|${carga}|${points[0].customerId}|${last.customerId}|${points[0].lat}|${last.lon}|${this.proKey}`;
            if (key !== this.dataKey || !this.lastResult) {
                this.dataKey = key;
                this.lastPoints = points;
                // renderingFinished ANTES del calculo: Power BI cuenta el tiempo de render y
                // un reparto de segundos con el reloj corriendo es un visual "que no responde".
                this.finished(options);
                this.compute(points);
                return;
            }
            // mismos datos: un marcador puede traer otro filtro (u otro ninguno)
            if (this.restoreFocusFromFilters()) { this.finished(options); return; }
            // mismos datos: si solo cambio el aspecto, redibujar el mapa manteniendo la vista
            if ((looksChanged || hcChanged) && (this.lastResult || this.waitingAreas) && this.map) {
                this.renderMap(this.lastPoints, true);
                this.finished(options);
                return;
            }
            // mismos datos: solo reajustar el mapa (y el tamano de los circulos de area)
            if (this.map && this.lastBounds) {
                this.map.invalidateSize();
                this.map.fitBounds(this.lastBounds, { padding: [24, 24] });
                this.rescaleBadges();
            }
            this.finished(options);
        } catch (e) {
            if (this.emitEvents) this.events.renderingFailed(options, String(e));
        }
    }

    /** Calcula fuera del hilo de render: primero pinta el velo, luego reparte, luego dibuja. */
    private compute(points: ClusterPoint[]): void {
        if (!this.live) return;
        const live = this.live;
        this.overlay.textContent = this.tf("UI_Balancing", "Balancing {0} points…", points.length.toLocaleString());
        this.overlay.style.display = "flex";
        const gen = ++this.computeGen;
        this.focus = null;
        this.focusViaFilter = false;
        // la seleccion enviada a otros visuales (clic en leyenda o circulo) es de un reparto
        // que va a cambiar: se limpia, o una tarjeta externa seguiria filtrada por un area vieja.
        // En el PRIMER calculo no: es el informe abriendose o un marcador, y su filtro se
        // restaura al terminar.
        if (!this.restoring) {
            this.clearSelection();
            this.clearFilter();
        }
        setTimeout(() => {
            if (gen !== this.computeGen) return;          // llego otro cambio mientras tanto
            try {
                const opt = {
                    capacityHours: live.capacityHours,
                    // DIMENSIONAMIENTO (usuario, 30-09-2026): sin banda. El tope de un territorio
                    // propuesto son las horas del comercial; nadie propuesto por encima de su jornada.
                    tolerance: 0,
                    speedKmh: live.speedKmh,
                    detour: live.detour,
                    // REPARTO POR CRECIMIENTO (regla del usuario): del foco mas denso hacia
                    // fuera, cada zona toma los clientes mas cercanos hasta llenar un comercial;
                    // lo que sobra, para el siguiente foco; lo que sobra de una zona son los
                    // mas lejanos de su centroide. Sin reequilibrar despues: el diagrama de
                    // potencia igualaba las zonas y vaciaba los cascos.
                    growthOnly: true,
                    // TODO cliente entra en un territorio: el radio ya no deja clientes fuera
                    // (en un visual que dimensiona plantilla, sus horas tienen que contar). Los
                    // outliers se marcan aparte, solo si el usuario pone "Outlier km".
                    outlierKm: 1e6,
                    workDays: live.workDays,
                    rounds: 12
                };
                // OUTLIERS fuera antes de nada: clientes tan apartados que no son de ningun
                // territorio (tercer vecino a mas de "Outlier km"). Se marcan y no entran.
                for (const p of points) { p.clusterId = -1; p.outlier = false; }
                this.lastOutliers = markOutliers(points, live.outlierKm);
                const work = this.lastOutliers ? points.filter(p => !p.outlier) : points;
                // AREAS primero: del pozo Area si esta; si no, automaticas por carga (campo Areas
                // de la barra); sin ninguna de las dos, un solo reparto. Los territorios se
                // calculan DENTRO de cada area y nunca la cruzan.
                const hasField = work.some(p => p.area != null && p.area !== "");
                // SIN AREAS NO SE CALCULA (usuario, 30-09-2026): con solo latitud y longitud se
                // muestran los puntos y se pide definir las areas; los territorios se calculan
                // al tenerlas.
                if (!hasField && live.areas < 1) {
                    this.lastAreas = null; this.lastResult = null; this.waitingAreas = true;
                    this.renderMap(points);
                    this.restoring = false;
                    return;
                }
                this.waitingAreas = false;
                let res: ZoningResult;
                if (hasField || live.areas >= 1) {
                    // AREAS a nivel de CODIGO POSTAL (si viene): del campo Area (cada codigo al
                    // area de la mayoria de sus clientes) o automaticas (codigos vecinos
                    // agrupados en el numero de areas de la barra, de una sola pieza)
                    const hasPostal = work.some(p => p.postal != null && p.postal !== "");
                    // automaticas: solo se unen estados con frontera terrestre comun (sin cruzar golfos ni mares)
                    // y ningun territorio cruza de una isla a otra (masa de tierra de cada punto)
                    const geo = regionsOfPoints(work);
                    const built = buildAreas(work, hasPostal ? (p => p.postal) : null, hasField ? "field" : "auto", live.areas,
                        hasField ? null : geo.state);
                    // areas automaticas con nombre en el idioma del informe ("Area 1" / "Área 1")
                    // codigo no geografico, o alguno partido por pueblos: el filtro por codigo dejaria de ser
                    // exacto (un codigo en dos areas), asi que el filtro de area pasa a filas
                    this.postalIgnored = !!built.postalIgnored;
                    this.postalFilterOk = !built.postalIgnored && !built.postalSplit;
                    const areaOf = built.areaOf, names = hasField ? built.names : (() => { let k = 0; return built.names.map((_, j) => built.fixedNames?.[j] ?? this.tf("UI_AreaN", "Area {0}", ++k)); })();
                    void geographicAreas;
                    const ar = clusterByArea(work, areaOf, names.length, opt, geo.land);
                    this.lastAreas = { res: ar, names };
                    res = ar;
                } else {
                    this.lastAreas = null;
                    res = clusterPoints(work, opt);
                }
                this.lastResult = res;
                this.renderMap(points);
                this.restoring = false;
                this.restoreFocusFromFilters();
            } finally {
                this.overlay.style.display = "none";
            }
        }, 0);
    }

    // ── Data parsing ────────────────────────────────────────────────────────────
    private parseData(dataView: powerbi.DataView): ClusterPoint[] {
        const table = dataView.table!;
        const cols = table.columns;
        const idx = (role: string) => cols.findIndex(c => c.roles?.[role]);
        const idIdx = idx("customer_id"), latIdx = idx("latitude"), lonIdx = idx("longitude");
        const valIdx = idx("value"), visIdx = idx("visits"), minIdx = idx("minutes"), areaIdx = idx("area"), spdIdx = idx("speed"), postIdx = idx("postal");
        // columnas del pozo Tooltips (puede haber varias)
        const tipCols: { i: number; name: string }[] = [];
        cols.forEach((c, i) => { if (c.roles?.["tooltips"]) tipCols.push({ i, name: c.displayName }); });
        const fmt = (v: unknown): string => typeof v === "number" ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : v == null ? "" : String(v);
        if (latIdx === -1 || lonIdx === -1) return [];
        // destino del filtro: queryName es "Tabla.Columna" en una columna agrupada
        const target = (i: number): { table: string; column: string } | null => {
            if (i < 0) return null;
            // 1) la expresion de la columna: { source: { entity: "Tabla" }, ref: "Columna" }. Es lo
            //    que usan los segmentadores; el API la declara opaca, asi que se comprueba la forma.
            const ex = cols[i].expr as unknown as { source?: { entity?: unknown }; ref?: unknown } | undefined;
            if (ex && ex.source && typeof ex.source.entity === "string" && typeof ex.ref === "string") {
                return { table: ex.source.entity, column: ex.ref };
            }
            // 2) respaldo: queryName "Tabla.Columna"
            const q = cols[i].queryName ?? "";
            // agregado ("Sum(Tabla.Col)") o medida sin tabla: sin filtro. Un parentesis en el
            // NOMBRE de la tabla ("ventas (2)") es valido: solo se descarta la forma Funcion(...)
            if (/^[A-Za-z]+\(.*\)$/.test(q)) return null;
            const dot = q.indexOf(".");
            if (dot <= 0 || dot === q.length - 1) return null;
            return { table: q.substring(0, dot), column: q.substring(dot + 1) };
        };
        this.areaCol = target(areaIdx);
        this.postalCol = target(postIdx);
        this.rawArea.clear(); this.rawPostal.clear();

        const result: ClusterPoint[] = [];
        this.rowSel = [];
        for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex++) {
            const row = table.rows[rowIndex];
            this.rowSel.push(this.host.createSelectionIdBuilder().withTable(table, rowIndex).createSelectionId());
            const lat = Number(row[latIdx]);
            const lon = Number(row[lonIdx]);
            if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
            const visits = visIdx >= 0 ? Number(row[visIdx]) : NaN;
            const minutes = minIdx >= 0 ? Number(row[minIdx]) : NaN;
            const value = valIdx >= 0 ? Number(row[valIdx]) : NaN;
            if (areaIdx >= 0 && row[areaIdx] != null) this.rawArea.set(String(row[areaIdx]), row[areaIdx]);
            if (postIdx >= 0 && row[postIdx] != null) this.rawPostal.set(String(row[postIdx]), row[postIdx]);
            result.push({
                customerId: idIdx >= 0 ? String(row[idIdx] ?? "") : "",
                lat, lon,
                value: isFinite(value) && value > 0 ? value : 1,
                visits: isFinite(visits) && visits > 0 ? visits : undefined,
                minutes: isFinite(minutes) && minutes > 0 ? minutes : undefined,
                area: areaIdx >= 0 && row[areaIdx] != null ? String(row[areaIdx]) : undefined,
                postal: postIdx >= 0 && row[postIdx] != null ? String(row[postIdx]) : undefined,
                tips: tipCols.length ? tipCols.map(tc => ({ name: tc.name, value: fmt(row[tc.i]) })) : undefined,
                speedKmh: spdIdx >= 0 && isFinite(Number(row[spdIdx])) && Number(row[spdIdx]) > 0 ? Number(row[spdIdx]) : undefined,
                rowIndex,
                clusterId: -1
            });
        }
        // Orden fijo por customer_id: Power BI entrega las filas en el orden que le conviene y
        // las semillas dependen del orden. Sin esto, el mismo dataset daba repartos distintos
        // en Desktop y en el harness, y "determinista" era verdad solo para el mismo orden.
        result.sort((p, q) => (p.customerId < q.customerId ? -1 : p.customerId > q.customerId ? 1 : 0));
        return result;
    }

    // ── Landing page ────────────────────────────────────────────────────────────
    private showLanding(): void {
        this.attemptedPro = [];
        if (this.watermarkEl) this.updateWatermark();
        this.destroyMap();
        while (this.mapContainer.firstChild) this.mapContainer.removeChild(this.mapContainer.firstChild);
        const landing = buildLanding((k, en) => this.t(k, en));
        if (this.hc.on) {
            // alto contraste: todo el texto de la bienvenida en primer plano sobre el fondo
            this.hcBox(landing);
            for (const el of Array.from(landing.querySelectorAll("div,b"))) (el as HTMLElement).style.color = this.hc.fg;
            for (const c of Array.from(landing.querySelectorAll("circle"))) c.setAttribute("fill", this.hc.fg);
        }
        this.mapContainer.appendChild(landing);
        while (this.panelContainer.firstChild) this.panelContainer.removeChild(this.panelContainer.firstChild);
        this.lastResult = null;
        this.dataKey = "";
    }

    // ── Map rendering ───────────────────────────────────────────────────────────
    private destroyMap(): void {
        this.badges = []; this.dots = [];
        if (this.map) {
            this.map.remove();
            this.map = null;
            this.hoverTip = null;
        }
    }

    /**
     * Factor de zoom: 1 con el mapa encuadrado a los datos (o mas cerca); al alejarlo, encoge a la
     * mitad cada 2 niveles, con suelo 0,35. Alejado, los puntos y los circulos tapaban el mapa.
     */
    private zoomScale(): number {
        if (!this.map || !this.lastBounds) return 1;
        const fit = this.map.getBoundsZoom(this.lastBounds, false, L.point(48, 48));
        return Math.max(0.35, Math.min(1, Math.pow(2, (this.map.getZoom() - fit) * 0.5)));
    }
    private dots: { mk: L.CircleMarker; r: number }[] = [];
    private lastZoomScale = 1;
    private applyZoomScale(): void {
        const z = this.zoomScale();
        if (Math.abs(z - this.lastZoomScale) > 0.01) {
            for (const d of this.dots) d.mk.setRadius(Math.max(0.5, d.r * z));
            this.lastZoomScale = z;
        }
        this.rescaleBadges();
    }

    /** Circulos de area: el tamano escala con el del visual, con el zoom y con la fuente configurada. */
    private badges: { mk: L.Marker; el: HTMLElement; txt: string }[] = [];
    private measureCtx: CanvasRenderingContext2D | null = null;
    private rescaleBadges(): void {
        if (!this.badges.length) return;
        const ab = this.settings.areaBadges;
        const w = this.mapContainer.clientWidth || 600, h = this.mapContainer.clientHeight || 400;
        const k = Math.max(0.45, Math.min(1.3, Math.min(w, h) / 480)) * this.zoomScale();   // 480 px = tamano configurado
        const fs = Math.max(7, ab.fontSize * k), bw = Math.max(ab.borderWidth > 0 ? 1 : 0, ab.borderWidth * k);
        // diametro = ancho REAL del texto + un margen corto (antes se estimaba por numero de
        // caracteres y el circulo quedaba holgado alrededor del numero)
        const ctx = (this.measureCtx ??= document.createElement("canvas").getContext("2d"));
        if (ctx) ctx.font = `700 ${fs.toFixed(1)}px ${ab.fontFamily}`;
        for (const b of this.badges) {
            const tw = ctx ? ctx.measureText(b.txt).width : fs * 0.58 * b.txt.length;
            const size = Math.round(Math.max(fs * 1.9, tw + fs * 0.75) + 2 * bw);
            // rectangulo: ancho del texto + margen, alto de una linea, esquinas suaves
            const rect = ab.shape === "rect";
            const wpx = rect ? Math.round(tw + fs * 0.9 + 2 * bw) : size, hpx = rect ? Math.round(fs * 1.55 + 2 * bw) : size;
            const fill = this.hc.on ? this.hc.bg : ab.fillColor, text = this.hc.on ? this.hc.fg : ab.textColor, line = this.hc.on ? this.hc.fg : ab.borderColor;
            b.el.style.cssText = `width:${wpx}px;height:${hpx}px;border-radius:${rect ? Math.round(fs * 0.35) + "px" : "50%"};background:${fill};color:${text};` +
                `border:${Math.max(this.hc.on ? 1 : 0, bw).toFixed(1)}px solid ${line};box-sizing:border-box;display:flex;align-items:center;justify-content:center;` +
                `font-weight:700;font-size:${fs.toFixed(1)}px;font-family:${ab.fontFamily};box-shadow:0 1px 3px rgba(0,0,0,0.18);cursor:pointer;`;
            b.mk.setIcon(L.divIcon({ html: b.el, className: "", iconSize: [wpx, hpx], iconAnchor: [wpx / 2, hpx / 2] }));
        }
    }

    /** Un punto esta en foco si no hay foco, o si pertenece a la zona/area pulsada. */
    private inFocus(p: ClusterPoint): boolean {
        if (!this.focus) return true;
        if (p.clusterId < 0) return false;
        if (this.focus.kind === "terr") return p.clusterId === this.focus.id;
        const reg = this.lastAreas;
        return !!reg && reg.res.areaOfTerritory[p.clusterId] === this.focus.id;
    }

    /** Pulsar una tarjeta: foco en esa zona/area (otra vez = quitar). Mantiene el zoom. */
    private toggleFocus(kind: "area" | "terr", id: number): void {
        const same = this.focus && this.focus.kind === kind && this.focus.id === id;
        this.focus = same ? null : { kind, id };
        const points = this.lastPoints;
        this.renderMap(points, true);

        // seleccion de Power BI: filtra otros visuales con los clientes de la zona (si el
        // informe lo permite); sin foco, se limpia
        if (this.host.hostCapabilities?.allowInteractions === false) return;
        if (!this.focus) { this.clearSelection(); this.clearFilter(); this.focusViaFilter = false; return; }

        // FILTRO POR AREA (usuario, 30-09-2026: "el filtro externo le cuesta muchisimo"). Una
        // seleccion con una identidad por cliente obliga a Power BI a mandar miles de filas a
        // cada visual. Un filtro de columna es una sola condicion:
        //   - area del campo Area: Area = "Aragon";
        //   - area automatica: Postal code IN (los codigos del area), que son enteros por area.
        // Sin ninguna de las dos columnas, la seleccion por filas de siempre.
        if (kind === "area" && this.lastAreas) {
            const reg = this.lastAreas;
            let f: { table: string; column: string } | null = null;
            const vals = new Set<powerbi.PrimitiveValue>();
            if (this.areaCol && points.some(p => p.area != null)) {
                // el nombre de un area de campo es el valor de la columna ("(no area)" = vacio)
                const raw = this.rawArea.get(reg.names[id]);
                if (raw !== undefined) { f = this.areaCol; vals.add(raw); }
            } else if (this.postalCol && this.postalFilterOk) {
                f = this.postalCol;
                for (const p of points) if (this.inFocus(p) && p.postal != null) { const r = this.rawPostal.get(p.postal); if (r !== undefined) vals.add(r); }
            }
            if (f && vals.size) {
                this.clearSelection();
                const filter = new BasicFilter({ table: f.table, column: f.column }, "In", [...vals] as (string | number | boolean)[]);
                this.host.applyJsonFilter(filter.toJSON(), "general", "filter", powerbi.FilterAction.merge);
                this.filterOn = true;
                this.focusViaFilter = true;
                return;
            }
        }
        this.clearFilter();
        this.focusViaFilter = false;
        const ids: ISelectionId[] = [];
        for (const p of points) if (this.inFocus(p) && p.rowIndex != null && this.rowSel[p.rowIndex]) ids.push(this.rowSel[p.rowIndex]);
        if (ids.length) { this.selMgr.select(ids, false); this.selOn = true; }
    }

    /**
     * Foco desde el filtro de columna que guarda el marcador. Devuelve true si ha cambiado el
     * foco (y ya se ha repintado). No vuelve a aplicar el filtro: ya lo tiene Power BI.
     */
    private restoreFocusFromFilters(): boolean {
        const reg = this.lastAreas;
        if (!reg || !this.map) return false;
        let target: number | null = null;
        const f = this.hostFilters[0] as { target?: { column?: string }; values?: unknown[] } | undefined;
        if (f && Array.isArray(f.values) && f.values.length) {
            const col = f.target?.column;
            const vals = new Set(f.values.map(v => String(v)));
            const points = this.lastPoints;
            if (this.areaCol && col === this.areaCol.column) {
                const i = reg.names.indexOf(String(f.values[0]));
                if (i >= 0) target = i;
            } else if (this.postalCol && col === this.postalCol.column) {
                // el area con mas clientes de esos codigos postales (son enteros por area)
                const cnt = new Map<number, number>();
                for (const p of points) if (p.clusterId >= 0 && p.postal != null && vals.has(p.postal)) {
                    const a = reg.res.areaOfTerritory[p.clusterId]; cnt.set(a, (cnt.get(a) ?? 0) + 1);
                }
                let best = -1; for (const [a, n] of cnt) if (best < 0 || n > (cnt.get(best) ?? 0)) best = a;
                if (best >= 0) target = best;
            }
        }
        let next = this.focus;
        if (target !== null) { next = { kind: "area", id: target }; this.focusViaFilter = true; }
        else if (!this.hostFilters.length && this.focusViaFilter) { next = null; this.focusViaFilter = false; }
        const same = (next === null && this.focus === null) || (!!next && !!this.focus && next.kind === this.focus.kind && next.id === this.focus.id);
        if (same) return false;
        this.focus = next;
        this.renderMap(this.lastPoints, true);
        return true;
    }

    /** Foco desde la seleccion por filas que devuelve un marcador. */
    private restoreFocusFromSelection(ids: ISelectionId[]): void {
        if (!this.lastAreas && !this.lastResult) return;
        if (!ids || !ids.length) {
            this.selOn = false;
            if (this.focus && !this.focusViaFilter) { this.focus = null; this.renderMap(this.lastPoints, true); }
            return;
        }
        const keys = new Set(ids.map(id => id.getKey()));
        const terr = new Map<number, number>(), area = new Map<number, number>();
        const reg = this.lastAreas;
        let n = 0;
        for (const p of this.lastPoints) {
            if (p.rowIndex == null || p.clusterId < 0) continue;
            const s = this.rowSel[p.rowIndex];
            if (!s || !keys.has(s.getKey())) continue;
            n++;
            terr.set(p.clusterId, (terr.get(p.clusterId) ?? 0) + 1);
            if (reg) { const a = reg.res.areaOfTerritory[p.clusterId]; area.set(a, (area.get(a) ?? 0) + 1); }
        }
        if (!n) return;
        const top = (m: Map<number, number>): number => { let b = -1; for (const [k, v] of m) if (b < 0 || v > (m.get(b) ?? 0)) b = k; return b; };
        // todas las filas de un mismo territorio: foco en el territorio; si no, en su area
        this.focus = terr.size === 1 || !reg ? { kind: "terr", id: top(terr) } : { kind: "area", id: top(area) };
        this.focusViaFilter = false;
        this.selOn = true;
        this.renderMap(this.lastPoints, true);
    }

    private clearSelection(): void {
        if (!this.selOn || !this.selMgr) return;
        this.selOn = false;
        this.selMgr.clear();
    }

    /** Quita nuestro filtro de columna, solo si hay uno (cada aplicacion provoca un update). */
    private clearFilter(): void {
        if (!this.filterOn) return;
        this.filterOn = false;
        this.host.applyJsonFilter(null as unknown as powerbi.IFilter, "general", "filter", powerbi.FilterAction.remove);
    }

    private renderMap(points: ClusterPoint[], keepView = false): void {
        const view = keepView && this.map ? { center: this.map.getCenter(), zoom: this.map.getZoom() } : null;
        this.destroyMap();
        while (this.mapContainer.firstChild) this.mapContainer.removeChild(this.mapContainer.firstChild);

        const mapEl = document.createElement("div");
        mapEl.style.cssText = `width:100%;height:100%;background:${this.hc.on ? this.hc.bg : "#f4f3ef"};`;
        this.mapContainer.appendChild(mapEl);

        let s = 90, n = -90, w = 180, e = -180;
        for (const p of points) { if (p.lat < s) s = p.lat; if (p.lat > n) n = p.lat; if (p.lon < w) w = p.lon; if (p.lon > e) e = p.lon; }
        const bounds = L.latLngBounds([s, w], [n, e]);

        // Sin mapa base, a proposito. Los tiles de OpenStreetMap eran la unica peticion de
        // red del visual: con privileges [] es rechazo seguro, y el servidor de tiles veia por
        // donde navegaba el usuario, en un visual que maneja direcciones de clientes. Las
        // zonas se leen igual sin callejero: lo que importa es la forma relativa.
        //
        // preferCanvas: 30.000 puntos como 30.000 <path> de SVG tardan decenas de segundos y
        // dejan el zoom inutilizable. En canvas es un solo elemento y se pinta en milisegundos.
        this.map = L.map(mapEl, { zoomControl: true, attributionControl: false, preferCanvas: true });
        const renderer = L.canvas({ padding: 0.3 });

        // Contornos EMBEBIDOS (Natural Earth, dominio publico): paises del mundo y estados /
        // provincias de todos los paises (src/outlines.ts). Orientacion sin callejero y sin ninguna peticion de red: los datos
        // van dentro del paquete. Solo se dibujan los anillos que tocan la zona de los datos.
        const pad = Math.max(1, (n - s) * 0.5), padX = Math.max(1, (e - w) * 0.5);
        const s0 = s - pad, n0 = n + pad, w0 = w - padX, e0 = e + padX;
        const drawRings = (rings: number[][], color: string, weight: number): void => {
            for (const r of rings) {
                let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
                for (let i = 0; i < r.length; i += 2) { const lo = r[i], la = r[i + 1]; if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo; if (la < minLat) minLat = la; if (la > maxLat) maxLat = la; }
                if (maxLat < s0 || minLat > n0 || maxLon < w0 || minLon > e0) continue;
                const pts: L.LatLngExpression[] = [];
                for (let i = 0; i < r.length; i += 2) pts.push([r[i + 1], r[i]]);
                L.polyline(pts, { renderer, color, weight, opacity: 1, interactive: false, smoothFactor: 1 }).addTo(this.map!);
            }
        };
        drawRings(OUTLINE_ADMIN1, this.hc.on ? this.hc.fg : "#d9d7cf", 0.6);
        drawRings(OUTLINE_COUNTRIES, this.hc.on ? this.hc.fg : "#bab8b0", 0.9);
        const r = this.settings.mapSettings.markerSize;
        const reg = this.lastAreas;
        // con areas, el color es el del area; el territorio se ve en el tooltip y el CSV
        const baseColor = (p: ClusterPoint): string => this.waitingAreas ? "#6B7B8C" : p.clusterId < 0 ? "#f4f3ef" : reg ? clusterColor(reg.res.areaOfTerritory[p.clusterId]) : clusterColor(p.clusterId);
        // alto contraste: puntos en primer plano; sin territorio, huecos (fondo con borde)
        const colorOf = (p: ClusterPoint): string => this.hc.on ? (p.clusterId < 0 ? this.hc.bg : this.hc.fg) : baseColor(p);
        if (this.proNote) {
            const pn = document.createElement("div");
            pn.style.cssText = "position:absolute;left:10px;bottom:10px;z-index:1001;max-width:60%;background:rgba(255,255,255,0.95);border:1px solid #D9D7CF;border-left:4px solid #C96442;border-radius:4px;padding:6px 9px;font:11px 'Segoe UI',sans-serif;color:#3B3A34;line-height:1.45;";
            pn.textContent = this.proNote;
            this.mapContainer.appendChild(pn);
        }
        if (this.postalIgnored && this.lastAreas) {
            const pg = document.createElement("div");
            pg.style.cssText = `position:absolute;left:10px;bottom:${this.proNote ? 64 : 10}px;z-index:1001;max-width:60%;background:rgba(255,255,255,0.95);border:1px solid #D9D7CF;border-left:4px solid #2F3B45;border-radius:4px;padding:6px 9px;font:11px 'Segoe UI',sans-serif;color:#3B3A34;line-height:1.45;`;
            pg.textContent = this.t("UI_PostalIgnored", "Postal code does not look geographic: clients that share a code are far apart. Areas were built client by client, and the area filter selects rows instead of postal codes.");
            this.mapContainer.appendChild(pg);
        }
        if (this.waitingAreas) {
            const msg = document.createElement("div");
            msg.style.cssText = "position:absolute;top:10px;right:10px;z-index:1000;max-width:260px;background:rgba(255,255,255,0.95);border:1px solid #D9D7CF;border-left:4px solid #2F3B45;border-radius:4px;padding:8px 10px;font:11px 'Segoe UI',sans-serif;color:#3B3A34;line-height:1.5;";
            msg.textContent = this.proNote
                ? this.t("UI_WaitAreasPro", "Type a number of Areas in the bar to size the sales force with automatic areas.")
                : this.t("UI_WaitAreas", "Define the areas to size the sales force: bind a field to Area (province, region…) or type a number of Areas in the bar.");
            this.mapContainer.appendChild(msg);
        }

        // Con foco, la zona pulsada lleva borde negro y algo mas de radio; las demas se atenuan
        // solo a medias, porque lo que se quiere comprobar es COMO ESTAN LAS DE AL LADO
        // (un territorio de 5 puntos solo se entiende viendo a sus vecinos).
        this.dots = []; this.lastZoomScale = 1;   // los puntos nuevos nacen a radio completo
        for (const p of points) {
            const on = this.inFocus(p);
            const outlier = p.clusterId < 0;
            const radius = on && this.focus ? r + 1.5 : r;
            const mk = L.circleMarker([p.lat, p.lon], {
                renderer, radius,
                fillColor: colorOf(p),
                color: this.hc.on ? (on && this.focus ? this.hc.sel : outlier ? this.hc.fg : this.hc.bg) : outlier ? "#8a8880" : on && this.focus ? "#222222" : "#ffffff",
                // borde proporcional al radio: con puntos pequenos, 0,8 px de borde blanco tapaban el color
                weight: outlier ? Math.min(1.2, r * 0.4) : on && this.focus ? Math.min(1.5, r * 0.5) : Math.min(0.8, r * 0.2), fillOpacity: on ? 0.95 : 0.45, opacity: on ? 1 : 0.6, interactive: false
            }).addTo(this.map);
            this.dots.push({ mk, r: radius });
        }
        // al alejar el mapa, puntos y circulos de area encogen con el (zoomend salta tambien con fitBounds)
        this.map.on("zoomend", () => this.applyZoomScale());
        this.map.on("click", () => { if (this.focus) this.toggleFocus(this.focus.kind, this.focus.id); });

        // UN tooltip para todos los puntos, construido con DOM (nada de HTML como cadena con datos
        // del usuario: es el patron del rechazo por XSS). Al mover el raton se busca el punto
        // mas cercano con una rejilla en lat/lon, en vez de 30.000 tooltips enlazados.
        const lookup = this.buildLookup(points, bounds);
        this.hoverTip = L.tooltip({ direction: "top", offset: [0, -r - 2], opacity: 0.95 });
        // TOOLTIP DE POWER BI (servicio del host): mismo aspecto que los visuales nativos,
        // valores del pozo Tooltips y paginas de tooltip del informe. Si el host no lo ofrece,
        // el tooltip propio de abajo.
        const tipSvc = this.host.tooltipService;
        const useHost = !!tipSvc && tipSvc.enabled();
        this.map.on("mousemove", (ev: L.LeafletMouseEvent) => {
            if (!this.map || !this.hoverTip) return;
            const best = lookup(ev.latlng.lat, ev.latlng.lng, this.map.getZoom());
            if (useHost) {
                if (!best) { tipSvc.hide({ immediately: true, isTouchEvent: false }); return; }
                const v = best.visits != null && best.visits > 0 ? best.visits : 1;
                const m = best.minutes != null && best.minutes > 0 ? best.minutes : best.value * 60 / v;
                const total = (best.load ?? best.value * 60) / 60, visit = v * m / 60;
                const items: powerbi.extensibility.VisualTooltipDataItem[] = [
                    { displayName: this.t("UI_PointOfSale", "Point of sale"), value: best.customerId },
                    { displayName: this.t("UI_Load", "Load (h/month)"), value: this.tf("UI_LoadDetail", "{0} ({1} visit + {2} travel)", total.toFixed(1), visit.toFixed(1), Math.max(0, total - visit).toFixed(1)) }
                ];
                if (!this.waitingAreas) {
                    if (best.clusterId >= 0) items.push({ displayName: this.t("UI_Territory", "Territory"), value: String(best.clusterId + 1), color: clusterColor(best.clusterId) });
                    else items.push({ displayName: this.t("UI_Territory", "Territory"), value: best.outlier ? this.t("UI_Outlier", "Outlier") : this.t("UI_Unassigned", "Unassigned") });
                    if (reg && best.clusterId >= 0) { const a = reg.res.areaOfTerritory[best.clusterId]; items.push({ displayName: this.t("UI_Area", "Area"), value: reg.names[a], color: clusterColor(a) }); }
                }
                if (best.postal) items.push({ displayName: this.t("Role_Postal", "Postal code"), value: best.postal });
                for (const t of best.tips ?? []) items.push({ displayName: t.name, value: t.value });
                const rect = this.container.getBoundingClientRect();
                const ids = best.rowIndex != null && this.rowSel[best.rowIndex] ? [this.rowSel[best.rowIndex]] : [];
                tipSvc.show({ coordinates: [ev.originalEvent.clientX - rect.left, ev.originalEvent.clientY - rect.top], isTouchEvent: false, dataItems: items, identities: ids });
                return;
            }
            if (!best) { if (this.map.hasLayer(this.hoverTip)) this.map.removeLayer(this.hoverTip); return; }
            const box = document.createElement("div");
            box.style.cssText = "font-family:'Segoe UI',sans-serif;font-size:12px;line-height:1.5";
            const id = document.createElement("b"); id.textContent = best.customerId;
            const l1 = document.createElement("div");
            {
                const v = best.visits != null && best.visits > 0 ? best.visits : 1;
                const m = best.minutes != null && best.minutes > 0 ? best.minutes : best.value * 60 / v;
                const total = (best.load ?? best.value * 60) / 60, visit = v * m / 60;
                l1.textContent = this.tf("UI_LoadLine", "Load: {0} h/month ({1} visit + {2} travel)", total.toFixed(1), visit.toFixed(1), Math.max(0, total - visit).toFixed(1));
            }
            const l2 = document.createElement("div");
            l2.textContent = this.waitingAreas ? "" : best.clusterId < 0 ? (best.outlier ? this.t("UI_OutlierLong", "Outlier: too far from any other client") : this.t("UI_UnassignedLong", "Unassigned: no territory with room within reach")) : this.t("UI_Territory", "Territory") + ": ";
            const z = document.createElement("b"); z.style.color = clusterColor(Math.max(0, best.clusterId)); z.textContent = best.clusterId < 0 ? "" : String(best.clusterId + 1);
            l2.appendChild(z);
            box.appendChild(id); box.appendChild(l1); box.appendChild(l2);
            if (reg && best.clusterId >= 0) {
                const a = reg.res.areaOfTerritory[best.clusterId];
                const l3 = document.createElement("div");
                l3.textContent = this.t("UI_Area", "Area") + ": ";
                const rg = document.createElement("b"); rg.style.color = clusterColor(a); rg.textContent = reg.names[a];
                l3.appendChild(rg);
                box.appendChild(l3);
            }
            this.hoverTip.setLatLng([best.lat, best.lon]).setContent(box);
            if (!this.map.hasLayer(this.hoverTip)) this.hoverTip.addTo(this.map);
        });
        // MENU CONTEXTUAL de Power BI: sobre un punto, el de ese cliente (incluir, excluir,
        // obtener detalles); fuera de los puntos, el general. Respeta allowInteractions.
        this.map.on("contextmenu", (ev: L.LeafletMouseEvent) => {
            ev.originalEvent.preventDefault();
            if (this.host.hostCapabilities?.allowInteractions === false || !this.map) return;
            const best = lookup(ev.latlng.lat, ev.latlng.lng, this.map.getZoom());
            const id = best && best.rowIndex != null ? this.rowSel[best.rowIndex] : undefined;
            this.selMgr.showContextMenu(id ?? ({} as ISelectionId), { x: ev.originalEvent.clientX, y: ev.originalEvent.clientY });
        });
        this.map.on("mouseout", () => {
            if (useHost) tipSvc.hide({ immediately: true, isTouchEvent: false });
            if (this.map && this.hoverTip && this.map.hasLayer(this.hoverTip)) this.map.removeLayer(this.hoverTip);
        });

        // CIRCULO POR AREA con los comerciales necesarios, en el centro de carga del area.
        // Configurable (panel de formato: Area badges). DOM, sin HTML en cadena.
        if (reg && this.settings.areaBadges.show) {
            const ab = this.settings.areaBadges;
            const cap = this.live ? this.live.capacityHours : 140;
            const na = reg.names.length;
            const sLat = new Float64Array(na), sLon = new Float64Array(na), sW = new Float64Array(na);
            for (const p of points) {
                if (p.clusterId < 0) continue;
                const a = reg.res.areaOfTerritory[p.clusterId]; const w = p.load ?? 1;
                sLat[a] += p.lat * w; sLon[a] += p.lon * w; sW[a] += w;
            }
            this.badges = [];
            for (let a = 0; a < na; a++) {
                if (sW[a] <= 0) continue;
                const txt = (reg.res.areaHours[a] / cap).toFixed(1);
                const el = document.createElement("div");
                el.textContent = txt;
                el.title = this.tf("UI_BadgeTitle", "{0}: {1} salespeople needed", reg.names[a], txt);
                const mk = L.marker([sLat[a] / sW[a], sLon[a] / sW[a]], { interactive: true, keyboard: false });
                mk.on("click", () => this.toggleFocus("area", a));
                this.badges.push({ mk, el, txt });
                mk.addTo(this.map);
            }
            this.rescaleBadges();
        }

        // LEYENDA DE AREAS (usuario): a la derecha del mapa, color, nombre y comerciales
        // necesarios de cada area. Construida con DOM, sin HTML en cadena.
        if (reg) {
            const lg = document.createElement("div");
            lg.style.cssText = "position:absolute;top:10px;right:10px;z-index:1000;background:rgba(255,255,255,0.94);border:1px solid #D9D7CF;border-radius:6px;padding:6px 10px;font:11px 'Segoe UI',sans-serif;color:#3B3A34;max-height:calc(100% - 20px);overflow-y:auto;box-shadow:0 1px 4px rgba(0,0,0,0.08);";
            const h = document.createElement("div"); h.style.cssText = "font-weight:700;margin-bottom:4px;"; h.textContent = this.t("UI_SalespeopleNeeded", "Salespeople needed");
            lg.appendChild(h);
            const cap = this.live ? this.live.capacityHours : 140;
            let total = 0;
            reg.names.forEach((name, a) => {
                const need = reg.res.areaHours[a] / cap; total += need;
                const row = document.createElement("div"); row.style.cssText = "display:flex;align-items:center;gap:6px;line-height:1.7;cursor:pointer;";
                const sw = document.createElement("span"); sw.style.cssText = `display:inline-block;width:10px;height:10px;border-radius:50%;background:${this.hc.on ? this.hc.fg : clusterColor(a)};flex:none;`;
                const nm = document.createElement("span"); nm.style.cssText = "flex:1;"; nm.textContent = name;
                const v = document.createElement("span"); v.style.cssText = "font-weight:700;margin-left:10px;"; v.textContent = need.toFixed(1);
                row.appendChild(sw); row.appendChild(nm); row.appendChild(v);
                row.addEventListener("click", (ev) => { ev.stopPropagation(); this.toggleFocus("area", a); });
                lg.appendChild(row);
            });
            const tt = document.createElement("div"); tt.style.cssText = "border-top:1px solid #E4E2DA;margin-top:4px;padding-top:3px;display:flex;justify-content:space-between;font-weight:700;";
            const l1 = document.createElement("span"); l1.textContent = this.t("UI_Total", "Total"); const l2 = document.createElement("span"); l2.textContent = total.toFixed(1);
            tt.appendChild(l1); tt.appendChild(l2); lg.appendChild(tt);
            L.DomEvent.disableClickPropagation(lg); L.DomEvent.disableScrollPropagation(lg);
            this.mapContainer.appendChild(lg);
        }
        if (this.hc.on) for (const ch of Array.from(this.mapContainer.children)) if (ch !== mapEl) this.hcBox(ch as HTMLElement);
        this.lastBounds = bounds;
        this.map.invalidateSize({ animate: false });
        if (view) this.map.setView(view.center, view.zoom, { animate: false });
        else this.map.fitBounds(bounds, { padding: [24, 24] });
        this.applyZoomScale();   // si la vista no cambia de zoom, no salta zoomend
    }

    /** Rejilla de busqueda del punto mas cercano al raton. Radio de captura: ~8 px al zoom actual. */
    private buildLookup(points: ClusterPoint[], b: L.LatLngBounds): (lat: number, lon: number, zoom: number) => ClusterPoint | null {
        const N = 64;
        const lat0 = b.getSouth(), lat1 = b.getNorth(), lon0 = b.getWest(), lon1 = b.getEast();
        const dLat = Math.max(1e-9, (lat1 - lat0) / N), dLon = Math.max(1e-9, (lon1 - lon0) / N);
        const cells: ClusterPoint[][] = Array.from({ length: N * N }, () => []);
        const cellOf = (lat: number, lon: number) => {
            const i = Math.min(N - 1, Math.max(0, Math.floor((lon - lon0) / dLon)));
            const j = Math.min(N - 1, Math.max(0, Math.floor((lat - lat0) / dLat)));
            return j * N + i;
        };
        for (const p of points) cells[cellOf(p.lat, p.lon)].push(p);
        const cosLat = Math.cos(((lat0 + lat1) / 2) * Math.PI / 180);
        return (lat, lon, zoom) => {
            // 8 px en grados: la escala de Leaflet es 256*2^zoom px por 360 grados
            const degPerPx = 360 / (256 * Math.pow(2, zoom));
            const rad = 8 * degPerPx;
            const c = cellOf(lat, lon), ci = c % N, cj = Math.floor(c / N);
            let best: ClusterPoint | null = null, bestD = rad * rad;
            const reach = Math.max(1, Math.ceil(rad / Math.min(dLat, dLon)));
            for (let j = cj - reach; j <= cj + reach; j++) {
                if (j < 0 || j >= N) continue;
                for (let i = ci - reach; i <= ci + reach; i++) {
                    if (i < 0 || i >= N) continue;
                    for (const p of cells[j * N + i]) {
                        const dx = (p.lon - lon) * cosLat, dy = p.lat - lat;
                        const d = dx * dx + dy * dy;
                        if (d < bestD) { bestD = d; best = p; }
                    }
                }
            }
            return best;
        };
    }

    // ── Licencia ────────────────────────────────────────────────────────────────────

    /** Caja sobre el mapa (leyenda, aviso) con los colores del tema de alto contraste. */
    private hcBox(el: HTMLElement): void {
        if (!this.hc.on) return;
        el.style.background = this.hc.bg;
        el.style.color = this.hc.fg;
        el.style.borderColor = this.hc.fg;
        el.style.boxShadow = "none";
    }

    /** Barra, botones y velo: fijos desde el constructor, se repintan al cambiar de tema. */
    private applyContrastChrome(): void {
        const on = this.hc.on, fg = this.hc.fg, bg = this.hc.bg;
        this.barContainer.style.background = on ? bg : "#FAF9F5";
        this.barContainer.style.color = on ? fg : "#535146";
        this.barContainer.style.borderBottomColor = on ? fg : "#DAD9D4";
        for (const inp of Array.from(this.barContainer.querySelectorAll("input"))) {
            inp.style.background = on ? bg : "";
            inp.style.color = on ? fg : "";
            inp.style.borderColor = on ? fg : "#C9C7BF";
        }
        Array.from(this.barContainer.querySelectorAll("button")).forEach((b, i) => {
            const principal = i === 0;
            b.style.background = on ? (principal ? fg : bg) : (principal ? "#2F3B45" : "#fff");
            b.style.color = on ? (principal ? bg : fg) : (principal ? "#fff" : "#2F3B45");
            b.style.borderColor = on ? fg : (principal ? "#2F3B45" : "#9AA5AE");
        });
        this.overlay.style.background = on ? bg : "rgba(250,249,245,0.75)";
        this.overlay.style.color = on ? fg : "#3D3929";
    }

    /** Texto localizado: clave del resjson; si falta, el ingles. */
    private t(key: string, en: string): string {
        try {
            const s = this.loc ? this.loc.getDisplayName(key) : "";
            return s && s !== key ? s : en;
        } catch (_) { return en; }
    }

    /** Igual que t(), sustituyendo {0}, {1}... */
    private tf(key: string, en: string, ...args: (string | number)[]): string {
        return this.t(key, en).replace(/\{(\d)\}/g, (_, i: string) => String(args[Number(i)] ?? ""));
    }

    private isSpanish(): boolean { return (this.host.locale || "").toLowerCase().startsWith("es"); }

    /** Vista previa Pro: Free, editando, con la licencia resuelta en un entorno que la puede leer. */
    private isPreview(): boolean {
        return !this.isPro && this.editing && this.licenseResolved && !this.licenseEnvUnsupported;
    }

    private updateWatermark(): void {
        const show = this.isPreview() && this.attemptedPro.length > 0;
        this.watermarkEl.style.display = show ? "flex" : "none";
        if (!show) return;
        const width = this.container.clientWidth || 0;
        this.watermarkEl.style.fontSize = `${Math.max(20, Math.min(72, Math.round(width * 0.09)))}px`;
    }

    /** Pide la licencia una vez, fuera del camino critico. Si no contesta en 5 s, Free. */
    private requestLicenseDeferred(): void {
        if (this.licenseRequested || this.isPro) return;
        this.licenseRequested = true;
        let done = false;
        const resolve = (pro: boolean, unsupported: boolean): void => {
            // tras el plazo de 5 s solo se acepta una respuesta tardia que SUBA a Pro
            if (done && !(pro && !this.isPro)) return;
            done = true;
            this.licenseResolved = true;
            if (unsupported) this.licenseEnvUnsupported = true;
            if (pro) this.isPro = true;
            // repintar si el resultado depende de la licencia (campos Pro en uso)
            if (this.attemptedPro.length && this.lastOptions) this.run(this.lastOptions, false);
            else { this.updateWatermark(); this.syncLicenseNotification(); }
        };
        window.setTimeout(() => resolve(false, true), 5000);
        window.setTimeout(() => {
            try {
                const lm = this.licenseManager as any;
                if (!lm) { resolve(false, true); return; }
                // getAvailableServicePlans devuelve IPromise2: se consume con then(ok, err).
                lm.getAvailableServicePlans().then(
                    (result: any) => {
                        const unsupported = result?.isLicenseUnsupportedEnv === true || result?.isLicenseInfoAvailable === false;
                        const plans: any[] = result?.plans ?? [];
                        // Warning es periodo de gracia por un problema de pago: sigue siendo usable.
                        const pro = plans.some(p => PRO_PLAN_IDS.some(id => matchesPlan(p.spIdentifier, id)) && (p.state === STATE_ACTIVE || p.state === STATE_WARNING));
                        resolve(pro, unsupported);
                    },
                    () => resolve(false, true));
            } catch (_) {
                resolve(false, true);
            }
        }, 0);
    }

    private cancelLicenseIcon(): void {
        if (this.licenseIconTimer !== null) { window.clearTimeout(this.licenseIconTimer); this.licenseIconTimer = null; }
    }

    /** Banner con la funcion concreta y, al terminar, la barra de Upgrade. La compra la pone Power BI. */
    private notifyBlocked(msg: string): void {
        const lm = this.licenseManager as any;
        if (!lm) return;
        const show = (): void => {
            try {
                lm.notifyFeatureBlocked?.(msg.slice(0, 500));
                this.cancelLicenseIcon();
                this.licenseIconTimer = window.setTimeout(() => {
                    this.licenseIconTimer = null;
                    if (this.isPro) return;
                    try { lm.notifyLicenseRequired?.(0 /* LicenseNotificationType.General */); } catch (_) { /* nunca rompe */ }
                }, 10500);
            } catch (_) { /* nunca rompe el render */ }
        };
        try {
            const cleared = lm.clearLicenseNotification?.();
            if (cleared && typeof cleared.then === "function") cleared.then(show, show); else show();
        } catch (_) { /* nunca rompe */ }
    }

    private syncLicenseNotification(): void {
        const lm = this.licenseManager as any;
        if (!lm) return;
        try {
            if (this.isPro || this.attemptedPro.length === 0) {
                this.cancelLicenseIcon();
                if (this.noticeShown) { this.noticeShown = false; this.notifiedPro = []; lm.clearLicenseNotification?.(); }
                return;
            }
            if (!this.licenseResolved || this.licenseEnvUnsupported) return;
            // solo lo recien activado merece banner; quitar una funcion no vuelve a avisar
            const added = this.attemptedPro.filter(a => this.notifiedPro.indexOf(a) === -1);
            this.notifiedPro = this.attemptedPro.slice();
            if (added.length === 0) return;
            this.noticeShown = true;
            const es = this.isSpanish();
            const items = es ? added.map(a => ES_LABELS[a] || a) : added;
            const list = items.join(es ? " y " : " and ");
            const one = added.length === 1;
            this.notifyBlocked(es
                ? `Sales Territory Balancer Pro: ${list} ${one ? "forma" : "forman"} parte del plan Pro y se ${one ? "muestra" : "muestran"} como vista previa con marca de agua mientras editas.`
                : `Sales Territory Balancer Pro: ${list} ${one ? "is" : "are"} part of the Pro plan, shown as a watermarked preview while editing.`);
        } catch (_) { /* la notificacion nunca rompe el render */ }
    }

    /** Exportar sin licencia: nota en el mapa y, si Power BI puede, su ruta de compra. */
    private blockExport(kind: "csv" | "pdf" = "csv"): void {
        const es = this.isSpanish();
        const canBuy = this.licenseResolved && !this.licenseEnvUnsupported;
        const note = document.createElement("div");
        note.style.cssText = "position:absolute;left:10px;bottom:10px;z-index:1003;max-width:60%;background:#FFF4E5;border-left:4px solid #E9A23B;border-radius:4px;padding:6px 9px;font:11px 'Segoe UI',sans-serif;color:#5C4A1E;line-height:1.45;";
        note.textContent = canBuy
            ? (kind === "pdf"
                ? (es ? "Exportar el mapa en PDF es parte del plan Pro." : "Exporting the map as PDF is part of the Pro plan.")
                : (es ? "Exportar la asignacion (cliente, area, territorio) es parte del plan Pro." : "Exporting the assignment (client, area, territory) is part of the Pro plan."))
            : (es ? "Exportar es parte del plan Pro, y Power BI no puede comprobar la licencia aqui. En Power BI Desktop, inicia sesion."
                  : "Exporting is part of the Pro plan, and Power BI cannot check the licence here. In Power BI Desktop, sign in.");
        this.hcBox(note);
        this.mapContainer.appendChild(note);
        window.setTimeout(() => note.remove(), 8000);
        if (canBuy) {
            this.notifyBlocked(es
                ? "Sales Territory Balancer Pro: exportar la asignacion de clientes a areas y territorios es parte del plan Pro."
                : "Sales Territory Balancer Pro: exporting the assignment of clients to areas and territories is part of the Pro plan.");
        }
    }

    private exportCSV(points: ClusterPoint[]): void {
        // EXPORTAR ES PRO: la asignacion es lo que el cliente se lleva. Sin vista previa.
        if (!this.isPro) { this.blockExport(); return; }
        const reg = this.lastAreas;
        const lines = [reg ? "customer_id,area,territory,load_hours_month" : "customer_id,territory,load_hours_month"];
        const q = (s: string): string => /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        for (const p of points) {
            const h = ((p.load ?? p.value * 60) / 60).toFixed(2);
            const terr = p.clusterId < 0 ? (p.outlier ? "outlier" : "unassigned") : String(p.clusterId + 1);
            const areaName = p.clusterId < 0 ? "" : reg ? reg.names[reg.res.areaOfTerritory[p.clusterId]] : "";
            lines.push(reg ? `${q(p.customerId)},${q(areaName)},${terr},${h}` : `${q(p.customerId)},${terr},${h}`);
        }
        this.download(lines.join(String.fromCharCode(10)), "territories.csv", "csv", "Territory assignment");
    }

    /**
     * Descarga por la API del host (privilegio ExportContent): un <a download> con un Blob no hace
     * nada dentro del iframe aislado de Power BI. La API respeta la politica del inquilino y abre
     * el dialogo de guardar; si el inquilino lo prohibe, se dice en el mapa en vez de fallar en
     * silencio. Tipos admitidos: txt, csv, json, tmplt, xml, pdf y xlsx (PDF y XLSX en base64). PNG no.
     */
    private download(content: string, fileName: string, fileType: string, description: string): void {
        const svc = this.host.downloadService;
        const aviso = (msg: string): void => {
            const el = document.createElement("div");
            el.style.cssText = "margin:6px 0;padding:4px 8px;background:#FFF4E5;border-left:3px solid #E9A23B;font-size:10px;color:#5C4A1E;";
            el.textContent = msg;
            el.style.cssText += "position:absolute;left:10px;bottom:10px;z-index:1001;max-width:60%;";
            this.hcBox(el);
            this.mapContainer.appendChild(el);
            setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 6000);
        };
        if (!svc || typeof svc.exportVisualsContent !== "function") { aviso(this.t("UI_ExportNA", "Export is not available in this host.")); return; }
        const razones: Record<number, string> = {
            1: this.t("UI_ExportReason1", "the visual did not declare the ExportContent privilege"),
            2: this.t("UI_ExportReason2", "this host does not support downloads from visuals"),
            3: this.t("UI_ExportReason3", "downloads from custom visuals are disabled by your Power BI administrator (tenant setting)")
        };
        // primero el estado real del privilegio, y se dice tal cual: adivinar la causa
        // ("your administrator") era falso en Desktop.
        // El interruptor de inquilino "Allow downloads from custom visuals" esta DESACTIVADO por
        // defecto (tambien manda en Desktop) y exige sesion iniciada: es la causa normal.
        const tenant = this.t("UI_ExportTenant", "Enable 'Allow downloads from custom visuals' in the Fabric admin portal (Tenant settings > Power BI visuals) and sign in to Power BI.");
        const status = typeof svc.exportStatus === "function" ? svc.exportStatus() : Promise.resolve(-1 as unknown as powerbi.PrivilegeStatus);
        Promise.resolve(status).then(st => {
            if (st !== 0 && (st as number) !== -1) { aviso(this.tf("UI_ExportNotAllowed", "Export not allowed: {0}. {1}", razones[st as number] ?? "status " + st, tenant)); return; }
            return Promise.resolve(svc.exportVisualsContent(content, fileName, fileType, description))
                .then(ok => { if (!ok) aviso(this.tf("UI_ExportNotCompleted", "Export was not completed. {0}", tenant)); });
        }).catch(e => aviso(this.tf("UI_ExportFailed", "Export failed: {0}. {1}", String(e), tenant)));
    }

    /**
     * EXPORTAR EL MAPA EN PDF (Pro, 07-10-2026). Power BI no deja descargar PNG desde un visual;
     * PDF si. Se compone una imagen a doble resolucion con lo que se ve (contornos y puntos del
     * lienzo de Leaflet, circulos de area y leyenda redibujados) y se mete en un PDF de una pagina
     * escrito a mano: JPEG con filtro DCTDecode, sin librerias y sin red.
     */
    private exportPDF(): void {
        if (!this.isPro) { this.blockExport("pdf"); return; }
        if (!this.map) return;
        const S = 2, box = this.mapContainer.getBoundingClientRect();
        const W = Math.max(1, Math.round(box.width)), H = Math.max(1, Math.round(box.height));
        const cv = document.createElement("canvas"); cv.width = W * S; cv.height = H * S;
        const ctx = cv.getContext("2d"); if (!ctx) return;
        ctx.scale(S, S);
        ctx.fillStyle = this.hc.on ? this.hc.bg : "#f4f3ef"; ctx.fillRect(0, 0, W, H);
        // lienzos de Leaflet (contornos y puntos), en su posicion en pantalla
        for (const c of Array.from(this.mapContainer.querySelectorAll("canvas"))) {
            const r = c.getBoundingClientRect();
            if (r.width && r.height) ctx.drawImage(c, r.left - box.left, r.top - box.top, r.width, r.height);
        }
        // circulos / rectangulos de area, con el estilo que tienen en pantalla
        const ab = this.settings.areaBadges;
        for (const b of this.badges) {
            const r = b.el.getBoundingClientRect(); if (!r.width) continue;
            const x = r.left - box.left, y = r.top - box.top, cs = b.el.style;
            const bw = parseFloat(cs.borderWidth) || 0;
            ctx.save();
            ctx.shadowColor = "rgba(0,0,0,0.18)"; ctx.shadowBlur = 3; ctx.shadowOffsetY = 1;
            ctx.beginPath();
            if (ab.shape === "rect") this.roundRect(ctx, x + bw / 2, y + bw / 2, r.width - bw, r.height - bw, parseFloat(cs.borderRadius) || 0);
            else ctx.arc(x + r.width / 2, y + r.height / 2, (r.width - bw) / 2, 0, Math.PI * 2);
            ctx.fillStyle = cs.backgroundColor || "#fff"; ctx.fill();
            ctx.shadowColor = "transparent";
            if (bw > 0) { ctx.lineWidth = bw; ctx.strokeStyle = cs.borderColor || "#C96442"; ctx.stroke(); }
            ctx.fillStyle = cs.color || "#3B3A34"; ctx.font = `700 ${cs.fontSize} ${ab.fontFamily}`;
            ctx.textAlign = "center"; ctx.textBaseline = "middle";
            ctx.fillText(b.txt, x + r.width / 2, y + r.height / 2 + 0.5);
            ctx.restore();
        }
        // leyenda (si hay areas), arriba a la derecha como en pantalla
        const reg = this.lastAreas;
        if (reg) {
            const cap = this.live ? this.live.capacityHours : 140;
            const filas = reg.names.map((nm, a) => ({ nm, v: reg.res.areaHours[a] / cap, c: this.hc.on ? this.hc.fg : clusterColor(a) }));
            const total = filas.reduce((s, f) => s + f.v, 0);
            const titulo = this.t("UI_SalespeopleNeeded", "Salespeople needed");
            ctx.font = "700 11px 'Segoe UI', sans-serif";
            let ancho = ctx.measureText(titulo).width + 20;
            ctx.font = "11px 'Segoe UI', sans-serif";
            for (const f of filas) ancho = Math.max(ancho, ctx.measureText(f.nm).width + 76);
            const lh = 18, alto = 24 + filas.length * lh + 22, lx = W - ancho - 10, ly = 10;
            ctx.fillStyle = this.hc.on ? this.hc.bg : "rgba(255,255,255,0.94)"; ctx.strokeStyle = this.hc.on ? this.hc.fg : "#D9D7CF"; ctx.lineWidth = 1;
            ctx.beginPath(); this.roundRect(ctx, lx, ly, ancho, alto, 6); ctx.fill(); ctx.stroke();
            const tc = this.hc.on ? this.hc.fg : "#3B3A34";
            ctx.fillStyle = tc; ctx.font = "700 11px 'Segoe UI', sans-serif"; ctx.textBaseline = "middle"; ctx.textAlign = "left";
            ctx.fillText(titulo, lx + 10, ly + 13);
            filas.forEach((f, k) => {
                const yy = ly + 24 + k * lh + lh / 2;
                ctx.fillStyle = f.c; ctx.beginPath(); ctx.arc(lx + 15, yy, 5, 0, Math.PI * 2); ctx.fill();
                ctx.fillStyle = tc; ctx.font = "11px 'Segoe UI', sans-serif"; ctx.textAlign = "left"; ctx.fillText(f.nm, lx + 26, yy);
                ctx.font = "700 11px 'Segoe UI', sans-serif"; ctx.textAlign = "right"; ctx.fillText(f.v.toFixed(1), lx + ancho - 10, yy);
            });
            const yt = ly + 24 + filas.length * lh + 11;
            ctx.strokeStyle = this.hc.on ? this.hc.fg : "#E4E2DA"; ctx.beginPath(); ctx.moveTo(lx + 8, yt - 9); ctx.lineTo(lx + ancho - 8, yt - 9); ctx.stroke();
            ctx.fillStyle = tc; ctx.textAlign = "left"; ctx.fillText(this.t("UI_Total", "Total"), lx + 10, yt);
            ctx.textAlign = "right"; ctx.fillText(total.toFixed(1), lx + ancho - 10, yt);
        }
        // JPEG -> PDF de una pagina (como mucho A4 apaisado, con la proporcion de la imagen)
        const jpg = atob(cv.toDataURL("image/jpeg", 0.92).split(",")[1]);
        const k = Math.min(842 / W, 595 / H), pw = Math.round(W * k), ph = Math.round(H * k);
        const NL = String.fromCharCode(10);
        const partes: string[] = []; const offs: number[] = []; let len = 0;
        const add = (s: string): void => { partes.push(s); len += s.length; };
        const obj = (n: number, cuerpo: string): void => { offs[n] = len; add(`${n} 0 obj${NL}${cuerpo}${NL}endobj${NL}`); };
        add("%PDF-1.4" + NL + "%" + String.fromCharCode(226, 227, 207, 211) + NL);
        obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
        obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
        obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`);
        obj(4, `<< /Type /XObject /Subtype /Image /Width ${cv.width} /Height ${cv.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>${NL}stream${NL}${jpg}${NL}endstream`);
        const contenido = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
        obj(5, `<< /Length ${contenido.length} >>${NL}stream${NL}${contenido}${NL}endstream`);
        const xref = len;
        let tabla = "xref" + NL + "0 6" + NL + "0000000000 65535 f " + NL;
        for (let n = 1; n <= 5; n++) tabla += String(offs[n]).padStart(10, "0") + " 00000 n " + NL;
        add(tabla + "trailer" + NL + "<< /Size 6 /Root 1 0 R >>" + NL + "startxref" + NL + xref + NL + "%%EOF" + NL);
        this.download(btoa(partes.join("")), "territories.pdf", "base64", "Territory map");
    }

    private roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
        const rr = Math.max(0, Math.min(r, w / 2, h / 2));
        ctx.moveTo(x + rr, y); ctx.arcTo(x + w, y, x + w, y + h, rr); ctx.arcTo(x + w, y + h, x, y + h, rr);
        ctx.arcTo(x, y + h, x, y, rr); ctx.arcTo(x, y, x + w, y, rr); ctx.closePath();
    }

    // ── Format pane ─────────────────────────────────────────────────────────────
    /** Panel de formato moderno: muestra los valores ya validados por VisualSettings.parse. */
    public getFormattingModel(): powerbi.visuals.FormattingModel {
        return this.fmtService.buildFormattingModel(buildFormattingModel(this.settings));
    }

    public destroy(): void {
        this.computeGen++;
        this.destroyMap();
        if (this.resizeObserver) this.resizeObserver.disconnect();
    }
}
