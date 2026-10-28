---
type: "meeting"
title: "Clause Extraction Algorithm Review"
tags: ["legal-contract-automation"]
date: "2023-05-16"
attendees: ["Torben Fennmere","Amadeo Ibbdale","Dorrit Ravnham"]
---

# Clause Extraction Algorithm Review

Date: 2023-05-16  
Attendees: Torben Fennmere, Amadeo Ibbdale, Dorrit Ravnham  

**Agenda:**  
- Review current clause extraction algorithm performance  
- Identify bottlenecks in clause identification accuracy  
- Propose improvements and enhancements to the ML models  
- Assign action items for next development sprint  

**Discussion:**  

Torben opened the meeting by presenting the latest evaluation metrics of the clause extraction algorithm used in the ContractIQ platform. Current accuracy sits at 82.4% overall clause identification, with a precision of 85.1% and recall of 79.8%, based on the 10,000-contract benchmark set from Q1 2023.

Amadeo highlighted that certain clause types—specifically indemnity, confidentiality, and termination—showed uneven model performance. Indemnity clauses had the lowest recall at 71.2%, while termination clauses had the highest precision at 89.4%. Dorrit pointed out that this variability is impacting procurement teams’ trust in automated redlining suggestions, leading to increased manual intervention.

The team reviewed error analysis reports from the last sprint. Patterns showed frequent misclassification of clauses with overlapping language, especially within multi-purpose sections combining payment terms and liability. The ML model struggles with long, nested sentences common in those contract templates from the manufacturing sector.

Torben proposed integrating a domain-specific syntactic parser to better handle complex sentence structures. Amadeo suggested augmenting the training dataset with an additional 5,000 annotated contract segments focusing on those problematic clause types and sectors. Dorrit recommended adding a confidence score threshold filter to flag ambiguous clauses for human review instead of automatic extraction.

The team agreed to prioritize improving recall on indemnity clauses to at least 78% by the end of Q2, while maintaining precision above 84%. They also discussed expanding the clause taxonomy to include emerging procurement terms that have appeared in recent contracts.

**Decisions:**  
- Integrate domain-specific syntactic parser module by June 15, 2023. (Owner: Torben)  
- Expand annotated training data by 5,000 segments focused on indemnity, confidentiality, and termination clauses. (Owner: Amadeo)  
- Develop confidence score threshold and human-in-the-loop review workflow for ambiguous clause identifications. (Owner: Dorrit)  
- Set target recall improvement for indemnity clauses to 78% with precision above 84% for next release.  
- Update clause taxonomy to include 12 new procurement-related clause categories identified in last quarter’s contracts. (Owner: Dorrit)  

**Action Items:**  
- Torben to research and select syntactic parser tools compatible with current ML pipeline by May 30.  
- Amadeo to coordinate annotation team for expanded training dataset; initial batch due June 10.  
- Dorrit to draft confidence threshold parameters and design review workflow; present prototype June 5.  
- All to meet again on June 16 for progress review and integration planning.

Attendee pages: [[people/torben-fennmere]], [[people/amadeo-ibbdale]], [[people/dorrit-ravnham]].
