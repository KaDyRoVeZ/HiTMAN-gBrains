---
type: "meeting"
title: "Outage Risk Analytics Review"
tags: ["wildfire-detection-and-utility"]
date: "2024-09-27"
attendees: ["Zephyra Yarlvane","Eilis Holmstead"]
---

# Outage Risk Analytics Review

Date: 2024-09-27  
Attendees: Zephyra Yarlvane, Eilis Holmstead  

**Agenda:**  
- Review results from the latest vegetation-related outage risk predictive models  
- Discuss model accuracy and feature impact from camera network data  
- Plan next steps for integrating line inspection inputs  

**Discussion:**  
Zephyra presented the updated predictive model outcomes from the Q3 run covering the Pinegrove and Silverleaf districts. The model achieved an AUC of 0.87 on the validation set, showing a 5-point improvement over the Q2 baseline of 0.82. Key contributors included normalized line inspection frequency and NDVI values derived from the camera network images.  

Eilis noted that the model’s false positive rate decreased from 12% to 8%, which should reduce unnecessary inspection dispatches by an estimated 15% annually. However, the false negative rate remained at 9%, suggesting potential missed outages. The attendees discussed possibilities for incorporating weather forecast data to improve sensitivity, especially during high-risk wind events.  

The team also reviewed the vegetation encroachment alerts from the latest infrared image processing iteration. Zephyra highlighted an 18% increase in early detection of high-risk vegetation zones compared to manual reports.  

**Decisions:**  
- Proceed with including short-term wind forecast variables in the next model training cycle  
- Pilot integration of line inspection logs from the Redwood substation area by mid-November  

**Action Items:**  
- Zephyra to coordinate with data engineering for weather data ingestion by 2024-10-15  
- Eilis to lead the Redwood area pilot design and resource allocation by 2024-11-05  
- Both to reconvene on 2024-11-20 to review pilot progress and preliminary results

Attendee pages: [[people/zephyra-yarlvane]], [[people/eilis-holmstead]].
