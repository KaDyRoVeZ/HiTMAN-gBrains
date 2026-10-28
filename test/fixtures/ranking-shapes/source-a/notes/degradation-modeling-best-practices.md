---
type: "note"
title: "Degradation Modeling Best Practices"
tags: ["grid-scale-battery-storage"]
---

# Degradation Modeling Best Practices

Degradation Modeling Best Practices — Working Note

From recent modeling runs on the Helios 2MWh battery in the East Valley project, a few observations have emerged regarding accurately predicting lifespan under frequent grid cycling:

- **Cycle Counting Method:** Using rainflow counting on power dispatch profiles yields a much tighter correlation to observed capacity fade than simple calendar time or throughput metrics. The stress from depth-of-discharge swings is clearly nonlinear and must be captured.
- **Temperature Effects:** Ambient temperature variation during cycling contributes significantly to degradation rates. Including hourly temperature data from the microclimate sensor improved model fit by about 15%.
- **Rest Periods:** Incorporating rest-time degradation—modeling open-circuit voltage relaxation during idle hours—further refined capacity fade estimates, especially during low-utilization periods.

Open questions and next steps:

- How to best calibrate calendar fade parameters vs cycle fade for batteries under irregular, grid-scale dispatch profiles? Current lab data is from steady, repetitive cycling.
- Can adding impedance spectroscopy data from periodic field tests improve parameter identification?
- Planning to run a controlled 6-month test with varied SoC windows, simulating peak vs off-peak dispatch, to isolate cycle stress effects.

Overall, the combined approach of rainflow cycle counting + temperature + rest modeling seems promising for next-gen degradation forecasts. Feedback welcome!
