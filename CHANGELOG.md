# Changelog

All notable changes to Sales Territory Balancer are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the Power BI
four-part version scheme (`major.minor.patch.build`).

The visual was prototyped under the working name *Cluster Weighted* (the package GUID keeps that
name; it is internal and immutable). Nothing from that prototype was published.

---

## [1.0.0.0] — 2026-09-29

### Added

- **Balanced territories computed inside Power BI.** Points of sale with latitude, longitude and
  workload become compact territories of equal workload, travel time included. The number of
  territories is **derived from the hours you give one salesperson** instead of being asked for. It
  is the question a sales director actually asks: how many people do I need.
- **Areas first, salespeople inside.** An optional `Area` field (province, sales region…) or an
  `Areas` number in the bar defines commercial areas with no size constraint — compact, whole,
  geographically sensible — and territories are built inside each one and never cross it. Chosen
  over "big territories" because balancing hours across a region breaks its geography; at that
  level the hours are reported, not enforced.
- **Parameters in a bar inside the visual** — hours per salesperson, tolerance, average speed, road
  factor, areas — because the format pane only exists in edit mode and a territory plan has to be
  explorable in reading view. In edit mode the values are saved with the report; in reading view
  nothing is written back.
- **Two ways to give workload:** `Visits per month` + `Minutes per visit`, which the visual combines
  with travel time per visit, or `Hours per month` for data that already has the workload in hours.
  With nothing bound every point counts as one hour and the panel says so.
- **Travel counted as a day's route, not a trip per visit** (continuous route approximation,
  Beardwood–Halton–Hammersley 1959 and Daganzo 1984). Each visit pays the hop to the next client
  (the mean distance to its three nearest neighbours) plus its share of **one** daily trip out to the
  territory and back, shared among the visits that fit in a day. Visits per day are not a setting:
  they follow from the month (`Working days / month`, format pane, 20 by default: a day is the
  salesperson's hours divided by it), so a dense urban territory spreads the trip over eight visits
  and a rural one over three. The earlier model charged every visit the trip from the territory
  centre — ten clients along one road paid ten trips — and, on the four sample datasets, asked for
  6–15% more salespeople than this one (Spain 679 → 636, United States 637 → 555, Mexico 412 → 361,
  India 676 → 578 at 140 h, 45 km/h, road × 1.3).
- **Automatic areas respect land borders.** Each point is placed in its state or province with the
  embedded outlines, and an automatic area only joins regions that share a land border, taken from
  the unsimplified Natural Earth geometry. Straight-line grouping had put Baja California Sur in
  the same area as Sinaloa, across the Gulf of California.
- **Non-geographic postal codes are detected.** Areas are built from whole postal codes, so a
  column that is not geographic — a customer code bound to Postal code by mistake — mixed areas.
  If fewer than half of the clients have their nearest client in the same code (real codes: 0.86–0.91
  in the sample data; scattered codes: 0.00), the code is ignored, areas are built client by client,
  the area filter selects rows, and a note on the map says so.
- **Stable automatic areas.** The area grouping tries 24 starts and keeps the most compact one.
  With a single start, binding a postal code or not left only 68–73% of the workload in the same
  area for five areas, because several groupings are almost equally good; with the restarts, 100%.
- **Islands are areas of their own.** Every land group other than the main one in the data — the
  Balearic Islands, each Canary province, the Azores, Sicily, Crete, Hawaii — becomes its own named
  area, on top of the number of areas typed in the bar. Land groups come from the land-border graph
  of the embedded regions, so no list is maintained by hand.
- **Stragglers follow their nearest neighbours.** A small group (up to 30 clients) looks at the ten
  nearest clients outside it, weighted by 1/distance; if more than 60% of the weight belongs to
  another area, it moves there. Fixed clients next to Nogales, Ronda and Zamora that sat in the
  area across the boundary.
- **Postal codes wider than 25 km are split by town** (a capital's code given to a whole province is
  a common CRM error); the area filter then selects rows instead of codes.
- **Territories never cross the sea.** Inside an area, each landmass is split on its own, from the
  land-border graph of the embedded outlines; a small island gets a partial territory.
- **Towns stay whole without a postal code.** Clients within 2 km of each other (and clients at
  the same coordinates) form one unit; sprawl wider than 25 km is cut into 5 km cells.
- **Export map PDF (Pro).** A one-page PDF of the map as shown — outlines, points, area badges and
  legend — at twice the screen resolution. PDF because Power BI's download API does not accept image
  files; the PDF is written by the visual itself, with no library and no network.
- **Area badges: circle or rectangle** (`Shape` in the Area badges card), sized to the number.
- **Outliers** (`Outlier km` in the bar): a point of sale whose third-nearest client is farther
  than that distance is left out of every territory and drawn hollow — a lone client 200 km from
  anyone should not stretch a territory to reach it. 0 = never.
- **Speed per point** (`Speed (km/h)`, optional): the travel speed around each point of sale — a
  city centre at 25, its outskirts at 45, the countryside at 70 — instead of one figure for a whole
  country. Without it, the km/h in the bar applies to everyone.
- **Deterministic.** Same data and parameters, same territories, on any machine.
- **Panel** with territory count, band status, travel share and areas; one chip per area
  (salespeople needed, hours, territories outside the band) or per territory; tooltip with customer,
  workload, territory and area; **CSV export** of the assignment through Power BI's own download API
  (`ExportContent` privilege — governed by the tenant setting *Allow downloads from custom visuals*,
  off by default).

### Design decisions worth knowing

- **No background map, and no network requests of any kind.** The prototype fetched OpenStreetMap
  tiles; every tile request tells a third-party server which area you are looking at, which, in a
  visual that handles customer addresses, is exactly what should stay inside the report. Territories
  read perfectly well without a basemap. The only privilege is `ExportContent` (the CSV download
  through Power BI's dialog); the packaged bundle contains no `fetch`, `XMLHttpRequest` or tile URL
  — verified on the `.pbiviz`, not assumed.
- **Distances are straight-line × road factor.** Real routing needs an online service. A factor of
  1.3 is a common average; it is a parameter, not a constant.
- **The visual cannot write the assignment into the model.** Power BI custom visuals read; they do
  not modify the dataset. This is a design and simulation tool, and the documentation says so.

### Algorithm

Power diagram with dual ascent: each territory carries a bias, every point joins the territory that
minimises distance² + bias, and the bias rises where there is too much work and falls where there
is too little. Alternated with damped Lloyd steps. The dual ascent aims 5% below the capacity, so
the rounding of border points has room on the side where dense cores fail. A final repair pass
treats the band as a hard constraint: border moves, pair swaps (a heavy client for a light one when
both territories are at the limit), a tabu rule against ping-pong, and splitting or dissolving a
territory when nothing else works. Replaces an O(n²) prototype that spent 22 s on the neighbour
matrix alone with 30,000 points; the release version balances 40,000 points in about 15 s and a
typical few thousand in a second or two. **Towns first, whole:** a town (a continuous group of
clients) that needs several salespeople is split among them with a power diagram of its own —
compact, convex halves, never "core + ring" — and its clients are not moved afterwards. The
countryside between towns joins the nearest town territory with room, and what is left forms its
own territories with its own diagram. Any territory still above the cap is bisected. Before
this, territories were seeded from the busiest spot, the nearest clients are taken until one salesperson is full;
what is left waits for the next spot; and so on — which fixes how many territories a town gets and
where they start, before the diagram refines the borders. **Nothing is ever moved out of a
territory to make the hours fit.** The cells of the power diagram are convex, and that is what keeps every client with
its neighbours; a territory that ends above the cap is instead **split into two convex halves** (a
second centre is added and the diagram recomputed), even if a half ends short — a salesperson with
spare hours can be given more clients or more frequency later, one at 130% cannot be asked. A
short territory is dissolved into the neighbours around it whenever every one of its clients fits
under the cap. Earlier versions repaired the hours by moving border clients between territories:
it balanced the hours but left clients stranded inside a colleague's town (7-client mini
territories), which is worse than a short territory. Areas are plain workload-weighted k-means
cells (convex too). Measured, 140 h: Spain, 40,000 points, 720 territories, none above 154 h,
94% within ±10%, 0.2% of clients with no neighbour of their own territory; contiguous US, 30,000
points at per-point speeds, 756 territories, none above, 84% within band, 0.2% isolated; identical
result on every run.

### Tooling

`powerbi-visuals-tools` 7.2.1, API 5.11.1, TypeScript 5.5.4, ESLint 9 with
`eslint-plugin-powerbi-visuals` (the prototype's lint pointed at tslint and never ran).
`npm audit`: 0 vulnerabilities.
