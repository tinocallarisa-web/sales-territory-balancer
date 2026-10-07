# Sales Territory Balancer

A Power BI custom visual by [TCViz](https://tcviz.com) that sizes the sales force and designs sales
territories inside Power BI: points of sale with coordinates and workload become the number of
salespeople each commercial area needs and a proposed territory for every client — with no network
requests.

- **User guide:** https://tinocallarisa-web.github.io/sales-territory-balancer/support.html
- **Methodology** (algorithms, formulas, assumptions, validation, references):
  https://tinocallarisa-web.github.io/sales-territory-balancer/methodology.html
- **Privacy / Terms:** [privacy](https://tinocallarisa-web.github.io/sales-territory-balancer/privacy.html) ·
  [terms](https://tinocallarisa-web.github.io/sales-territory-balancer/terms.html)
- **Video:** https://www.youtube.com/watch?v=BOZbV4abueg
- **Changelog:** [CHANGELOG.md](CHANGELOG.md)

The package GUID (`clusterWeighted7852F42A6D8A494CB286C44ACCF04FBB`) keeps the prototype's working
name; it is immutable.

## Source layout

| File | What it does |
|---|---|
| `src/visual.ts` | Power BI integration: data parsing, control bar, map (Leaflet, canvas), licensing, filters, bookmarks, exports |
| `src/clustering.ts` | Workload and travel model; territories; outliers |
| `src/areas.ts` | Commercial areas |
| `src/regions.ts` | Region and landmass of each point from the embedded outlines; land groups; land-border test |
| `src/outlines.ts` | Embedded Natural Earth outlines, region names, land-border adjacency, landmasses (generated) |
| `src/settings.ts`, `src/formatting.ts` | Settings parsing and the modern format pane |
| `src/basicareas.ts`, `src/contiguity.ts`, `src/pmedian.ts` | Experiments kept for reference; not imported by the visual |
| `stringResources/` | English and Spanish strings |
| `docs/` | Pages published with GitHub Pages, and the certification notes |
| `notes/` | Verified references |

## Build

```bash
npm install
node build-test.js          # test build, Pro forced on:  dist/<guid>_test.<version>.pbiviz
node build-test.js --free   # test build, real licence:   dist/<guid>_testfree.<version>.pbiviz
npx tsc --noEmit            # type check
npm run eslint              # lint (eslint-plugin-powerbi-visuals)
```

Test builds patch the source, package and restore it; they add `_test` / `_testfree` to the GUID and a
build stamp in the corner of the map. The source tree always stays in production state. The production
package (`npx pbiviz package`) is built only for a submission to AppSource.

## Data credits

Boundaries: [Natural Earth](https://www.naturalearthdata.com) (public domain). Map rendering:
Leaflet (BSD-2-Clause). Triangulation: Delaunator (ISC).
