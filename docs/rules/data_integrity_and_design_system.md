# Data Integrity, Database & Design System Guidelines

## 1. Data Integrity & Database Mandates

1. **Database Schema & Migrations:**
   - **Never** perform ad-hoc SQL modifications or direct index additions on development databases.
   - All schema updates, new tables, and performance indexes **must** be committed as structured SQL files inside `curator-db/migrations/` (e.g., `0021_feature_name.sql`).

2. **Query Performance Verification:**
   - Always execute `EXPLAIN QUERY PLAN` on SQLite queries before finalizing refactors to verify index usage and eliminate full table scans or temporary B-trees.

3. **Vector vs. Tag Integrity:**
   - Dynamic vector similarity searches must operate purely in-memory/vector-index and **never** write auto-tags into the `image_tags` table.
   - Teaching a concept or providing training samples **only** tags explicitly selected ground-truth assets.
   - Deleting a custom concept tag must execute a clean row deletion and **never** convert user tags into AI exclusions/blacklists.

---

## 2. UI & Design System Guidelines (WinForms Desktop Control Aesthetic)

The dashboard strictly follows a modern, dark-mode **WinForms Desktop Control** aesthetic.

### Strict Design System Rules

- **Zero Web Abstractions:** **NEVER** use flashy gradients (`linear-gradient`), neon glow effects (`box-shadow: 0 0 10px...`), floating rounded web cards, or radial background blobs.
- **Icon System:** **NO Unicode Emojis** (`✨`, `●`, `▶`). **ALWAYS** use official Bootstrap Icon classes (`<i class="bi bi-stars"></i>`, `<i class="bi bi-check-lg"></i>`).
- **WinForms Layout Containers:** Section groupings must use native `.group-box` fieldset containers:

  ```html
  <div class="group-box">
    <div class="group-box-title">Section Title</div>
    <!-- Content -->
  </div>
  ```

- **Tag Taxonomy Color Mapping:**
  - Custom Concepts: `#cce5ff` background, `#b8daff` border, `#004085` text (`.tag-pill.custom-concept`).
  - Standard Tags: `#fff3cd` (`user`), `#d1ecf1` (`character`), `#ebdcf9` (`copyright`), `#e2e3e5` (`meta`).
- **Lazy DOM Rendering:** Display structural skeleton layout outlines immediately upon rendering tabs or complex view components. Defer secondary details queries and crop generation tasks using microtask delays (`setTimeout(..., 50)`) to avoid freezing the UI thread.
- **Component Sheet Reference:** Inspect the **Component Showcase Sheet view** (`index.html` -> `#view-components`) and `src/components.ts` before creating or modifying UI components.
- **Layout Stretching & Centering**: Flex-child components like `.toolbox-drop-zone` must specify `align-self: stretch; width: 100%; height: 100%` when nested within centered container layouts (e.g. `align-items: center`), preventing them from collapsing to the width of their inner text.
- **Pointer Events on Interactive Media**: When rendering media elements with browser controls (such as `<video controls>`), ensure they are not blocked by overlay containers or blanket parent classes; set `pointer-events: auto;` specifically on interactive media elements so seeking and playback work normally.

### Frontend Design Skill (`/frontend-design`) Integration

- **Intentionality & Restraint**: Avoid generic AI-generated defaults (e.g. random gradients, acid-green highlights, cream backgrounds, scattered web effects). Spend boldness in one deliberate place and keep surrounding elements quiet, disciplined, and cohesive.
- **Subject-Grounded Interface**: Ground every design decision in the real product context—a high-performance local AI image curation engine. Every container, label, divider, and control must serve a clear purpose.
- **Consistent UX Vocabulary**: Use plain, active-voice verbs ("Save changes", "Teach Concept", "Rescan Library"). Keep terminology consistent through all UI flows and notifications.
- **Design System Token Integrity**: Derive every color, padding, and font decision directly from the project's native Modern WinForms desktop token system (`styles.css` & `components.ts`).

### Language-Specific Code Rules

- **Rust**:
  - Follow Rust 2021 edition idioms.
  - Use `clippy.toml` and `rustfmt.toml` configurations.
  - Prefer explicit, non-blocking asynchronous processing for heavy IO/inference pipelines using `tokio`.
- **TypeScript / CSS**:
  - Keep components modular and single-purpose.
  - Use CSS variables and dark-mode high-contrast UI design system tokens.
  - Ensure user feedback indicators (copy status, star toggle, search loaders) are explicitly updated and reactive.
