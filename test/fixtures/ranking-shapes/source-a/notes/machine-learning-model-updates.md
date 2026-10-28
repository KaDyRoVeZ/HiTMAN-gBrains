---
type: "note"
title: "Machine Learning Model Updates"
tags: ["vertical-farming-and-indoor-agriculture"]
---

# Machine Learning Model Updates

Since last sprint, the updated yield forecasting models have shown promising gains in accuracy, particularly with the integration of new nutrient dosing data streams from Tower 3 and 5. Preliminary results from the April batch show RMSE dropping from 12.4% to 8.7%, which is a noticeable improvement though still shy of our 6% target.

Key observations:
- Incorporating real-time EC (electrical conductivity) fluctuations helped reduce noise in the input features.
- The newer LSTM variant captures complex temporal patterns better than the previous GRU-based models.
- However, there are still sporadic outliers when unexpected lighting adjustments occur, especially during maintenance windows.

Measurements:
- Model A (baseline GRU): 12.4% RMSE on validation set.
- Model B (new LSTM + EC data): 8.7% RMSE.
- Yield variance explained improved from 72% to 85%.

Open questions:
- How do we best handle rare events like manual light overrides? Should these be excluded or modeled explicitly?
- Is there enough historical data from Tower 5 to justify a dedicated model or fine-tuning?
- How stable is performance when scaling from one crop cycle to another?

Next steps:
- Explore anomaly detection to flag maintenance-induced lighting changes.
- Test transfer learning approaches for Tower 5 using limited data.
- Set up weekly retraining pipeline to keep models current with evolving nutrient profiles.
