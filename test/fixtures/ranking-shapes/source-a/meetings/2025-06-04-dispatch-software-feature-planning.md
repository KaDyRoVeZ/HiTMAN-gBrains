---
type: "meeting"
title: "Dispatch Software Feature Planning"
tags: ["grid-scale-battery-storage"]
date: "2025-06-04"
attendees: ["Rune Ulmmoor","Lisbet Brinhollow","Kestrel Gwilham"]
---

# Dispatch Software Feature Planning

Date: 2025-06-04  
Attendees: Rune Ulmmoor, Lisbet Brinhollow, Kestrel Gwilham  

**Agenda:**  
- Review performance gaps in current dispatch software under peak load variability  
- Prioritize feature improvements for next iteration  
- Assign development and testing responsibilities  

**Discussion:**  
Rune opened the meeting by presenting data from May 2025, showing a 12% increase in forecast error during peak load hours between 5-8 PM, contributing to suboptimal battery utilization. Lisbet noted that the degradation model currently underestimates capacity fade by 3% monthly under heavy cycling, skewing dispatch decisions. Kestrel proposed integrating a dynamic load forecasting module leveraging real-time grid signals, expecting to reduce forecast error by at least 7%. All agreed that incorporating adaptive degradation modeling would better align dispatch outputs with actual battery health.  

They debated prioritizing interconnection queue updates but concluded these could wait to focus on improving dispatch accuracy, given a backlog of 1,200 queued projects nationwide.  

**Decisions:**  
- Prioritize development of dynamic load forecasting and adaptive degradation modeling for the Q3 2025 release.  
- Defer interconnection queue module updates to Q1 2026.  

**Action Items:**  
- Rune to lead the load forecasting module design, due by 2025-07-15.  
- Lisbet to update degradation modeling parameters and test scenarios, due by 2025-07-30.  
- Kestrel to coordinate integration testing and performance validation, deliver results by 2025-08-20.

Attendee pages: [[people/rune-ulmmoor]], [[people/lisbet-brinhollow]], [[people/kestrel-gwilham]].
