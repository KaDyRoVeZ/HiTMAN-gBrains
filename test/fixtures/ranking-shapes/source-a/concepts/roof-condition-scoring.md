---
type: "concept"
title: "Roof Condition Scoring"
tags: ["satellite-imagery-analytics-for-insurers"]
---

# Roof Condition Scoring

Roof Condition Scoring refers to an analytical process where satellite imagery is used to quantitatively assess the severity of damage to building roofs, primarily for property insurers. This technique supports underwriting, claims triage, and catastrophe response by providing rapid, large-scale damage estimates without needing ground visits.

### How it Works

1. **Image Acquisition**: High-resolution satellite images (typically 30cm per pixel) are acquired, ideally within 48 hours of a damaging event.
2. **Preprocessing**: Images are orthorectified and cloud-obscured areas masked out.
3. **Feature Extraction**: Algorithms detect roof structures and identify damage indicators such as missing shingles, discoloration, and water pooling.
4. **Scoring Model**: A machine learning model assigns a damage score from 0 (no damage) to 10 (total loss), based on extracted features.
5. **Aggregation**: Scores are aggregated by property clusters or postal codes for portfolio-level insights.

### Tradeoffs

- **Resolution vs. Coverage**: Higher resolution images provide more detail but cost more and cover smaller areas.
- **Timeliness vs. Accuracy**: Rapid image capture may reduce cloud interference but limits the number of usable images.
- **Model Complexity vs. Interpretability**: Complex models improve accuracy but reduce explainability for adjusters.

### Worked Example

For a hurricane-impacted area of 1,000 properties, satellite imagery reveals:

- 600 roofs scored between 0-2 (minor/no damage)
- 300 roofs scored between 3-6 (moderate damage)
- 100 roofs scored above 7 (severe damage)

If each severe damage roof has an average claim of $15,000, moderate damage averages $5,000, and minor damage $500, the estimated total claim exposure is:

(100 × $15,000) + (300 × $5,000) + (600 × $500) = $1.5M + $1.5M + $0.3M = $3.3M

### Common Failure Modes

- Cloud cover obscuring roofs leads to missed damage.
- Shadows causing false damage detection.
- Older roofs with wear patterns misclassified as storm damage.
- Rapid vegetation growth hiding roof defects post-event.

Understanding these factors is critical for calibrating models and setting appropriate confidence thresholds.
