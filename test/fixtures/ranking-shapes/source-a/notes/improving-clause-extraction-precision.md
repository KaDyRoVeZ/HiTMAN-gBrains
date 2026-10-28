---
type: "note"
title: "Improving Clause Extraction Precision"
tags: ["legal-contract-automation"]
---

# Improving Clause Extraction Precision

Working Note: Improving Clause Extraction Precision

Date: 2024-06-10  
Author: Kelmere (NLP Engineer)

Observations:  
- Current clause detection models achieve ~82% precision, but false positives remain an issue, especially with boilerplate language and nested clauses.  
- Most false positives stem from generic language patterns that overlap with non-clause text, e.g., introductory phrases or definitions sections.  
- Our baseline uses a BiLSTM-CRF on token sequences with standard legal embeddings (trained on 2M contracts).  

Measurements:  
- On the latest test batch (1,000 contracts), about 15% of extracted clauses are either partial or incorrectly flagged segments.  
- False positives are clustered in “indemnity” and “termination” categories, suggesting category-specific tuning might help.  
- Using stricter token-level thresholds reduces false positives but cuts recall by ~7%.  

Open questions:  
- Would integrating syntactic parsing or dependency trees help disambiguate clause boundaries?  
- Can we leverage contract metadata (contract type, jurisdiction) to contextualize extraction?  
- How feasible is adding a secondary classifier to filter out borderline cases post-extraction?  

Next steps:  
- Prototype a dependency parser-based approach on a subset of contracts.  
- Experiment with a lightweight binary classifier on extracted clauses to re-score confidence.  
- Discuss with legal SMEs about common clause variations to inform model features.
