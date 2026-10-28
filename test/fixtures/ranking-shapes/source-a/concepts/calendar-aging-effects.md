---
type: "concept"
title: "Calendar Aging Effects"
tags: ["grid-scale-battery-storage"]
---

# Calendar Aging Effects

Calendar Aging Effects refer to the gradual loss of a battery's capacity purely due to the passage of time, independent of how much it is cycled or used. This degradation results from chemical changes within the battery cells, such as electrolyte breakdown, solid electrolyte interphase growth, or corrosion of electrodes.

Unlike cycling degradation, which depends on charge/discharge patterns, calendar aging occurs even when the battery is idle. Factors accelerating it include higher temperatures and elevated state-of-charge (SoC) levels. The tradeoff in dispatch software is balancing battery availability against minimizing aging—for example, avoiding keeping the battery at 100% SoC or in hot environments for extended periods.

**Example:** A 1 MWh grid battery stored at a constant 95% SoC and 35°C may lose about 3% capacity annually due to calendar aging, translating to 30 kWh lost per year without any cycling. Cooling systems and reduced SoC targets can halve this loss but increase operational costs.

**Common failure modes** include capacity fade beyond usable limits, increased internal resistance, and safety risks from internal short circuits caused by dendrite formation.
