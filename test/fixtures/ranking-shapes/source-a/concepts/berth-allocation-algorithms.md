---
type: "concept"
title: "Berth Allocation Algorithms"
tags: ["maritime-port-operations"]
---

# Berth Allocation Algorithms

Berth Allocation Algorithms assign incoming vessels to available dock spaces at a maritime port to optimize operational efficiency and fairness. These computational methods consider factors such as vessel size, arrival time, unloading duration, and priority levels to produce scheduling plans that minimize waiting times and maximize berth utilization.

**How It Works**  
The algorithm receives a list of vessels with attributes: estimated time of arrival (ETA), cargo type, handling time, and priority (e.g., perishable goods). It matches vessels to berths, respecting constraints like berth length and equipment compatibility. Common approaches include:  
- **Greedy heuristics:** Assign vessels sequentially based on earliest arrival or highest priority.  
- **Integer Linear Programming (ILP):** Formulate allocation as an optimization problem minimizing total vessel waiting time under berth length and time-window constraints.  
- **Metaheuristics (e.g., Genetic Algorithms):** Explore multiple allocation scenarios to find near-optimal solutions in complex settings.

**Tradeoffs**  
Simple heuristics run quickly but can cause suboptimal berth usage or unfair delays. ILP offers optimality but may struggle with real-time scale (e.g., >50 vessels). Metaheuristics balance solution quality and computational cost but require parameter tuning.

**Example**  
Given three vessels:  
- V1: ETA 08:00, 300m length, 4 hours handling  
- V2: ETA 09:00, 250m length, 3 hours handling  
- V3: ETA 08:30, 200m length, 5 hours handling  

With two berths (Berth A: 350m, Berth B: 250m), the algorithm might schedule:  
- V1 at Berth A from 08:00 to 12:00  
- V3 at Berth B from 08:30 to 13:30  
- V2 waits until Berth B frees at 13:30, causing 4.5 hours delay

**Common Failure Modes**  
- Overlapping schedules causing berth conflicts  
- Inaccurate ETA data leading to idle time or bottlenecks  
- Ignoring priority, resulting in unfair allocation  
- Failing to account for equipment compatibility (e.g., crane types) leading to operational delays
