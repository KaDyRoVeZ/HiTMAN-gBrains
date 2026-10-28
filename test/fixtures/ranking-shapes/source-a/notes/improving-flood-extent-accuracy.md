---
type: "note"
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

- Could incorporating additional spectral bands (e.g., short-wave infrared) help differentiate reflective surfaces from open water more reliably?
- Are there specific urban materials or roofing types that disproportionately cause false negatives?
- Should we explore dynamic thresholding based on land use classification instead of static NDWI thresholds?

**Next Steps:**

- Set up a focused experiment adding SWIR bands to the input features for a subset of urban flood scenes.
- Pull building and roofing material metadata from our partner insurers to analyze correlation with misclassification.
- Consider collaborating with the geospatial feature team to prototype a land use-aware thresholding method by next sprint.

Will circle back with preliminary results by end of next week. Overall, the adjustments are moving the needle in the right direction but fine-tuning remains critical.
