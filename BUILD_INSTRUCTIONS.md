# Cómo compilar Cluster Weighted

## Primera vez (instalar dependencias)

Abre una terminal en esta carpeta y ejecuta:

```bash
npm install
```

Esto instala ~200 MB de dependencias (pbiviz tools, Leaflet, TypeScript). Solo necesitas hacerlo una vez.

## Build de TEST (para probar en Power BI Desktop)

```bash
node build-test.js
```

Genera `dist/clusterWeighted7852F42A6D8A494CB286C44ACCF04FBB_DEBUG.*.pbiviz`  
→ Importa ese archivo en Power BI Desktop para probar.

## Build de PRODUCCIÓN (para publicar en AppSource)

```bash
npm run build
```

o directamente:

```bash
npx pbiviz package
```

Genera `dist/clusterWeighted7852F42A6D8A494CB286C44ACCF04FBB.1.0.0.0.pbiviz`

## Verificar TypeScript sin compilar

```bash
npx tsc --noEmit
```

---

## Campos del visual en Power BI

| Campo | Tipo | Descripción |
|---|---|---|
| Customer ID | Texto | ID único del punto de venta |
| Latitude | Número | Latitud geográfica |
| Longitude | Número | Longitud geográfica |
| Value (hours) | Número | Horas de visita del PdV |

## Parámetros (Format Pane → Cluster Settings)

| Parámetro | Default | Descripción |
|---|---|---|
| Number of Clusters | 5 | Número de territorios (vendedores) |
| Target Size (hours) | 40 | Horas objetivo por cluster |
| Max Variation % | 20 | Desviación máxima permitida (mínimo 10% hardcodeado) |

## Export CSV

Pulsa **⬇ Export CSV** en el panel inferior del visual.  
Descarga `cluster_assignment.csv` con columnas: `customer_id, cluster_id`
