# AppSource Listing — Sales Territory Balancer

Copy ready to paste into Partner Center, English only. **The marketplace description is the
documentation most people read** — update it on every release.

Limits measured in Partner Center: *Search results summary* 100 characters, *Description* 5,000
characters (truncated silently, and the "What's new" block goes inside it), *Certification notes*
2,500 counting CRLF (the field empties on every resubmission — paste
`docs/CERTIFICATION-NOTES-SHORT.txt` again each time).

**Editing this file does not change the offer.** The fields Microsoft reviews live only in Partner
Center: paste them by hand.

---

## Offer name

```
Sales Territory Balancer
```

---

## Search results summary

```
How many salespeople do you need? Balanced sales territories from your points of sale, in Power BI.
```

---

## Description

```
One salesperson has 140 hours of work a month and another has 60. Nobody is sure how many people the team really needs, and redrawing the territories means a spreadsheet, a consultant, or a separate mapping tool where you upload your customer list.

Sales Territory Balancer does it inside your Power BI report. Give it your points of sale — where they are and how much work each one takes — and it tells you how many salespeople each area needs and proposes one territory per salesperson, travel time included. Your customers' locations never leave the report.

SIZING AND TERRITORIES

• Salespeople needed per area: workload divided by one salesperson's monthly hours, travel included — shown as 6.4, not "6 or 7", because rounding is your decision
• Commercial areas drawn automatically along land borders: never across a gulf or the sea
• Islands and archipelagos get areas of their own
• One compact territory per salesperson, never above the hours you set
• Territories made of whole postal codes when you bind a postal code: one code, one salesperson
• Click an area to see its territories, each with its outline and its hours, and to filter the rest of the page
• The same data and parameters always give the same result

WHAT-IF, IN READING VIEW

The parameters live in a bar inside the visual: hours per salesperson, speed, road factor and number of areas. Readers can try "what if a salesperson had 120 hours" without edit rights, and nothing is written back to the report.

WHAT IT IS NOT

A territory design and sizing tool, not a routing tool. It does not plan routes or schedule visits, and it does not read a road network: distances are straight lines times a road factor you set for your country, and travel time is a planning estimate. The methodology, its assumptions and its references are published.

PRO

• Your own Area field — province, region, sales zone — with every client kept in its own area
• Speed per point of sale: slower in a city centre, faster in the countryside
• Export the assignment to CSV: customer, area, territory, monthly hours and postal code
• Export the map to a one-page PDF, as you see it

FREE AND PRO

The free tier gives a complete, correct result: sizing, automatic areas, territories, whole postal codes, filters, bookmarks, tooltips and high contrast. What Pro adds is working with your own areas and taking the result out of Power BI. While you edit a report without a licence, Area and Speed work under a "Pro preview" watermark, so you see your own data with them before buying. Reading view shows the free result.

PRIVACY

The visual makes no network requests of any kind. There is no street map behind the points because map tiles would tell a third-party server where you are looking: the country and region outlines (Natural Earth) travel inside the visual instead. To avoid computing again when you return to a page, it keeps its last result — each client's territory number, nothing else from your data — in your browser through Power BI's own local storage. Licences are checked through Microsoft's licensing API.

GETTING STARTED

1. Bind Customer ID, Latitude and Longitude — one row per point of sale.
2. Bind Visits per month and Minutes per visit.
3. Type a number in Areas in the bar, or (Pro) bind your Area field.
4. Set Hours / salesperson / month and the road factor for your country.

Documentation, methodology and video: https://tinocallarisa-web.github.io/sales-territory-balancer/support.html
Support: support@tcviz.com

WHAT'S NEW IN 1.0.0.0

First release.
```

---

## URLs to keep in sync

| Field | URL |
|---|---|
| Support / documentation | https://tinocallarisa-web.github.io/sales-territory-balancer/support.html |
| Privacy policy | https://tinocallarisa-web.github.io/sales-territory-balancer/privacy.html |
| Terms / licence | https://tinocallarisa-web.github.io/sales-territory-balancer/terms.html |
| Video | https://www.youtube.com/watch?v=BOZbV4abueg |

Canonical YouTube URL only (policy 100.3.3.3). Shortened links, `/shorts/` and `/embed/` are
rejected.

## Images

| Asset | File | Notes |
|---|---|---|
| Offer screenshot | `docs/infographic.html` -> `sales-territory-balancer-infographic.png` | **1366x768 is mandatory.** Open the page and press *Download PNG*. The page title reads FIT or OVERFLOW before you export. A copy is in `assets/infographic.png`. |
| More screenshots | `assets/Screenshot_1.png` … `Screenshot_4.png` | 1366x768, checked 2026-10-07. |
| Offer icon | `assets/icon-300x300.png` (= `territory-300x300.png` from `test_visuales/iconos/salida/`, Nord system) | Uploaded by hand: it does not travel inside the package. |
| Package icon | `assets/icon.png` | Embedded in the `.pbiviz`. |
| Sample report | `Cluster weighted.pbix` (repo root) | Synthetic data. Add the *Tips & Hints* page from `docs/TIPS-AND-HINTS-PLAIN.txt`. |

## Categories and keywords

- Categories (max 2): pick from the Partner Center dropdown — **Maps** first (it is a map of
  territories); second, the closest to *analytics / planning* that the dropdown offers.
  Not verified against the current dropdown: check it when filling the form.
- Industries (max 2): the closest to **Retail / consumer goods** and **Distribution** in the dropdown.
- EULA: our own `terms.html`, which describes the Free/Pro split.
- Search keywords (max 3), and why:
  1. `sales territory` — the problem in the buyer's words; what a sales manager types.
  2. `territory planning` — the task, the way sales operations names it.
  3. `sales force sizing` — the other half of the product, and almost no competition in Power BI.
  Left out: `map` (competes with the native map and half the marketplace), `routing` (it is not
  one, and would bring people the visual cannot help).

## Plans

The code accepts either Plan ID (`PRO_PLAN_IDS` in `src/visual.ts`, matched with `matchesPlan()`
against the end of the Service ID). **Type them exactly.**

| Plan ID | Visibility | Price | Purpose |
|---|---|---|---|
| `sales-territory-balancer-pro` | Public | 14.99 USD per user per month · 149 USD per user per year · 1-month free trial (chosen 2026-10-07; plan prices cannot be changed later) | Sales Territory Balancer Pro |
| `partner` | Private | 0 | Partners (NextSteps): see `C:\tcviz\marketing\NextSteps\` |

Plan description (public; the field takes up to 3,000 characters, per Partner Center):

```
Sales Territory Balancer Pro adds what you need to work with your own sales organisation and to take the result out of Power BI:

• Your own Area field — province, region, sales zone or delegation. Every client stays in its own area, and territories are built inside each one.
• Speed per point of sale — slower in a city centre, faster in the countryside — for a more realistic travel time.
• Export the assignment to CSV: customer, area, territory, monthly hours and postal code, ready for your CRM.
• Export the map to a one-page PDF, as you see it, for the meeting.

The free version already gives the complete result with automatic areas: salespeople needed, balanced territories, whole postal codes, filters and tooltips. Licence per user, managed by Microsoft. No network requests: your data never leaves the report.
```

## What to paste by hand in Partner Center

1. Offer listing → Name, Search results summary, Description, Keywords (this file).
2. Offer listing → Videos: `https://www.youtube.com/watch?v=BOZbV4abueg`.
3. Offer listing → Screenshots (1366x768) and the 300x300 logo.
4. Properties → Support, Privacy and Terms URLs (table above).
5. Plans → the two Plan IDs above, exactly as written.
6. Review and publish → Notes for certification: `docs/CERTIFICATION-NOTES-SHORT.txt`.
7. Packages → `_releases/clusterWeighted7852F42A6D8A494CB286C44ACCF04FBB.1.0.0.0.pbiviz`.
