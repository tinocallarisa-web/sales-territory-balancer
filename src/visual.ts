"use strict";

import powerbi from "powerbi-visuals-api";
import VisualConstructorOptions = powerbi.extensibility.visual.VisualConstructorOptions;
import VisualUpdateOptions = powerbi.extensibility.visual.VisualUpdateOptions;
import IVisual = powerbi.extensibility.visual.IVisual;
import IVisualHost = powerbi.extensibility.visual.IVisualHost;
import EnumerateVisualObjectInstancesOptions = powerbi.EnumerateVisualObjectInstancesOptions;
import VisualObjectInstanceEnumeration = powerbi.VisualObjectInstanceEnumeration;

import * as L from "leaflet";
import { VisualSettings, MIN_VARIATION_PCT } from "./settings";
import { ClusterPoint, clusterPoints, computeStats, ClusterStats } from "./clustering";

// ─── Colour palette ────────────────────────────────────────────────────────────
const CLUSTER_COLORS: string[] = [
    "#E63946", "#2A9D8F", "#E9C46A", "#F4A261", "#264653",
    "#A8DADC", "#457B9D", "#6A4C93", "#1982C4", "#8AC926",
    "#FF595E", "#FFCA3A", "#C96442", "#06D6A0", "#118AB2"
];

function clusterColor(ci: number): string {
    return CLUSTER_COLORS[ci % CLUSTER_COLORS.length];
}

// ─── Landing page HTML ─────────────────────────────────────────────────────────
const LANDING_HTML = `
<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
            height:100%;padding:24px;font-family:'Segoe UI',sans-serif;color:#535146;text-align:center;">
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" style="margin-bottom:16px">
    <circle cx="20" cy="44" r="6" fill="#E63946" opacity="0.9"/>
    <circle cx="44" cy="44" r="6" fill="#2A9D8F" opacity="0.9"/>
    <circle cx="20" cy="20" r="6" fill="#E9C46A" opacity="0.9"/>
    <circle cx="44" cy="20" r="6" fill="#F4A261" opacity="0.9"/>
    <circle cx="32" cy="32" r="6" fill="#264653" opacity="0.9"/>
    <line x1="20" y1="44" x2="32" y2="32" stroke="#E63946" stroke-width="1.5" opacity="0.4"/>
    <line x1="44" y1="44" x2="32" y2="32" stroke="#2A9D8F" stroke-width="1.5" opacity="0.4"/>
    <line x1="20" y1="20" x2="32" y2="32" stroke="#E9C46A" stroke-width="1.5" opacity="0.4"/>
    <line x1="44" y1="20" x2="32" y2="32" stroke="#F4A261" stroke-width="1.5" opacity="0.4"/>
  </svg>
  <div style="font-size:16px;font-weight:600;color:#3D3929;margin-bottom:8px">Cluster Weighted</div>
  <div style="font-size:12px;line-height:1.6;max-width:280px">
    Assign these fields to get started:<br>
    <b>Customer ID</b> · <b>Latitude</b> · <b>Longitude</b> · <b>Value (hours)</b>
  </div>
  <div style="margin-top:16px;font-size:11px;color:#83827D">
    Configure clusters in the Format Pane → Cluster Settings
  </div>
</div>`;

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
    private container: HTMLElement;
    private mapContainer: HTMLElement;
    private panelContainer: HTMLElement;
    private map: L.Map | null = null;
    private settings: VisualSettings;
    private events: powerbi.extensibility.IVisualEventService;
    private lastPoints: ClusterPoint[] = [];
    private lastBounds: L.LatLngBounds | null = null;
    private resizeObserver: ResizeObserver | null = null;

    private static readonly PANEL_H = 130; // px — fixed panel height

    constructor(options: VisualConstructorOptions) {
        this.host = options.host;
        this.events = options.host.eventService;
        this.settings = new VisualSettings();

        // Inject Leaflet CSS inline — guarantees correct tile rendering
        // regardless of whether the LESS import was bundled correctly
        Visual.ensureLeafletCSS();

        // Root container — use absolute positioning so we control every pixel
        this.container = document.createElement("div");
        this.container.className = "cw-root";
        this.container.style.cssText =
            "position:absolute;top:0;left:0;right:0;bottom:0;" +
            "overflow:hidden;font-family:'Segoe UI',sans-serif;box-sizing:border-box;";

        // Map area — explicit height set in update()
        this.mapContainer = document.createElement("div");
        this.mapContainer.className = "cw-map";
        this.mapContainer.style.cssText =
            "position:absolute;top:0;left:0;right:0;overflow:hidden;";

        // Stats + export panel — pinned to bottom
        this.panelContainer = document.createElement("div");
        this.panelContainer.className = "cw-panel";
        this.panelContainer.style.cssText =
            `position:absolute;bottom:0;left:0;right:0;height:${Visual.PANEL_H}px;` +
            "overflow-y:auto;overflow-x:hidden;" +
            "background:#FAF9F5;border-top:1px solid #DAD9D4;padding:6px 10px;box-sizing:border-box;";

        this.container.appendChild(this.mapContainer);
        this.container.appendChild(this.panelContainer);
        options.element.appendChild(this.container);

        // ResizeObserver: re-fit map whenever the container is resized by Power BI
        if (typeof ResizeObserver !== "undefined") {
            this.resizeObserver = new ResizeObserver(() => {
                if (this.map && this.lastBounds) {
                    this.map.invalidateSize();
                    this.map.fitBounds(this.lastBounds, { padding: [24, 24] });
                }
            });
            this.resizeObserver.observe(this.container);
        }
    }

    // ── Update ──────────────────────────────────────────────────────────────────
    public update(options: VisualUpdateOptions): void {
        this.events.renderingStarted(options);
        try {
            // Set explicit pixel dimensions from Power BI viewport
            const vp = options.viewport;
            const mapH = Math.max(100, (vp?.height ?? 400) - Visual.PANEL_H);
            this.mapContainer.style.height = `${mapH}px`;

            // Force synchronous reflow so Leaflet sees correct dimensions at init
            void this.mapContainer.offsetHeight;

            const dataView = options?.dataViews?.[0];

            if (!dataView?.table?.rows?.length) {
                this.showLanding();
                this.events.renderingFinished(options);
                return;
            }

            this.settings = VisualSettings.parse(dataView);
            const points = this.parseData(dataView);

            if (points.length === 0) {
                this.showLanding();
                this.events.renderingFinished(options);
                return;
            }

            // Run clustering
            clusterPoints(
                points,
                this.settings.clusterSettings.numClusters,
                this.settings.clusterSettings.targetSize,
                this.settings.clusterSettings.maxVariation,
                MIN_VARIATION_PCT
            );

            this.lastPoints = points;

            this.renderMap(points);
            this.renderPanel(points);
            this.events.renderingFinished(options);
        } catch (e) {
            this.events.renderingFailed(options, String(e));
        }
    }

    // ── Data parsing ────────────────────────────────────────────────────────────
    private parseData(dataView: powerbi.DataView): ClusterPoint[] {
        const table = dataView.table!;
        const cols = table.columns;

        const idIdx  = cols.findIndex(c => c.roles?.["customer_id"]);
        const latIdx = cols.findIndex(c => c.roles?.["latitude"]);
        const lonIdx = cols.findIndex(c => c.roles?.["longitude"]);
        const valIdx = cols.findIndex(c => c.roles?.["value"]);

        if (latIdx === -1 || lonIdx === -1) return [];

        const result: ClusterPoint[] = [];
        for (const row of table.rows) {
            const lat = Number(row[latIdx]);
            const lon = Number(row[lonIdx]);
            if (isNaN(lat) || isNaN(lon)) continue;

            result.push({
                customerId: idIdx >= 0 ? String(row[idIdx] ?? "") : "",
                lat,
                lon,
                value: valIdx >= 0 ? Math.max(0, Number(row[valIdx] ?? 0)) : 1,
                clusterId: -1
            });
        }
        return result;
    }

    // ── Landing page ────────────────────────────────────────────────────────────
    private showLanding(): void {
        this.destroyMap();
        this.mapContainer.innerHTML = LANDING_HTML;
        this.panelContainer.innerHTML = "";
    }

    // ── Map rendering ───────────────────────────────────────────────────────────
    private destroyMap(): void {
        if (this.map) {
            this.map.remove();
            this.map = null;
        }
    }

    private renderMap(points: ClusterPoint[]): void {
        // Clear map container
        this.destroyMap();
        this.mapContainer.innerHTML = "";

        const mapEl = document.createElement("div");
        mapEl.style.cssText = "width:100%;height:100%;";
        this.mapContainer.appendChild(mapEl);

        // Bounds
        const lats = points.map(p => p.lat);
        const lons = points.map(p => p.lon);
        const bounds = L.latLngBounds(
            [Math.min(...lats), Math.min(...lons)],
            [Math.max(...lats), Math.max(...lons)]
        );

        // Init map
        this.map = L.map(mapEl, {
            zoomControl: true,
            attributionControl: this.settings.mapSettings.showAttribution
        });

        L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
            maxZoom: 19,
            attribution: this.settings.mapSettings.showAttribution
                ? "© <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a>"
                : ""
        }).addTo(this.map!);

        const markerR = this.settings.mapSettings.markerSize;

        for (const p of points) {
            const color = clusterColor(p.clusterId);
            L.circleMarker([p.lat, p.lon], {
                radius: markerR,
                fillColor: color,
                color: "#ffffff",
                weight: 1.5,
                fillOpacity: 0.92,
                opacity: 1
            })
                .bindTooltip(
                    `<div style="font-family:'Segoe UI',sans-serif;font-size:12px;line-height:1.5">
                        <b>${p.customerId}</b><br>
                        Value: <b>${p.value}</b> h<br>
                        Cluster: <b style="color:${color}">${p.clusterId + 1}</b>
                    </div>`,
                    { direction: "top", offset: [0, -markerR] }
                )
                .addTo(this.map!);
        }

        // Store bounds for ResizeObserver re-fits
        this.lastBounds = bounds;

        // invalidateSize + fitBounds — container dimensions are already set via forced reflow
        this.map!.invalidateSize({ animate: false });
        this.map!.fitBounds(bounds, { padding: [24, 24] });
    }

    // ── Stats panel ─────────────────────────────────────────────────────────────
    private renderPanel(points: ClusterPoint[]): void {
        const { numClusters, targetSize, maxVariation } = this.settings.clusterSettings;
        const stats = computeStats(points, numClusters, targetSize);

        // Header row
        let html = `
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;">
            <button id="cw-export-btn" style="
                padding:3px 12px;background:#C96442;color:#fff;border:none;border-radius:4px;
                cursor:pointer;font-size:11px;font-weight:700;letter-spacing:.3px;
                font-family:'Segoe UI',sans-serif;">
                ⬇ Export CSV
            </button>
            <span style="font-size:10px;color:#83827D;">
                Target&nbsp;<b>${targetSize}h</b> &nbsp;·&nbsp;
                Min var&nbsp;<b>${MIN_VARIATION_PCT}%</b> &nbsp;·&nbsp;
                Max var&nbsp;<b>${maxVariation}%</b> &nbsp;·&nbsp;
                ${points.length}&nbsp;PdVs
            </span>
        </div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;">`;

        for (const s of stats) {
            const color = clusterColor(s.clusterId);
            const varStr = s.variationPct >= 0
                ? `+${s.variationPct.toFixed(1)}%`
                : `${s.variationPct.toFixed(1)}%`;
            const isOver = Math.abs(s.variationPct) > maxVariation;
            const varColor = isOver ? "#E63946" : "#2A9D8F";
            const warn = isOver ? " ⚠" : "";

            html += `
            <div style="background:#fff;border:2px solid ${color};border-radius:6px;
                        padding:3px 8px;font-size:10px;min-width:85px;line-height:1.5;
                        font-family:'Segoe UI',sans-serif;">
                <span style="font-weight:700;color:${color}">C${s.clusterId + 1}${warn}</span><br>
                ${s.count}&nbsp;PdVs &nbsp;·&nbsp; ${s.totalValue.toFixed(0)}h<br>
                <span style="color:${varColor};font-weight:600">${varStr} vs target</span>
            </div>`;
        }

        html += `</div>`;
        this.panelContainer.innerHTML = html;

        const btn = this.panelContainer.querySelector<HTMLButtonElement>("#cw-export-btn");
        if (btn) {
            btn.addEventListener("click", () => this.exportCSV(points));
        }
    }

    // ── CSV export ──────────────────────────────────────────────────────────────
    private exportCSV(points: ClusterPoint[]): void {
        const lines = ["customer_id,cluster_id"];
        for (const p of points) {
            lines.push(`${p.customerId},${p.clusterId + 1}`);
        }
        const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8;" });
        const url  = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = "cluster_assignment.csv";
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    // ── Format pane ─────────────────────────────────────────────────────────────
    public enumerateObjectInstances(
        options: EnumerateVisualObjectInstancesOptions
    ): VisualObjectInstanceEnumeration {
        return this.settings.enumerateObjectInstances(options.objectName);
    }
}
