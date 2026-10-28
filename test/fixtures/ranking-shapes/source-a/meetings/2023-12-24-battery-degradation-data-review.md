---
type: "meeting"
title: "Battery Degradation Data Review"
tags: ["grid-scale-battery-storage"]
date: "2023-12-24"
attendees: ["Kestrel Gwilham","Rune Ulmmoor","Lisbet Brinhollow"]
---

# Battery Degradation Data Review

Date: 2023-12-24  
Attendees: Kestrel Gwilham, Rune Ulmmoor, Lisbet Brinhollow  

**Agenda:**  
- Review latest lithium-ion battery degradation data from field tests  
- Compare observed degradation rates to model predictions  
- Discuss implications for dispatch software accuracy  
- Define next steps for data integration and model refinement  

**Discussion:**  
Kestrel presented degradation data from 120 grid-scale units monitored over 18 months in the Triwyn region. Average capacity fade was 11.7% ± 0.9%, slightly higher than the 10.2% predicted by the current degradation model for similar usage cycles. Rune noted that temperature variance in the Triwyn climate (+7°C deviation) likely accelerated aging beyond model assumptions. Lisbet suggested the interconnection queue’s projected dispatch patterns might need adjustment to incorporate these findings. The team agreed the model underestimates degradation during frequent high-rate charge cycles observed in peak-demand periods.  

**Decisions:**  
- Update degradation model parameters to include temperature variance effects and cycling intensity  
- Prioritize integration of revised degradation curves into dispatch algorithms before Q1 2024  

**Action Items:**  
- Kestrel to run sensitivity analysis on temperature impact by Jan 15 (Owner: Kestrel)  
- Rune to draft updated model parameters by Jan 22 (Owner: Rune)  
- Lisbet to coordinate with dispatch software team for integration planning by Jan 29 (Owner: Lisbet)

Attendee pages: [[people/kestrel-gwilham]], [[people/rune-ulmmoor]], [[people/lisbet-brinhollow]].
