---
type: "meeting"
title: "Kickoff for roof analytics integration"
tags: ["satellite-imagery-analytics-for-insurers"]
date: "2023-11-22"
attendees: ["Marlow Jorvvane","Bram Holmmoor","Oriel Zelkdale"]
---

# Kickoff for roof analytics integration

Date: 2023-11-22  
Attendees: Marlow Jorvvane, Bram Holmmoor, Oriel Zelkdale  
Meeting subject: Initiated internal collaboration to embed satellite roof scoring into claims workflow

---

### Agenda  
- Overview of current satellite roof condition scoring capabilities  
- Review of integration goals with claims workflow  
- Define key metrics and performance targets  
- Outline initial project timeline and responsibilities  

### Discussion  

Marlow opened the meeting by summarizing the roof condition scoring model's accuracy at 87.3% based on the latest validation set of 15,000 roofs across Midwestern states. Bram emphasized the importance of reducing claim processing time by at least 25% through early detection of roof damage using satellite imagery. Oriel highlighted that flood extent analytics had already improved catastrophe response speed by 18% and expressed optimism about similar gains for roof analytics.

The team discussed integration points: Marlow proposed embedding roof scores as an additional attribute in the existing claims dashboard, aiming for a rollout in Q1 2024. Bram requested the system accommodate real-time roof condition updates, with data refresh intervals no longer than 48 hours. Oriel stressed the need to validate the scoring model specifically on regions with frequent hail storms, suggesting an additional 5,000 annotated samples.

### Decisions  
- Proceed with phased integration starting with pilot in Central Plains region  
- Target claim processing time reduction of 25% by end of Q2 2024  
- Prioritize data refresh frequency at 48 hours or less  

### Action Items  
- Marlow to prepare detailed data schema and API specs by 2023-12-08  
- Bram to coordinate with claims IT team for dashboard modifications, deadline 2023-12-15  
- Oriel to organize acquisition of hail storm region data samples, target 5,000 by 2023-12-22

Attendee pages: [[people/marlow-jorvvane]], [[people/bram-holmmoor]], [[people/oriel-zelkdale]].
