"use strict";

/**
 * PANEL DE FORMATO MODERNO (getFormattingModel). Sustituye a enumerateObjectInstances, que
 * pbiviz marca como "required soon".
 *
 * Los VALORES se siguen leyendo y validando en VisualSettings.parse (settings.ts): este modelo
 * solo los muestra. Asi hay una sola fuente de verdad para limites y valores por defecto, y el
 * panel ensena exactamente lo que el visual esta usando.
 *
 * Lo que NO sale aqui, a proposito: horas por comercial, km/h, factor de carretera y numero de
 * areas. Viven en la barra del visual (funciona en lectura) y se guardan con el informe por
 * persistProperties; siguen declarados en capabilities.json para poder guardarse.
 */

import powerbi from "powerbi-visuals-api";
import { formattingSettings } from "powerbi-visuals-utils-formattingmodel";
import { VisualSettings } from "./settings";

const { ToggleSwitch, NumUpDown, ColorPicker, FontPicker, ItemDropdown } = formattingSettings;

const min = (value: number): powerbi.visuals.MinValidator<number> => ({ type: powerbi.visuals.ValidatorType.Min, value });
const max = (value: number): powerbi.visuals.MaxValidator<number> => ({ type: powerbi.visuals.ValidatorType.Max, value });

class TerritoriesCard extends formattingSettings.SimpleCard {
    name = "clusterSettings";
    displayName = "Territories";
    displayNameKey = "Obj_Territories";

    workDays = new NumUpDown({
        name: "workDays",
        displayName: "Working days / month",
        displayNameKey: "Prop_WorkDays",
        description: "Working days a month. A working day is the salesperson's monthly hours divided by this; the visits that fit in a day share the daily trip out to the territory and back.",
        descriptionKey: "Prop_WorkDays_Desc",
        value: 20,
        options: { minValue: min(1), maxValue: max(31) }
    });

    outlierKm = new NumUpDown({
        name: "outlierKm",
        displayName: "Outlier distance (km)",
        displayNameKey: "Prop_OutlierKm",
        description: "A point of sale whose third-nearest neighbour is farther than this is left out of the territories and flagged as an outlier. 0 = never.",
        descriptionKey: "Prop_OutlierKm_Desc",
        value: 0,
        options: { minValue: min(0), maxValue: max(5000) }
    });

    slices: formattingSettings.Slice[] = [this.workDays, this.outlierKm];
}

class AreaBadgesCard extends formattingSettings.SimpleCard {
    name = "areaBadges";
    displayName = "Area badges";
    displayNameKey = "Obj_AreaBadges";
    description = "A circle or a rectangle on each area with the number of salespeople it needs.";
    descriptionKey = "Obj_AreaBadges_Desc";

    show = new ToggleSwitch({ name: "show", displayName: "Show", displayNameKey: "Prop_Show", value: true });
    topLevelSlice = this.show;

    private static readonly SHAPES = [
        { value: "circle", displayName: "Circle", displayNameKey: "Enum_Circle" },
        { value: "rect", displayName: "Rectangle", displayNameKey: "Enum_Rectangle" }
    ];
    shape = new ItemDropdown({ name: "shape", displayName: "Shape", displayNameKey: "Prop_BadgeShape", items: AreaBadgesCard.SHAPES, value: AreaBadgesCard.SHAPES[0] });
    fontFamily = new FontPicker({ name: "fontFamily", displayName: "Font family", displayNameKey: "Prop_FontFamily", value: "" });
    fontSize = new NumUpDown({
        name: "fontSize", displayName: "Font size", displayNameKey: "Prop_FontSize", value: 14,
        options: { minValue: min(8), maxValue: max(40) }
    });
    textColor = new ColorPicker({ name: "textColor", displayName: "Text color", displayNameKey: "Prop_TextColor", value: { value: "" } });
    fillColor = new ColorPicker({ name: "fillColor", displayName: "Background color", displayNameKey: "Prop_FillColor", value: { value: "" } });
    borderColor = new ColorPicker({ name: "borderColor", displayName: "Border color", displayNameKey: "Prop_BorderColor", value: { value: "" } });
    borderWidth = new NumUpDown({
        name: "borderWidth", displayName: "Border width", displayNameKey: "Prop_BorderWidth", value: 2,
        options: { minValue: min(0), maxValue: max(10) }
    });

    slices: formattingSettings.Slice[] = [this.shape, this.fontFamily, this.fontSize, this.textColor, this.fillColor, this.borderColor, this.borderWidth];
}

class MapCard extends formattingSettings.SimpleCard {
    name = "mapSettings";
    displayName = "Map Settings";
    displayNameKey = "Obj_Map";

    markerSize = new NumUpDown({
        name: "markerSize", displayName: "Marker Size", displayNameKey: "Prop_MarkerSize", value: 4,
        options: { minValue: min(0.5), maxValue: max(20) }
    });

    slices: formattingSettings.Slice[] = [this.markerSize];
}

export class FormattingModel extends formattingSettings.Model {
    territories = new TerritoriesCard();
    areaBadges = new AreaBadgesCard();
    map = new MapCard();
    cards = [this.territories, this.areaBadges, this.map];
}

/** El panel muestra los valores ya validados que usa el visual. */
export function buildFormattingModel(s: VisualSettings): FormattingModel {
    const m = new FormattingModel();
    m.territories.workDays.value = s.clusterSettings.workDays;
    m.territories.outlierKm.value = s.clusterSettings.outlierKm;
    const ab = s.areaBadges;
    m.areaBadges.show.value = ab.show;
    m.areaBadges.shape.value = m.areaBadges.shape.items.find(i => i.value === ab.shape) ?? m.areaBadges.shape.items[0];
    m.areaBadges.fontFamily.value = ab.fontFamily;
    m.areaBadges.fontSize.value = ab.fontSize;
    m.areaBadges.textColor.value = { value: ab.textColor };
    m.areaBadges.fillColor.value = { value: ab.fillColor };
    m.areaBadges.borderColor.value = { value: ab.borderColor };
    m.areaBadges.borderWidth.value = ab.borderWidth;
    m.map.markerSize.value = s.mapSettings.markerSize;
    return m;
}
