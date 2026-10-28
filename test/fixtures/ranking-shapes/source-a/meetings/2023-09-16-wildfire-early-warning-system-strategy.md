---
type: "meeting"
title: "Wildfire Early Warning System Strategy"
tags: ["wildfire-detection-and-utility"]
date: "2023-09-16"
attendees: ["Eilis Holmstead","Zephyra Yarlvane"]
---

# Wildfire Early Warning System Strategy

Date: 2023-09-16  
Attendees: Eilis Holmstead (Project Lead), Zephyra Yarlvane (Data Science Manager)  

Agenda:  
- Official kickoff of the Wildfire Sensor Pilot  
- Integration approach for camera-based sensors with existing utility vegetation management data  
- Defining success metrics and timelines  
- Assigning ownership and next steps  

Discussion:  
Eilis opened the meeting by formally announcing the start of the Wildfire Sensor Pilot as of today, September 16, 2023. She will serve as the pilot’s project owner, overseeing coordination between the sensor deployment team and utility data analysts. The pilot aims to validate the effectiveness of camera-networked wildfire early warning sensors in detecting potential ignition sources near high-risk electrical infrastructure.

Zephyra presented an overview of the current utility vegetation management (UVM) database, which contains line inspection records and outage risk assessments for over 12,000 miles of distribution lines in Northern Cascadia Region. She emphasized the importance of integrating live sensor data streams with this existing UVM data to enable real-time risk scoring and alert prioritization.

They discussed the proposed integration architecture: camera networks installed on 50 critical line segments will feed continuous video and thermal imaging data to the central Wildfire Early Warning System (WEWS) platform. This data will be cross-referenced with vegetation density, historical trimming schedules, and outage risk zones in the UVM database. The goal is to identify early signs of vegetation encroachment or ignition, enabling preemptive utility response.

Eilis highlighted key performance indicators (KPIs) for the pilot, including:  
- Detection accuracy of fire ignition or smoke events at a minimum of 85% within the sensor coverage area  
- Reduction of vegetation-related outage incidents by at least 15% in pilot zones over the next 12 months  
- System latency from sensor detection to alert issuance below 5 minutes  

Zephyra proposed an initial evaluation period of 6 months post-deployment, during which the sensor data will be collected and cross-validated with ground truth observations and line patrol reports. This timeline aligns with the end of the high-fire-risk season in March 2024.

They agreed to conduct monthly progress reviews to monitor data quality, sensor health, and integration challenges. The first installation of camera units is scheduled for October 10, 2023, targeting the highest priority risk segment in Pine Valley.

Decisions:  
- Eilis Holmstead confirmed as pilot owner responsible for overall project delivery and coordination.  
- Integration approach to proceed as described, combining camera sensor feeds with UVM data for risk scoring.  
- KPIs and 6-month evaluation timeline approved.  
- Monthly progress reviews to begin October 20, 2023.  

Action Items:  
- Zephyra to finalize data integration pipeline design and share detailed architecture diagram by September 30, 2023.  
- Eilis to coordinate with field ops team for camera unit installation prep by October 5, 2023.  
- Both to draft pilot communication plan for internal stakeholders, targeting completion by September 25, 2023.  
- Data engineering team to begin sensor data ingestion framework development immediately, with initial test data feed by October 1, 2023.

Attendee pages: [[people/eilis-holmstead]], [[people/zephyra-yarlvane]].
