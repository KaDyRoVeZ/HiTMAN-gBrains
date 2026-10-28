---
type: "meeting"
title: "Queue Optimization Strategy Session"
tags: ["grid-scale-battery-storage"]
date: "2024-10-01"
attendees: ["Kestrel Gwilham","Lisbet Brinhollow","Rune Ulmmoor"]
---

# Queue Optimization Strategy Session

Date: 2024-10-01  
Attendees: Kestrel Gwilham, Lisbet Brinhollow, Rune Ulmmoor  
Subject: Reviewed new algorithms to prioritize battery projects in congested interconnection queues

---

### Agenda  
- Review current state of interconnection queue for grid-scale batteries  
- Analyze performance of new prioritization algorithms  
- Discuss integration of degradation modeling into queue ranking  
- Decide next steps for pilot deployment  

### Discussion

**Current Queue Overview**  
- The interconnection queue for the Northridge grid segment currently holds 142 battery storage projects totaling 3.5 GW capacity.  
- Average queue wait time has increased from 14 months to 22 months over the last 6 months due to congestion and network upgrades.  
- Delays predominantly impact projects below 50 MW, which comprise 68% of total queued projects.

**Algorithm Performance**  
- Rune presented results from the new multi-factor prioritization algorithm that weighs project size, expected degradation rates, and interconnection feasibility scores.  
- In simulation, this algorithm improved average dispatch readiness time by 18% compared to the baseline FIFO (first-in-first-out) approach.  
- Lisbet highlighted that incorporating degradation modeling reduced the risk of early project retirement by 12%, improving long-term reliability forecasts.

**Degradation Modeling Integration**  
- Kestrel emphasized the need to integrate real-time degradation data to continuously update project rankings.  
- Current degradation models rely on static assumptions; the proposed dynamic model updates weekly based on field sensor data.  
- This approach is projected to improve queue prioritization accuracy by up to 25%, especially for projects utilizing advanced lithium-titanate chemistries.

**Decisions**  
- Approve pilot deployment of the multi-factor prioritization algorithm with integrated degradation updates on the Northridge queue.  
- Limit pilot to the 42 projects between 20 MW and 50 MW to better manage complexity.  
- Run pilot for a 6-month period with monthly reporting on queue movement and project readiness metrics.

### Action Items

- **Rune Ulmmoor:** Lead pilot implementation; coordinate with grid operations to enable weekly degradation data feeds. Deadline: 2024-11-15  
- **Lisbet Brinhollow:** Develop dashboard for real-time queue ranking visualization incorporating new algorithm outputs. Deadline: 2024-11-30  
- **Kestrel Gwilham:** Draft communication plan for stakeholders explaining pilot goals and expected impacts. Deadline: 2024-10-15  

Next meeting scheduled for 2024-11-20 to review initial pilot results.

Attendee pages: [[people/kestrel-gwilham]], [[people/lisbet-brinhollow]], [[people/rune-ulmmoor]].
