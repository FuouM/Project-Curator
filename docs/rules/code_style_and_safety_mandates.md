# Code Style, Safety & Engineering Mandates

All AI agents and developers operating in this repository must strictly adhere to these guidelines.

---

## 1. No Absolute Paths

**NEVER** write or commit absolute file paths (`C:\...`, `file:///...`, `K:\...`). Always use repository-relative paths and portable environment resolution:

- **JavaScript/Frontend**: Always use relative paths (`plugins/gif-maker/...` or `.curator/...`) for assets resolved by `convertFileSrc`. Do not write system path fallbacks like `"C:\\Windows\\Temp"` or invoke server-side APIs (like `std.env.temp_dir`) in frontend JS contexts.
- **Rust/Backend**: For OS system paths (e.g. system fonts), dynamically query environment variables such as `std::env::var("WINDIR")` instead of hardcoding absolute system paths.

---

## 2. NO Fallbacks / Feature Removal Policy

**NEVER** implement silent fallbacks, comment out broken logic, or strip out features (such as `sccache`, test suites, or performance configurations) simply to bypass or dodge an error. When an error or warning occurs, diagnose and fix the root cause properly. Fail fast, preserve required tooling, and expose underlying issues cleanly.

---

## 3. First-Principles Model Verification

Before modifying inference logic, create or run standalone programmatic test binaries to verify ONNX model initialization and tensor shapes step-by-step. ONNX/ORT verification binaries live in `curator-ml/src/bin/` (e.g., `test_ort_wd_tagger.rs`); core aggregation/pipeline verification binaries live in `curator-core/src/bin/` (e.g., `test_system_nodes.rs`).

---

## 4. Filesystem Safety & Preservation Mandate

- **Deletion Banned:** **NEVER** delete files using `Remove-Item`, `git rm`, `rm`, or `Remove-Item -Force`.
- **Deprecation Protocol:** Any file, document, plan (`PLAN_*.md`), or component designated for removal **must** be moved into a `.deprecated/` folder instead of being deleted.
- **Binary Preservation:** Preserve binary runtime dependencies (`.dll`, `.lib`, `.onnx`) in isolated directories (`.curator_ort_dlls_backup/`). Do not clean or wipe them.

---

## 5. Git Workflows & Commit Guidelines

- **No Automated Commits:** **NEVER** run `git commit` or `git push` unless the user explicitly requests it in the *current turn's conversation*. Do not assume a prior commit request applies to subsequent changes, and never preemptively commit new edits.
- **Verify Diff Before Committing:** When requested to commit, **always** run and inspect `git diff` first to verify the exact changes. This ensures you do not stage unintended modifications or accidentally overwrite the work of other concurrent agents operating outside of your context.
- **No Wildcard Staging:** Do not run `git add .` or `git add -A`. Explicitly stage target files by path.
- **No Plan File Commits:** **NEVER** stage or commit implementation plan documents (`implementation_plan*.md`, `PLAN_*.md`, or scratch design notes) to Git history. Plans are temporary workspace coordination documents. Always exclude plan files when staging changes for a commit.
- **Respect .gitignore & Deprecated Directories:** **NEVER** stage or force-add files inside `.deprecated/`, `.curator/`, or any directory listed in `.gitignore`. `.deprecated/` exists strictly for local file preservation on disk.
- **No Automatic Pushing:** **NEVER** run `git push` on any branch (including `main`) unless the user explicitly requests a push operation in the *current turn's conversation*. Even when instructed to merge or commit to `main`, do not automatically push the branch unless the push itself is explicitly requested.
- **Commit Message Format:** Summarize changes with a semantic title (`type: description`), followed by detailed bullet points documenting specific file modifications.

---

## 6. No Lazy Implementations / Strict Analytical Grounding

- **NEVER** use hardcoded approximations, generic magic numbers, or static defaults (such as a hardcoded frame rate fallback or dummy overhead percentage) when the actual parameters can be probed or calculated.
- Refactor resource pipelines to fetch required metadata once at logical boundaries. Avoid duplicate process spawning (e.g. running multiple `ffprobe` operations on the same asset).
- Derive calculations, allocations, and constraints mathematically from format specifications, track counts, and duration metrics.
- **Self-Adversarial Verification:** Before finalizing any task, the agent must perform an explicit meta-cognitive self-audit. Inspect your own implementation plan and output code for hidden laziness, magic safety numbers, or unresolved assumptions. Force yourself to outline and justify these decisions, and refactor any shortcut into a mathematically sound, first-principles solution.

---

## 7. Research Before Attempting / No Blind Command Loops

- **NEVER** attempt more than 2 variations of the same failing command without first stopping to research why it is failing. Repeating the same command with minor flag changes is not debugging — it is noise.
- When a command, tool, or library fails in an unexpected or persistent way, **immediately use `search_web`** to determine whether the failure is caused by a version limitation, a known bug, or a fundamental capability gap — before writing any code or running any more commands.
- **Version limitations are blockers, not configuration problems.** If a tool version does not support a feature (e.g., FFmpeg < 9.0 cannot decode animated WebPs), no amount of flag tweaking will fix it. Identify the version requirement first, then escalate to updating the tool or choosing an alternative approach.
- When a tool needs to be updated to resolve a capability gap, do it — do not loop on workarounds that cannot work.

---

## 8. Root Implementation Plans Mandate

- **Root Plan Priority**: If an implementation plan document (e.g., `implementation_plan_modularization.md`, `implementation_plan.md`, or `PLAN_*.md`) exists in the repository root directory, AI agents **MUST** read, use, and update that root file directly in the workspace directory.
- **No Local Directory Redirection**: **NEVER** write or redirect implementation plans exclusively to internal/local brain artifact directories when a plan file exists in the repository root directory. Always update the repository root plan file directly so all agents and developers share the exact same authoritative document.
- **Mandatory Ultra-Fine Detail**: Implementation plans **MUST** be written with ultra-fine, granular, production-ready specifications. They must detail exact function signatures, interface boundaries, file structures, and line-by-line block transformations. Lazy summaries or high-level placeholders are strictly banned.

---

## 9. System Architecture Conformity Mandate

- **No Inventing Isolated Parallel Solutions:** AI agents **MUST** inspect and conform strictly to the existing codebase architecture and contract specifications (`curator-proto/proto/*.proto`, `ModelsService` in `models.proto`, `ModelsService` / `models.json` manifest, `BenchmarksService` in `benchmarks.proto`, `ManagedSession` in `curator-ml`, etc.).
- **Mandatory System Exploration:** Before proposing or drafting implementation plans for new features (such as ML models, benchmarks, settings, downloads, or background tasks), agents **MUST** thoroughly inspect the project's existing domain Protobuf files, gRPC services, and manager classes to integrate seamlessly into existing systems rather than inventing ad-hoc or parallel workflows.

---

## 10. Strict User Request Alignment & Anti-Bypass Mandate

- **Targeted Debugging:** When the user requests testing, debugging, or fixing a specific feature or UI flow (such as downloading a model via the UI Models tab), AI agents **MUST** trace and fix the actual end-to-end system pipeline (e.g. manifest URLs, network handlers, IPC bridge routing, background tasks).
- **Bypasses & Shortcuts Strictly Banned:** **NEVER** bypass or fake a broken feature by copying files locally on disk, hardcoding dummy fallbacks, or faking state behind the user's back to superficially "make it work". Always fix the true underlying system logic.

---

## 11. No Silent Failures & Relevant Command Execution Mandate

- **Mandatory Error Logging & Visual Error Banners:** Every failure path in background tasks (network downloads, conversions, IPC handlers) **MUST** log an explicit `tracing::error!` / `console.error` log entry and present a clear, human-readable error banner in the UI. Silent failures, swallowed exceptions, or unhandled status states are strictly forbidden.
- **No Irrelevant Build/Test Execution:** AI agents **MUST NOT** execute workspace-wide build (`cargo check`) or test commands when performing localized fixes (such as UI HTML/CSS tweaks, manifest JSON updates, or isolated helper adjustments) where full workspace compilation is completely irrelevant.

---

## 12. Deterministic Dependency Capture & Anti-Guesswork Mandate

- **No Manual Package Lists:** AI agents **MUST NEVER** manually type out, guess, or approximate package dependency lists in environment files (`requirements.txt`, `Cargo.toml`, `package.json`).
- **Mandatory Native Environment Dumps:** When updating environment specification files, AI agents **MUST** execute native environment dumping commands (`pip freeze`, `cargo tree`, `npm ls`) directly into the target specification file to guarantee 100% exact, repeatable, and non-hallucinated environment definitions.

---

## 13. Strict Scope Discipline & Zero Unrequested Features Mandate

- **No Scope Creep:** AI agents **MUST ONLY** build, modify, or extend what the user explicitly requested.
- **No Inventing Variants or Modes:** Do NOT add extra quantization modes, formats, unrequested script options, or extraneous variants simply because files or examples exist in reference directories. Check the manifest files (`model_manifest.json`) and stick strictly to the user's prompt.

---

## 14. No Temporary Fixes & Real Solutions Mandate

- **Temporary Band-Aids Banned:** **NEVER** write quick-and-dirty band-aids, temporary fallback hacks, variable-suffix workarounds (e.g. `fp16_1`, `temp_path`, `path_v2`), or partial fixes to dodge an error.
- **Mandatory First-Principles Solutions:** Always diagnose the root cause, refactor existing logic cleanly, and implement robust, production-grade, long-term architectural solutions.

---

## 15. No Excuses & No False Assumptions Mandate

- **No False Assumptions:** **NEVER** make assumptions, invent excuses, or blame old binary/process state when an error occurs.
- **Mandatory Analytical Diagnosis:** When an error or unexpected output is reported by the user, **immediately inspect the exact source code logic and type signatures** from first principles to locate and resolve the true root cause.

---

## 16. Mandatory Action First & Zero Explanatory Procrastination Mandate

- **Apply Code Fixes Before Responding:** When a bug, failure, root cause, or missing configuration is identified, AI agents **MUST** execute the code modifications in the files FIRST before sending any response text to the user.
- **No Prose Without Action:** Sending a response that merely explains a solution or root cause without having already executed the code fix in the workspace is strictly forbidden. Explanations may only be provided after the fix has been applied.
