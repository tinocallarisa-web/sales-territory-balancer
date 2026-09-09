# Changelog

All notable changes to Cluster Weighted are documented here.

## [1.0.0.0] — 2026-08-05

### Added
- Initial release
- Geographic weighted clustering using region-growing algorithm with farthest-first seeding
- Configurable parameters: number of clusters, target size (hours), max variation %
- Minimum variation hardcoded at 10% (floor)
- Leaflet map with color-coded cluster points and tooltips
- Stats panel showing per-cluster PdV count, total hours, and % deviation vs target
- ⚠ warning indicator on clusters exceeding max variation %
- Export CSV button: downloads `customer_id, cluster_id` assignment file
- Landing page shown when no data is mapped
- Format pane: Cluster Settings (numClusters, targetSize, maxVariation) and Map Settings (markerSize, showAttribution)
