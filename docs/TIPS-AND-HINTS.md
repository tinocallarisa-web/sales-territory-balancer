# Tips &amp; Hints — Sales Territory Balancer

**Version 1.0.0.0 · TCViz**
Video walkthrough: https://www.youtube.com/watch?v=BOZbV4abueg

> Content for the *Tips &amp; Hints* page of the sample `.pbix`.
> Power BI text boxes do not render markdown tables — use `TIPS-AND-HINTS-PLAIN.txt` when pasting
> into the report.

---

## What it is — and what it is not

A **territory design and sales force sizing** tool. It tells you how many salespeople each area needs
and proposes one territory per salesperson. It does **not** plan routes, sequence visits or read a road
network: distances are straight lines times a road factor you set, and travel time is a planning
estimate.

## Getting started

1. Drop the visual on the canvas.
2. Drag your point-of-sale identifier into **Customer ID**, and its coordinates into **Latitude** and
   **Longitude**. One row per point of sale.
3. Give each point a workload: **Visits per month** and **Minutes per visit**.
4. Define the areas: type a number in **Areas** in the bar, or (Pro) drag your own field into **Area**.
5. Set **Hours / salesperson / month** in the bar. Each area's badge shows the salespeople it needs.

## Field wells

| Well | Accepts | Purpose |
|---|---|---|
| Customer ID | Any identifier | One row per point of sale; without it, Power BI aggregates every coordinate into one point |
| Latitude, Longitude | Decimal degrees | Required; out-of-range rows are ignored |
| Visits per month | Numeric | 0.5 means every two months |
| Minutes per visit | Numeric | Time on site per visit |
| Postal code | Text or number | Optional; territories are then made of whole postal codes |
| Speed (km/h) *(Pro)* | Numeric | Travel speed around this point; overrides the bar |
| Area *(Pro)* | Any text | Your commercial areas; each client stays in its own |
| Tooltips | Measures | Extra values on hover; report tooltip pages supported |

## The control bar

Inside the visual, above the map. It works in reading view: readers can try values and nothing is
written back. In edit mode the values are saved with the report.

| Control | Default | What it does |
|---|---|---|
| Hours / salesperson / month | 140 | Size of a territory — a hard cap |
| km/h | 45 | Average travel speed for points without their own |
| Road × | 1.3 | Road distance over straight-line distance |
| Areas | 0 | Areas drawn automatically when no Area field is bound; 0 = nothing computed |
| Export CSV *(Pro)* | — | customer_id, area, territory, load_hours_month (+ postal_code) |
| Export map PDF *(Pro)* | — | The map as you see it, on one page |

## Format pane

| Card | Setting | What it does |
|---|---|---|
| Territories | Working days / month (20) | Hours per salesperson ÷ this = one working day |
| Territories | Outlier distance (km) (0 = off) | Far-off clients drawn hollow and left out, for you to decide |
| Area badges | Show, Shape | Circle or rectangle |
| Area badges | Font, size, colours, border | Badge styling |
| Map Settings | Marker size | Size of the points |

## Free vs Pro

| Capability | Free | Pro |
|---|---|---|
| Salespeople needed per area, travel included | ✓ | ✓ |
| Automatic areas along land borders, islands apart | ✓ | ✓ |
| One territory per salesperson, hard cap on hours | ✓ | ✓ |
| Whole postal codes | ✓ | ✓ |
| Territories with their hours when you focus an area | ✓ | ✓ |
| Filters, bookmarks, tooltips, high contrast | ✓ | ✓ |
| Your own Area field | — | ✓ |
| Speed per point | — | ✓ |
| Export CSV | — | ✓ |
| Export map PDF | — | ✓ |

While you edit without a licence, Area and Speed work under a *Pro preview* watermark so you can see
what they add.

## Tips and best practices

**Set the road factor for your country.** Published averages are about 1.2 for the United States,
1.3 for India, 1.5 for Mexico and 1.6 for Spain. Higher means more travel and more salespeople.

**Check the units first.** Minutes per visit in minutes, hours per salesperson in monthly hours. Most
"the number looks wrong" cases are a unit.

**Read the decimal.** 6.4 salespeople is the answer, not a rounding error: whether that is 6 or 7 is
your decision. A small island can show 0.3 — someone covers it part-time.

**Areas follow geography, not hours.** An area that needs 12 salespeople next to one that needs 2 is a
correct answer. The hours are balanced between the salespeople inside each area.

**Assign by postal code? Bind Postal code.** Each code then goes to one salesperson; only codes with
more work than one salesperson are shared.

**Click an area to see its territories.** Each territory gets its outline and its hours, and the other
visuals on the page are filtered to that area. Zoom in to see the labels that do not fit.

**Try "what if" in reading view.** Change the hours to 120 and press Enter. The same data and
parameters always give the same result.

## Troubleshooting

**Nothing happens when I add coordinates.** Territories are built inside areas: type a number in
**Areas** or bind an Area field.

**Everything collapsed into one point.** Customer ID is not bound. Bind an identifier with one row per
point of sale.

**A client is in the "wrong" area with my Area field.** The visual never overrides your data. Check
that client's Area value.

**The map says the postal code is ignored.** The column is not geographic (codes do not group nearby
clients), so the visual uses location instead.

**"Loading points… 30,000 so far".** Power BI hands rows over in blocks of 30,000; the visual waits
for all of them before computing.

**Export not allowed.** Ask your administrator to enable *Allow downloads from custom visuals* (Fabric
admin portal → Tenant settings → Power BI visuals).

**It computes again when I come back to the page.** The last result is kept in your browser through
Power BI's local storage. It computes again if something changed, if the result is older than 29 days,
if you are not signed in, or if local storage is switched off by your administrator.

---

Documentation: https://tinocallarisa-web.github.io/sales-territory-balancer/support.html
Methodology: https://tinocallarisa-web.github.io/sales-territory-balancer/methodology.html
Support: support@tcviz.com
