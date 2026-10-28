---
type: "concept"
title: "Flood Extent Mapping"
tags: ["satellite-imagery-analytics-for-insurers"]
---

# Flood Extent Mapping

Flood extent mapping refers to the process of identifying and outlining areas submerged by floodwaters using multispectral satellite imagery. This technique leverages the distinct spectral signatures of water compared to land surfaces to delineate inundated zones, crucial for insurers assessing flood damage and catastrophe response.

How it works: Satellites capture images across various spectral bands including visible and near-infrared (NIR). Water absorbs NIR light strongly, appearing dark in that band, while vegetation and dry land reflect NIR strongly. Algorithms combine bands to generate indices such as the Normalized Difference Water Index (NDWI), highlighting water bodies. By applying threshold values to NDWI maps taken before and after a flood, the change in water coverage is extracted, producing a flood extent map.

Tradeoffs include spatial resolution and revisit frequency. Higher resolution (e.g., 3m pixels) improves boundary accuracy but often reduces coverage area and increases cloud sensitivity. Lower resolution (e.g., 30m pixels) covers larger areas but may miss small inundations.

Example: A 50 km² urban area was analyzed using 10m Sentinel-X data. Pre-flood NDWI averages were 0.1; post-flood NDWI rose to 0.5 in waterlogged zones. Applying a threshold of 0.3 identified 12 km² flooded, matching ground truth within 8% error.

Common failure modes involve cloud cover obscuring imagery, spectral confusion in turbid or shadowed waters, and misclassification of wet soil as water. Validation with ground or UAV data is recommended to ensure accuracy.
