---
type: "concept"
title: "Improving flood extent accuracy"
tags: ["satellite-imagery-analytics-for-insurers"]
---

# Improving flood extent accuracy

Since last week’s update, I’ve been focusing on the flood extent model, especially around urban flood zones where false positives have been a persistent issue. The new adjustments we rolled out in version 4.3.2 seem promising but also raise a few questions.

**Observations:**

- False positive detections in dense urban areas dropped by roughly 28% compared to v4.3.1 when we applied the new urban land masking combined with adjusted NDWI thresholds.
- The adjusted threshold for the Normalized Difference Water Index (NDWI) was lowered from 0.35 to 0.28 in these zones, which aligns better with the observed spectral signatures during minor floods.
- However, in some mixed residential-commercial zones, we noticed occasional underestimation of flood extent, particularly in areas with reflective rooftop materials that confuse the model.
- Visual comparison against ground truth data from the March 2024 Pinecrest flood event shows improved precision but a slight dip in recall (approximately 5%).

**Measurements:**

- Current precision in urban flood zones: 82.3% (up from 64.5%)
- Recall in same zones: 75.1% (down from 79.6%)
- Overall F1 score for urban zones: 78.5% (previously 71.2%)

**Open Questions:**

(Condensed copy of the original page.)
