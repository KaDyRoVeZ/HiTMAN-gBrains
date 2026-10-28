---
type: "note"
title: "Camera Network Sensitivity Calibration"
tags: ["wildfire-detection-and-utility"]
---

# Camera Network Sensitivity Calibration

Camera Network Sensitivity Calibration – Working Note  
Author: Rajesh K., Vision Systems Analyst  
Date: 2024-06-12

---

**Observations:**  
Over the past three weeks, the Red River Valley camera cluster has shown a significant uptick in false positives triggered by environmental noise, specifically dust storms and intermittent fog patches. Our current detection thresholds, which were initially set during dry season conditions, are proving too sensitive under these variable atmospheric conditions.

- On June 3 and June 7, we recorded 47 false alarms attributed to dust plumes from nearby agricultural activity.  
- On June 9 and June 11, fog-induced glare led to 32 false positives, especially on cameras 12 through 18.  
- These false alarms are causing unnecessary dispatches and sensor recalibrations, increasing operational costs by an estimated 15% in the last week alone.

**Measurements:**  
To quantify the issue, I ran comparative analytics on pixel intensity variance and motion detection patterns in flagged events versus confirmed wildfire events from the last month. Key metrics:  

- Dust events typically show a rapid onset of high-frequency pixel noise but lack the sustained thermal signature we expect from fire sources.  
- Fog events produce a more diffuse, low-contrast haze, raising baseline luminance but without sharp edges or movement patterns typical of flames.  
- Current threshold settings for motion detection are at 0.15 variance units; false positives consistently fall between 0.12 and 0.16, overlapping with genuine events between 0.14 and 0.22.

**Open Questions:**  
- Should we implement an adaptive threshold model that adjusts based on local weather sensor data (humidity, particulate levels)?  
- Can combining thermal and optical feeds enhance discrimination between smoke/fog/dust and fire?  
- What is the acceptable trade-off between missed detections and false positives for risk tolerance in this region?

**Next Steps:**  
- Propose a pilot on cameras 10–20 to test dynamic thresholding using real-time meteorological inputs starting June 15.  
- Collaborate with hardware team to explore integration of low-cost particulate sensors near cameras prone to dust interference.  
- Update anomaly classification scripts to incorporate temporal persistence filters to reduce transient noise-triggered alarms.  
- Schedule a review meeting with field operations on June 20 to discuss impact on dispatch protocols.

I'll update this note with progress and any new findings. Feedback welcome, especially from the data science and field teams.
