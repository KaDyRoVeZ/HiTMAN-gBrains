---
type: "note"
title: "Catastrophe response data latency"
tags: ["satellite-imagery-analytics-for-insurers"]
---

# Catastrophe response data latency

Yesterday’s sync focused on cutting down the latency from satellite image capture to issuing alerts during catastrophes. Right now, our average delay is about 6 hours—too long for flood or hurricane response teams. We measured pipeline segments: data ingestion takes roughly 1.5 hours due to satellite downlink schedules and ground station availability. Preprocessing and roof condition scoring add another 2 hours, and alert generation/dispatch about 2.5 hours.

Key bottlenecks identified: satellite revisit frequency, file transfer bandwidth, and cloud processing queue delays. Open questions: Can we prioritize catastrophe-area tiles in the ingestion queue? Would edge computing near ground stations be feasible? Next steps: run a pilot with prioritized ingest for last week’s Markley flood event, and investigate partnerships for dedicated bandwidth with the TerraSat network.
