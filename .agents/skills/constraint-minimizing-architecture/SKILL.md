---
name: constraint-minimizing-architecture
description: A specialized framework for designing software systems, APIs, and algorithms that maximize generalization, prevent brittleness, and eliminate over-fitting by applying Bennett's Razor (maximizing weakness over shortness).
---

# Constraint-Minimizing Architecture: Bennett's Razor Framework

This skill is adapted from formal proofs and empirical findings in enactive cognition and inductive inference ("The Optimal Choice of Hypothesis Is the Weakest, Not the Shortest"). It replaces traditional Minimum Description Length (MDL) heuristics with **Weakness Maximization**. Use this skill when tasked with:
- Designing API contracts, SDKs, or core domain abstractions intended for long-term evolution.
- Building out-of-distribution resilient algorithms, data pipelines, or machine learning interfaces.
- Refactoring brittle legacy systems plagued by implicit assumptions and edge-case fragility.
- Defining schemas, protocols, or type systems that must accommodate unobserved future requirements.

---

## 1. Core Principles of Weakness Maximization

When designing logic or interfaces, do not confuse brevity or syntactic compactness with true generality. Apply these core principles:

### A. Enforce Bennett's Razor
* **The Epistemological Rule:** *"Explanations and code contracts should be no more specific than necessary."*
* **Minimize Commitment:** Never assert constraints, layout assumptions, or type requirements unless they are strictly required by the immediate domain specifications.

### B. Distinguish Weakness from Shortness
* **Avoid the MDL Trap:** Syntactically short code ("one-liners", tight abstractions) often encodes hidden, hyper-specific assumptions about the environment.
* **Maximize Model Extension:** Prioritize logic that remains valid across the largest possible set of input states ($|Z_h|$), even if the explicit declaration requires more code than a clever shortcut.

### C. Assume Known Requirements Are Child Tasks
* **Design for the Parent Task:** Treat current system requirements ($\alpha$) merely as a child sample of an unknown, broader parent context ($\omega$). 
* **Optimize Generalization Probability:** To maximize the likelihood that your implementation generalizes from known requirements to unobserved future requirements, keep the code's valid execution set as broad (weak) as possible.

### D. Reject Premature Specialization
* **Defer Binding:** Postpone binding to concrete databases, network protocols, bit-lengths, or UI structures until the outer execution boundary.
* **Isolate Domain Kernels:** Ensure core business rules make zero assertions about how or where they are invoked.

---

## 2. API & Type Design Heuristics

Design interfaces that accept maximum input variability while making minimal assumptions about internal state:

### A. Honor the Principle of Least Specificity
* **Broad Input Types:** Prefer abstract capability types or interfaces over concrete structures (e.g., accept `Iterable<T>` or `Sequence<T>` rather than `ConcreteArrayList<T>`).
* **Minimal Property Contracts:** Require only the explicit properties required to perform the computation (e.g., structurally typed interfaces or narrow generic constraints).

### B. Decouple Structure from Behavior
* **Parametric Polymorphism:** Use generics and higher-order functions to prevent algorithms from binding to concrete data shapes.
* **Schema Permissiveness:** When handling external payloads (JSON, Proto, SQL), allow unknown fields to pass through without error unless strict structural validation is an explicit security requirement.

### C. Audit and Eliminate Implicit Context
Review every method signature and module for hidden dependencies:
- Does this function assume 0-indexed contiguous memory?
- Does it rely on a specific execution thread, system clock, or ambient locale?
- Does it assume non-nullness, specific array lengths, or particular string encodings?

---

## 3. Implementation & Algorithmic Guidelines

### A. Prefer Explicit Breadth to Compact Golfing
* **Avoid Implicit Traps:** Do not leverage language-specific side effects or obscure single-line tricks if they rely on implicit data transformations.
* **Make Extensibility Structural:** Write control flows that degrade gracefully when encountering unexpected but valid data variants.

### B. Minimize Preconditions, Maximize Post-Conditions
* **Relax Preconditions:** Allow the system to accept broad input distributions without throwing early validation faults, provided the inputs contain the required subset of information.
* **Define Deterministic Failures:** If an input falls outside the absolute minimum required set, return explicit, predictable, and weak error types rather than crashing.

---

## 4. Adversarial Auditing & Constraint Verification

Every proposed architecture, module, or PR must undergo an adversarial **Constraint Audit**. Actively attempt to break the solution's generalizability by checking for:

* **Over-Specification Risks:** Did we force an ordered array where a set or iterator suffices? Did we hardcode bit-lengths, fixed buffer sizes, or specific ASCII/Unicode bounds?
* **Child-Task Overfitting:** Is this solution specifically tuned *only* to the provided unit test cases, or does it represent the weakest valid rule that satisfies the underlying domain?
* **Hidden Coupling:** Does changing an upstream data structure break this module even if the required fields remain intact?
* **Brittle Optimizations:** Was an optimization added for syntactic brevity or localized micro-performance that drastically reduces the set of valid inputs?

---

## 5. Execution & Delivery Protocols

Do not consider a task complete based solely on passing known test suites. Deliveries must include:

1. **Constraint Audit Checklist:** Explicit proof that input types and domain logic have been relaxed to their weakest valid form.
2. **Parent Task Generalization Tests:** Automated tests demonstrating that the code handles inputs, types, and execution environments outside the original specification ($D_k \subset D_n$).
3. **Walkthrough & Justification Document (`walkthrough.md`):** Documentation detailing:
   - The minimal necessary constraints identified for the problem.
   - Over-specific designs that were rejected and why.
   - Proof that the chosen implementation maximizes extension ($|Z_h|$) over syntactic shortness.
