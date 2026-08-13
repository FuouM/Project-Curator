# Plugin UI & Native Tauri v2 Event Integration

All plugin interfaces **must strictly adhere to the WinForms Desktop Control Mandate** (see [`docs/rules/data_integrity_and_design_system.md`](../rules/data_integrity_and_design_system.md)).

---

## 1. Strict Design Rules

1. **Zero Web Abstractions**:
   - **NEVER** use flashy gradients (`linear-gradient`), neon glows (`box-shadow: 0 0 10px...`), floating rounded web cards, or radial background blobs.
   - **NEVER** override system window backgrounds with ad-hoc colors when displaying empty state containers.
2. **Official Bootstrap Icons Exclusively**:
   - **NO Unicode Emojis** (`✨`, `●`, `▶`, `📁`).
   - **ALWAYS** use official Bootstrap Icon markup (`<i class="bi bi-folder2-open"></i>`, `<i class="bi bi-stars"></i>`).
3. **Native Control Classes**:
   - Buttons: `.win-button`, `.win-button.primary`, `.win-button.danger`.
   - Group Boxes: Native fieldset grouping containers with titles:

     ```html
     <div class="group-box">
       <div class="group-box-title">Section Title</div>
       <!-- Content -->
     </div>
     ```

   - Tag Pills: Standard rank taxonomy classes: `.tag-pill.custom-concept` (Custom Concept), `.tag-pill.tag-character` (Character), `.tag-pill.tag-copyright` (Copyright), `.tag-pill.tag-meta` (Meta).
4. **App Drop Zones**:
   - Use native `.toolbox-drop-zone`, `.toolbox-drop-icon`, and `.toolbox-drop-active` classes directly from `layout.css`.

---

## 2. Native Tauri v2 Drag & Drop Integration

Standard HTML5 drag-and-drop `e.dataTransfer.files` can be suppressed by Windows WebView2 security policies. Plugins **must** integrate Tauri v2's native window drop events.

### Recommended Native Drop Listener Template

```javascript
function setupNativeTauriDropZone(canvasArea, onFilesDropped) {
  var api = window.__TAURI__;
  if (!api || !api.webview || !api.webview.getCurrentWebview) return;

  api.webview.getCurrentWebview().onDragDropEvent(function (event) {
    // Only handle drops when plugin view is active
    var tabActive = document.getElementById("view-extensions-my-plugin-id");
    if (!tabActive || !tabActive.classList.contains("active")) return;

    var drop = event.payload;
    var dropZones = document.querySelectorAll(".toolbox-drop-zone");

    // Device Pixel Ratio Hit-Testing
    var getHitDropZone = function () {
      var pos = drop.position;
      if (!pos || typeof pos.x !== "number") return null;
      var cx = pos.x / window.devicePixelRatio;
      var cy = pos.y / window.devicePixelRatio;
      var hit = document.elementFromPoint(cx, cy);
      return hit ? hit.closest(".toolbox-drop-zone") : null;
    };

    var activeZone = getHitDropZone();

    if (drop.type === "enter" || drop.type === "over") {
      dropZones.forEach(function (dz) {
        if (dz === activeZone) dz.classList.add("toolbox-drop-active");
        else dz.classList.remove("toolbox-drop-active");
      });
    } else if (drop.type === "leave" || drop.type === "drop") {
      dropZones.forEach(function (dz) {
        dz.classList.remove("toolbox-drop-active");
      });
    }

    if (drop.type === "drop" && drop.paths && drop.paths.length > 0) {
      onFilesDropped(drop.paths, activeZone);
    }
  });
}
```
