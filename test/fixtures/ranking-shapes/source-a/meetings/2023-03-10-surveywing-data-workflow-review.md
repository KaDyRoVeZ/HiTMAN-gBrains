---
type: "meeting"
title: "SurveyWing Data Workflow Review"
tags: ["construction-site-robotics"]
date: "2023-03-10"
attendees: ["Dorrit Lornley","Zosia Jorvley","Yorick Talvwick"]
---

# SurveyWing Data Workflow Review

Date: 2023-03-10  
Attendees: Dorrit Lornley, Zosia Jorvley, Yorick Talvwick  

## Agenda  
- Review current SurveyWing drone data processing pipelines  
- Compare throughput and accuracy metrics  
- Identify bottlenecks impacting site survey efficiency  
- Decide next steps for optimization  

## Discussion  
Dorrit presented the latest benchmarking results for the SurveyWing drone data workflows. The primary pipeline using the GeoMapper v2.1 software processed 5,000 images per survey with an average completion time of 4 hours and positional accuracy within 12 cm. An alternative pipeline employing the AeroScan proprietary software processed the same amount of data in 3.5 hours but showed a degradation in accuracy to 18 cm.  

Zosia highlighted that current site turnover times require survey data within 3 hours to support same-day rebar tying adjustments. Yorick noted that the bottleneck occurs during the image stitching phase, consuming 45% of total processing time in the GeoMapper pipeline and 35% in AeroScan.  

Dorrit suggested exploring parallel processing to reduce stitching time and testing hybrid pipelines combining the mapping accuracy of GeoMapper with AeroScan’s faster image preprocessing.  

## Decisions  
- Pilot a hybrid pipeline combining GeoMapper’s stitching with AeroScan’s preprocessing  
- Target overall processing time reduction to under 3 hours with positional accuracy ≤15 cm  

## Action Items  
- Dorrit to coordinate development of the hybrid pipeline by 2023-04-15  
- Zosia to arrange field tests at the East Ridge project site starting 2023-04-20  
- Yorick to investigate cloud-based parallel processing options and report by 2023-04-10

Attendee pages: [[people/dorrit-lornley]], [[people/zosia-jorvley]], [[people/yorick-talvwick]].
