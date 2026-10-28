---
type: "note"
title: "Best Practices for Dosing Systems"
tags: ["vertical-farming-and-indoor-agriculture"]
---

# Best Practices for Dosing Systems

Working Note: Nutrient Dosing Calibration Observations  
Author: Ephik L., Agronomy Tech Team  
Date: 2024-06-09  

---

Over the past two weeks, I’ve been focusing on the calibration of nutrient dosing systems in our hydroponic grow towers, specifically in the Bayview test lab. The goal is to optimize the delivery of nutrients to maximize yield while minimizing waste and system wear.

**Key Parameters Observed**  
- **Flow Rate Consistency:** Using the inline flow sensors, we noted that the dosing pumps vary by up to ±4% from their set target flow after 12 hours of continuous operation. This is slightly higher than the ±2% tolerance we originally aimed for.  
- **Nutrient Concentration Stability:** Sample analysis at the mixing chamber shows nutrient concentrations fluctuate by about 3.5% throughout a 24-hour cycle, likely due to small delays in the feedback loop between sensors and dosing valves.  
- **pH and EC Response Lags:** There is a measurable lag (~5 minutes) between nutrient dosing adjustments and stabilized pH/EC readings downstream. This impacts our ability to do rapid correction cycles during peak growth phases.  

**Measurements Summary**  
- Pump calibration runs (3 replicates) at setpoints of 50, 100, 150 mL/min  
- Nutrient sample tests every 3 hours for 24 hours (N=8 per run)  
- Environmental conditions: stable at 22°C ±1°C, humidity 60% ±5%  

**Open Questions**  
- Can we reduce the dosing pump drift through hardware tweaks or better self-calibration routines?  
- Is it practical to implement predictive dosing based on growth stage forecasts to compensate for the observed lag?  
- How much nutrient fluctuation is tolerable before impacting plant growth metrics negatively?  

**Next Steps**  
- Run a controlled experiment adjusting pump motor voltage to see if flow stability improves.  
- Develop a simulation model incorporating the 5-minute lag to test predictive dosing algorithms.  
- Coordinate with the Plant Biology group to correlate dosing variability with plant health data from the last 3 growth cycles.  

Will update with preliminary results by end of next week. Open to suggestions or requests for additional parameter monitoring.
