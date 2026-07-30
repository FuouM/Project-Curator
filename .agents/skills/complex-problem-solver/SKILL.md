---
name: complex-problem-solver
description: A specialized framework for solving highly complex, open-ended, or stubborn software engineering problems (e.g., race conditions, deep refactoring, architectural bottlenecks) using structured design tracking, adversarial self-auditing, and diverse implementation portfolios.
---

# Complex Problem Solver: Structured Software Development Framework

This skill is adapted from the advanced heuristics used to prove the Cycle Double Cover Conjecture, modified for structured, single-agent software engineering. Use this skill when tasked with resolving exceptionally difficult challenges, such as:
- Eliminating elusive race conditions or concurrency bugs.
- Architecting high-performance or complex system designs.
- Executing high-risk, zero-downtime refactors.
- Optimizing deep performance bottlenecks.

---

## 1. Structured Exploration & Design Heuristics

When resolving a complex software engineering problem, avoid committing to a single approach early:

### A. Leverage Extensive Web Research
*   **Never limit web searches:** Use web search tools aggressively to look up existing literature, error logs, documentation, community solutions, and similar issues in open-source code.
*   **Search broad and deep:** Do not restrict searching to just one query; pivot search terms as you discover new keywords, dependencies, or error classes.

### B. Do Not Reinvent the Wheel
*   **Prioritize existing solutions:** Favor established libraries, native API capabilities, and industry-standard design patterns over custom-written mechanisms.
*   **Justify custom logic:** Only write custom replacements if there is a compelling, documented reason (e.g., severe performance constraints, dependency version conflicts, licensing issues, or security protocols).

### C. Establish a Diverse Portfolio of Approaches
Outline and analyze completely different paradigms based on your research:
- **Approach A (Structural/Architectural):** Refactoring the layout, decoupling modules, state machine patterns.
- **Approach B (Algorithmic/Data-flow):** Streamlining hot paths, lock-free data structures, worker pools, caching.
- **Approach C (Defensive/Workaround):** Rate limiting, fallback handlers, graceful degradation.
- **Approach D (Observability-driven):** Deep instrumenting to locate hidden assumptions before modifying state.

### D. Preserve Independence in Analysis Tracks
*   **Prevent early convergence:** Do not assume the most attractive or elegant-looking approach is the correct one.
*   **Isolate your reasoning:** Fully investigate each candidate design path to understand its exact trade-offs before attempting to merge or combine ideas.

### E. Maintain an Approach Registry
Keep an explicit registry of ideas in a design document or scratchpad:
- Classify ideas by their core mechanical strategy and technical trade-offs.
- List open assumptions, potential failure points, and dependencies for each.

### F. Handle Stalls and Blockers
*   If a design route stalls due to an external library limitation, API deprecation, or unacceptable latency overhead, mark it as **blocked**.
*   Shift focus to another track. Do not revisit a blocked path unless you uncover a materially new mechanism, workaround, or patch.

---

## 2. Adversarial Self-Auditing & Verification

Every candidate solution must undergo rigorous adversarial review before acceptance. Actively try to break your own designs by checking for:

*   **Concurrency & State Issues:** Race conditions under high load, deadlocks, re-entrancy bugs, resource leaks, or memory bloat.
*   **Boundary Conditions:** Null/empty inputs, disconnected network states, malformed payloads, overflow errors, and partial write failures.
*   **Hidden Assumptions:** Reliance on specific database configurations, single-thread assumptions, or implicit execution order.
*   **Regressions:** Unintended side effects on unrelated modules, performance degradations, or broken backwards compatibility.

---

## 3. Execution Protocols

### A. Demand Concrete Deliverables
Do not accept vague status reports or assume that verification is "trivial" or "routine." Always produce:
1.  **A Proof of Concept (POC) or reproduction script** showing the fix or design in action.
2.  **Benchmark results** (when performance is a factor).
3.  **Automated regression tests** (unit/integration/stress tests).

### B. Iterative Synthesizing
Repeatedly synthesize, challenge, and redirect your exploration. If the initial approach fails, analyze the failure mode, adjust the system architecture constraints, and launch a new track of exploration.

---

## 4. When to Return the Solution
Do not return a partial fix, temporary workaround (unless explicitly requested), or a simple explanation of why the problem is hard. Return only when:
1.  A complete, working implementation has been fully integrated.
2.  The implementation has successfully passed all automated tests and adversarial audits.
3.  A comprehensive [walkthrough.md](file:///walkthrough.md) documenting the chosen approach, alternatives explored, and test results is created.

