---
type: "media"
title: "Camera Network Sensitivity Calibration: lessons from the field"
source_kind: "transcript"
---

# Camera Network Sensitivity Calibration: lessons from the field

Moderator: Welcome everyone to today’s session. We’re pleased to have Isolde Brindale with us to discuss “Camera Network Sensitivity Calibration: Lessons from the Field.” Isolde is a lead engineer on our wildfire detection camera network project. Please join me in welcoming her.

Isolde Brindale: Thank you for the warm introduction. Today I’ll share insights from our recent work on adjusting detection thresholds in our camera network to reduce false alarms caused by environmental factors like dust and fog—critical for improving utility vegetation management and outage risk mitigation.

Our network of 1,200 cameras spans the high-risk Northern Ridge and Southern Valley zones. These cameras continuously monitor line corridors and vegetation growth, triggering alerts when smoke plumes or heat signatures indicative of wildfire are detected. However, the challenge lies in balancing sensitivity: too low, and we miss early signs of fire; too high, and we drown in false alarms. Dust storms and fog are frequent weather conditions that currently skew sensor readings.

To address this, we embarked on a multi-phase sensitivity calibration project over the past 18 months.

**Phase 1: Baseline Data Collection**  
We collected six months of continuous raw sensor data during the spring dust storm season and early fall fog period. This dataset helped us characterize how particulate matter and moisture interfere with infrared and visible light sensors. We analyzed over 10,000 false positives logged during these months.

**Phase 2: Threshold Adjustment Algorithm Development**  
Using baseline data, we developed a dynamic thresholding algorithm that adjusts detection sensitivity according to environmental inputs. For example, during intense dust events, the algorithm raises smoke detection thresholds by up to 15% to prevent alert flooding. Conversely, during clear conditions, thresholds revert to more sensitive settings.

**Phase 3: Field Deployment and Feedback**  
We deployed the updated algorithm on 300 cameras across two test corridors prone to dust and fog. Over three months, false alarms dropped by 42%, while true fire detections remained consistent with prior performance. Utility line inspection teams reported a 30% reduction in unnecessary dispatches.

One lesson learned is the importance of integrating weather station data with camera telemetry. Cameras alone can’t reliably distinguish dust from smoke, but correlating particulate sensors and humidity readings enables more precise threshold tuning.

Another finding was the need for seasonal recalibration. Dust composition and fog density vary across months, so fixed thresholds degrade accuracy over time. Implementing an automated monthly recalibration schedule based on localized environmental data has improved long-term detection reliability.

In summary, adjusting detection thresholds using real-time environmental data markedly reduces false alarms caused by dust and fog without compromising wildfire detection capability. Our ongoing goal is to scale this adaptive calibration model across the full 1,200-camera network by Q4 2024.

Thank you for your attention. I’m happy to take questions.

Audience Member: How do you ensure the algorithm doesn’t miss real fires during dust storms when thresholds are raised?

Isolde Brindale: Great question. We incorporate multiple data streams including thermal IR signatures which are less affected by dust, and we use conservative threshold increases capped at 15%. We also maintain manual monitoring during peak dust events as a safety net while continuously refining the model.

Audience Member: Has this calibration affected detection latency at all?

Isolde Brindale: Minimal impact. The algorithm runs locally on camera edge processors, so adjustments happen in near real-time. Our tests show detection latency stays within the same 2-second window as before calibration.

Audience Member: Are there plans to incorporate machine learning into the calibration process?

Isolde Brindale: Yes, that’s our next step. We’re piloting ML models that learn from ongoing false alarm patterns and adapt thresholds dynamically beyond rule-based adjustments. Early results are promising but we want to ensure robustness before full rollout.

Moderator: Thank you, Isolde, for sharing these valuable lessons. That concludes our session.
