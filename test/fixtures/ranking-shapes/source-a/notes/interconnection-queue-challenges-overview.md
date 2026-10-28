---
type: "note"
title: "Interconnection Queue Challenges Overview"
tags: ["grid-scale-battery-storage"]
---

# Interconnection Queue Challenges Overview

Interconnection Queue Challenges Overview – Working Note

Date: 2024-06-12  
Author: Ephik L., Grid Analytics Team

---

**Observations**

Over the last 6 months, we’ve tracked interconnection queue progress for 58 battery storage projects across the Northridge and Central Plains grids. The average queue time has ballooned from 14 months to nearly 27 months, with some projects stuck over 3 years. This delay drastically impacts our dispatch optimization and revenue forecasting models because project timelines become unpredictable.

Key bottlenecks identified so far:

- **Network Stability Studies:** About 40% of projects are delayed awaiting completed stability impact assessments. The complexity of battery inverter interactions with local grid controls is causing repeated study revisions.
- **Upgrade Cost Allocations:** Developers face protracted negotiations over who pays for grid upgrades. This has led to several projects pausing their applications or withdrawing entirely.
- **Queue Backlogs:** The Northeast Interconnect Authority has a backlog exceeding 250GW, with battery projects making up ~35%. Their processing capacity has not scaled with submission growth.

**Measurements**

- Average interconnection delay: 26.8 months (target was 12 months)  
- Withdrawal rate: 18% of proposed battery projects in queues last year (up from 7% two years ago)  
- Studies re-submission frequency: On average 2.7 rounds per project for stability impacts

**Open Questions**

- How does increasing frequency of re-submissions correlate with project size or battery chemistry type?  
- Can predictive degradation models help prioritize which projects are less likely to change specs and thus reduce re-work?  
- What impact do interconnection delays have on our market bidding algorithms when project commissioning shifts unpredictably?

**Next Steps**

- Collaborate with the Grid Planning team to get detailed timelines on stability assessment steps.  
- Analyze queue withdrawal cases to identify common financial or technical thresholds triggering them.  
- Run simulations incorporating varying queue delay scenarios to assess sensitivity of dispatch schedules and degradation cost forecasts.

Keeping these insights updated will be critical as we refine our dispatch software to better accommodate real-world interconnection realities.
