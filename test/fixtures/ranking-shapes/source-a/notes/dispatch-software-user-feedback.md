---
type: "note"
title: "Dispatch Software User Feedback"
tags: ["grid-scale-battery-storage"]
---

# Dispatch Software User Feedback

Dispatch Software User Feedback – Working Note

Date: 2024-06-15  
Author: Ephik T., Product Analyst

Summary:  
Collected feedback during the last two weeks from 7 grid storage operators using the DispatchPro v2.3 platform. Overall usability is rated at 7.8/10, with specific pain points around the forecasting interface and real-time adjustment capabilities.

Key observations:  
- Operators appreciate the clear visualization of state-of-charge and degradation estimates but report that the interface lags during high-frequency data updates (notably between 5-7 PM local peak hours).  
- The manual override feature, introduced in v2.2, is praised but lacks granularity; operators want finer control over charge/discharge ramp rates.  
- Several users requested an integrated alert system for interconnection queue status changes, as many manage multiple projects simultaneously and are currently tracking this externally.  
- Degradation modeling outputs are considered accurate but could benefit from scenario comparisons (e.g., stress testing under different cycling profiles).

Open questions:  
- Can we optimize data refresh intervals without sacrificing accuracy, especially during peak dispatch periods?  
- What UI designs could better accommodate the manual ramp rate adjustments without clutter?  
- How feasible is integrating real-time queue updates from the grid operator’s API?

Next steps:  
- Schedule a UX workshop focused on ramp control improvements (tentative July 2).  
- Coordinate with the grid operator team to explore API access for queue status.  
- Prototype a scenario comparison dashboard for degradation models by end of Q3.
