# Changelog

All notable changes to Sales Territory Balancer are documented here.

This project follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the Power BI
four-part version scheme (`major.minor.patch.build`).

The visual was prototyped under the working name *Cluster Weighted* (the package GUID keeps that
name; it is internal and immutable). Nothing from that prototype was published.

---

## [1.0.0.0] — not yet released

First release.

### Added

- **Sales-force sizing inside Power BI.** Points of sale with coordinates and workload become the number of salespeople each commercial area needs — workload ÷ one salesperson's monthly hours, travel included — and a proposed territory for every client. The number of territories is derived, never asked for.
- **Areas first, salespeople inside.** Your own `Area` field (Pro) or a number of automatic areas, drawn with weighted k-means++ (24 restarts) from postal codes or towns. Areas follow geography and do not balance hours; territories are built inside each area and never cross it.
- **Travel as a day's route.** Continuous approximation of routing (Beardwood–Halton–Hammersley; Daganzo): each visit pays the hop to the next client and its share of one daily trip from the territory's base, shared among the visits that fit in a working day. `Working days / month` in the format pane (20).
- **Land borders, islands and the sea.** Embedded Natural Earth regions for every country. Automatic areas only join regions with a land border; islands and archipelagos become areas of their own, named after them; territories never cross from one landmass to another.
- **Whole postal codes.** With a postal code bound, territories are built from whole codes, so a code belongs to one salesperson (2.3–4.9% of codes shared on the sample data, against 45–69% client by client); a territory that would exceed the cap is divided in two instead.
- **Robust to real-world data.** Postal codes wider than 25 km are split by town, a postal column that is not geographic is detected and ignored (the map says so), clients at identical coordinates stay together, and stray clients follow their nearest neighbours.
- **Hard cap, nothing left out.** No territory exceeds one salesperson's hours; remnants that fit nowhere form a partial territory, so every client's workload counts. Optional outliers (`Outlier km`) are flagged and left for you to decide.
- **Parameters in a bar inside the visual.** Hours per salesperson, km/h, road factor and number of areas, editable in reading view; saved with the report only in edit mode.
- **Speed per point (Pro).** Travel speed around each client — city centre, outskirts, countryside — instead of one figure for a whole country.
- **Exports (Pro).** CSV of the assignment (customer, area, territory, monthly hours, postal code) and a one-page PDF of the map, through Power BI's own download dialog.
- **Reading the result.** Area badges (circle or rectangle) and a legend with salespeople needed per area and in total; tooltip with visit and travel time and the client's territory; focusing an area filters other visuals (by Area column, postal codes or rows); bookmarks; points and badges scale with zoom.
- **Built for Power BI.** No network requests and no basemap tiles; modern format pane; English and Spanish; high contrast; context menu; Power BI tooltips and report tooltip pages; all rows loaded in blocks of 30,000; deterministic results.

How every number is computed — formulas, constants, assumptions, limitations, validation and
references — is in [docs/methodology.html](docs/methodology.html).

### Tooling

`powerbi-visuals-tools` 7.2.1, API 5.11.1, TypeScript 5.5.4, ESLint 9 with
`eslint-plugin-powerbi-visuals`. `npm audit`: 0 vulnerabilities.
