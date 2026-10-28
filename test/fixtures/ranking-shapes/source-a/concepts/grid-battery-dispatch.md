---
type: "concept"
title: "Grid Battery Dispatch"
tags: ["grid-scale-battery-storage"]
---

# Grid Battery Dispatch

Grid Battery Dispatch refers to the real-time control of grid-scale battery systems to optimize their charge and discharge cycles in response to electricity demand, supply conditions, and market signals. The goal is to maximize economic value while maintaining battery health and supporting grid reliability.

## How It Works

Dispatch software continuously monitors grid frequency, electricity prices, and forecasted demand. Using these inputs, it decides when to charge (store excess energy) or discharge (supply energy) the battery. Decisions factor in:

- Current state of charge (SoC)
- Battery degradation models estimating the impact of cycling and depth of discharge
- Interconnection constraints such as transmission limits
- Market rules and dispatch signals from grid operators

## Tradeoffs

- **Economic vs. Degradation**: Aggressive cycling boosts revenue but accelerates battery wear, reducing lifespan.
- **Energy vs. Power Capacity**: Batteries with high energy capacity can sustain longer discharge but may have slower response times.
- **Grid Services vs. Arbitrage**: Prioritizing grid stabilization (e.g., frequency regulation) may reduce opportunities for energy price arbitrage.

## Worked Example

Consider a 10 MW / 40 MWh battery with a current SoC of 20 MWh. The dispatch software forecasts peak demand in 2 hours with a high price of $150/MWh and low prices of $30/MWh currently. Charging now at 5 MW for 4 hours costs $30 * 20 MWh = $600, and discharging later earns $150 * 20 MWh = $3,000. After accounting for 90% round-trip efficiency, net revenue is approximately $1,800. The software evaluates this against degradation costs estimated at $50 per cycle to decide to proceed.

## Common Failure Modes

- Overestimating price peaks, leading to missed revenue opportunities
- Ignoring degradation effects causing premature battery replacement
- Poor integration with grid signals causing dispatch conflicts
- Unexpected interconnection bottlenecks limiting battery output
