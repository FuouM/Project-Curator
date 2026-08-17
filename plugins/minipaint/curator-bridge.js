/* curator-bridge.js — injected into the extracted miniPaint v4.14.3 editor
 *
 * Runs INSIDE the editor iframe (origin http://asset.localhost/...), where
 * window.FileSave / window.FileOpen are globals. It patches the save/export
 * hook and relays raw bytes to the dashboard via postMessage — the only
 * cross-origin channel that works here.
 *
 * Intercepted formats: PNG / JPG / WEBP / BMP / GIF / JSON (exported as raw
 * bytes straight into a user-chosen folder). TIFF / AVIF fall through to the
 * original save_action by design (see implementation plan §8.2).
 *
 * GIF uses the extracted gif.js encoder (editor/src/js/libs/gifjs/gif.js, a UMD
 * that exposes window.GIF) with the same options upstream save.js uses, but the
 * finished Blob is routed through postRaw instead of FileSaver's saveAs — which
 * triggers a browser download prompt that does nothing inside a Tauri WebView2
 * iframe.
 *
 * Console errors from miniPaint's own code are forwarded to the host as
 * `minipaint:console-error` so they surface in the dashboard instead of dying
 * in the invisible iframe console.
 *
 * PINNED TO v4.14.3 — the canvas-building blocks below duplicate upstream
 * src/js/modules/file/save.js save_action() internals. The installer refuses
 * to run if dist/bundle.js does not hash-match, and the runtime block below
 * fails loud (never silent) if any hook is missing. See plan §8.1.
 */
(function () {
  "use strict";

  // miniPaint is a pixel-manipulation app: filters, blend modes, and layer
  // compositing call getImageData constantly. WebView2 warns "Multiple readback
  // operations using getImageData are faster with the willReadFrequently
  // attribute" when such readbacks hit a context that keeps a GPU-backed
  // surface — each call then forces a slow GPU→CPU copy and the editor lags.
  // Patch getContext so every "2d" context is created with the flag set.
  // This runs before miniPaint's window.load init (the bridge tag is injected
  // right before </body>), so it covers every canvas the app creates.
  (function patchCanvasContexts() {
    var origGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type) {
      var args = arguments;
      if (type === "2d") {
        if (args.length > 1 && args[1] && typeof args[1] === "object") {
          if (!("willReadFrequently" in args[1])) {
            args = [type, Object.assign({ willReadFrequently: true }, args[1])];
          }
        } else {
          args = [type, { willReadFrequently: true }];
        }
      }
      return origGetContext.apply(this, args);
    };
  })();

  function postRaw(type, payload, bytes) {
    // Transfer the ArrayBuffer into the host frame (zero-copy, no base64).
    // The buffer MUST be attached to the message as a property AND listed in
    // the transfer list — listing it only in the transfer list detaches it on
    // the sender side while the receiver never receives a reference to it.
    try {
      window.parent.postMessage(Object.assign({ type: type, buffer: bytes }, payload), "*", [
        bytes,
      ]);
    } catch (e) {
      console.error("[curator-bridge] postMessage failed", e);
    }
  }

  function post(type, payload) {
    try {
      window.parent.postMessage(Object.assign({ type: type }, payload), "*");
    } catch (e) {
      console.error("[curator-bridge] postMessage failed", e);
    }
  }

  function reportError(message, detail) {
    try {
      window.parent.postMessage(
        {
          type: "minipaint:console-error",
          message: String(message),
          detail: detail ? String(detail) : "",
        },
        "*",
      );
    } catch (e) {
      /* host unreachable */
    }
  }

  // Forward every uncaught exception / rejection in the editor iframe to the
  // host so failures are visible in the dashboard instead of the hidden
  // iframe console.
  window.addEventListener("error", function (ev) {
    var detail = ev.error && ev.error.stack ? ev.error.stack : ev.filename + ":" + ev.lineno;
    reportError(ev.message || "Uncaught error", detail);
  });
  window.addEventListener("unhandledrejection", function (ev) {
    var r = ev.reason;
    reportError("Unhandled promise rejection", r && r.stack ? r.stack : String(r));
  });

  function waitForGlobal(key, cb) {
    if (window[key]) {
      cb(window[key]);
      return;
    }
    var tries = 0;
    var iv = setInterval(function () {
      tries += 1;
      if (window[key]) {
        clearInterval(iv);
        cb(window[key]);
      } else if (tries > 200) {
        clearInterval(iv);
        reportError("[curator-bridge] " + key + " never appeared");
      }
    }, 50);
  }

  function blobToBytes(blob, cb) {
    blob.arrayBuffer().then(
      function (buf) {
        cb(buf);
      },
      function (e) {
        reportError("blob.arrayBuffer failed", e);
        cb(null);
      },
    );
  }

  function getGifEncoder(cb) {
    if (window.GIF) {
      cb(window.GIF);
      return;
    }
    var tries = 0;
    var iv = setInterval(function () {
      tries += 1;
      if (window.GIF) {
        clearInterval(iv);
        cb(window.GIF);
      } else if (tries > 100) {
        clearInterval(iv);
        reportError("GIF encoder (gif.js) failed to load");
        cb(null);
      }
    }, 50);
  }

  // Load the extracted gif.js (UMD → window.GIF) early so the GIF export path
  // is ready when the user triggers it.
  (function loadGifJs() {
    if (window.GIF) return;
    var s = document.createElement("script");
    s.src = "./src/js/libs/gifjs/gif.js";
    s.onerror = function () {
      reportError("failed to load gif.js from editor assets");
    };
    document.head.appendChild(s);
  })();

  waitForGlobal("FileSave", function (FileSave) {
    var original = FileSave.save_action.bind(FileSave);

    FileSave.save_action = function (user_response, autoname) {
      var type = String(user_response.type).split(" ")[0];

      if (type === "JSON") {
        var dataJson;
        try {
          dataJson = this.export_as_json();
        } catch (e) {
          reportError("export_as_json failed", e);
          dataJson = null;
        }
        if (dataJson != null) {
          var enc = new TextEncoder();
          postRaw(
            "minipaint:save",
            { format: "json", name: user_response.name },
            enc.encode(dataJson).buffer,
          );
        }
        return;
      }

      if (["PNG", "JPG", "WEBP", "BMP"].indexOf(type) !== -1) {
        var quality = parseInt(user_response.quality, 10) || 90;
        if (quality > 100 || quality < 1) quality = 90;
        quality = quality / 100;

        // Fail-loud precondition check (§8.1): the block below reads upstream
        // internals that are pinned to v4.14.3. If any hook is missing/renamed,
        // refuse the export rather than silently producing wrong pixels.
        var Cfg = window.AppConfig;
        if (
          !this.Base_layers ||
          !this.Base_layers.convert_layers_to_canvas ||
          !this.Base_layers.convert_layer_to_canvas ||
          !this.fillCanvasBackground ||
          !Cfg ||
          typeof Cfg.WIDTH !== "number"
        ) {
          post("minipaint:save-error", {
            message: "miniPaint internals changed; the Curator save bridge needs a re-audit.",
          });
          return;
        }

        // Replicate the original canvas build (keep in sync with upstream save.js):
        var canvas, ctx;
        if (user_response.layers === "Selected" && type !== "GIF") {
          canvas = this.Base_layers.convert_layer_to_canvas();
          ctx = canvas.getContext("2d");
        } else {
          canvas = document.createElement("canvas");
          ctx = canvas.getContext("2d");
          canvas.width = Cfg.WIDTH;
          canvas.height = Cfg.HEIGHT;
          if (this.disable_canvas_smooth) this.disable_canvas_smooth(ctx);
          this.Base_layers.convert_layers_to_canvas(ctx, null, false);
        }

        if (type === "JPG" || Cfg.TRANSPARENCY === false) {
          ctx.globalCompositeOperation = "destination-over";
          this.fillCanvasBackground(ctx, "#ffffff");
          ctx.globalCompositeOperation = "source-over";
        }

        var mime = type === "JPG" ? "image/jpeg" : "image/" + type.toLowerCase();
        canvas.toBlob(
          function (blob) {
            if (!blob) {
              post("minipaint:save-error", { message: "toBlob returned null" });
              return;
            }
            blobToBytes(blob, function (buf) {
              if (!buf) {
                post("minipaint:save-error", { message: "blob.arrayBuffer failed" });
                return;
              }
              postRaw(
                "minipaint:save",
                { format: type.toLowerCase(), name: user_response.name },
                buf,
              );
            });
          },
          mime,
          quality,
        );
        return;
      }

      // GIF: replicate upstream save.js GIF branch, but route the finished
      // Blob through the Curator save command instead of FileSaver saveAs.
      if (type === "GIF") {
        var CfgGif = window.AppConfig;
        // Upstream reads o.A.layers / o.A.layer where o.A IS the AppConfig
        // singleton (webpack module 3387) — NOT window.Layers (the Layers
        // class instance, which holds no .layers array of its own).
        if (
          !CfgGif ||
          typeof CfgGif.WIDTH !== "number" ||
          !this.Base_layers ||
          !this.Base_layers.convert_layers_to_canvas ||
          !this.fillCanvasBackground
        ) {
          post("minipaint:save-error", {
            message: "miniPaint internals changed; the GIF save bridge needs a re-audit.",
          });
          return;
        }
        var delay = parseInt(user_response.delay, 10);
        if (isNaN(delay) || delay < 0) delay = 400;

        getGifEncoder(
          function (GifCtor) {
            if (!GifCtor) {
              post("minipaint:save-error", { message: "GIF encoder failed to load" });
              return;
            }

            var opts = {
              workers: navigator.hardwareConcurrency || 4,
              quality: 10,
              repeat: 0,
              width: CfgGif.WIDTH,
              height: CfgGif.HEIGHT,
              dither: "FloydSteinberg-serpentine",
              workerScript: "./src/js/libs/gifjs/gif.worker.js",
            };
            if (CfgGif.TRANSPARENCY === true) opts.transparent = "rgba(0,0,0,0)";

            var encoder = new GifCtor(opts);
            var canvas = document.createElement("canvas");
            var ctx = canvas.getContext("2d");
            canvas.width = CfgGif.WIDTH;
            canvas.height = CfgGif.HEIGHT;
            if (this.disable_canvas_smooth) this.disable_canvas_smooth(ctx);

            var layers = CfgGif.layers || [];
            for (var u = 0; u < layers.length; u++) {
              if (!layers[u].visible) continue;
              ctx.clearRect(0, 0, CfgGif.WIDTH, CfgGif.HEIGHT);
              if (CfgGif.TRANSPARENCY !== true) this.fillCanvasBackground(ctx, "#ffffff");
              this.Base_layers.convert_layers_to_canvas(ctx, layers[u].id, false);
              encoder.addFrame(ctx, { copy: true, delay: delay });
            }
            if (layers.length === 0) {
              post("minipaint:save-error", { message: "no visible layers to encode as GIF" });
              return;
            }

            encoder.render();
            encoder.on("finished", function (blob) {
              if (!blob) {
                post("minipaint:save-error", { message: "GIF encoder returned null" });
                return;
              }
              blobToBytes(blob, function (buf) {
                if (!buf) {
                  post("minipaint:save-error", { message: "GIF blob.arrayBuffer failed" });
                  return;
                }
                postRaw("minipaint:save", { format: "gif", name: user_response.name }, buf);
              });
            });
          }.bind(this),
        );
        return;
      }

      // TIFF / AVIF: hand back to upstream behavior.
      return original(user_response, autoname);
    };
  });

  // Load images pushed from the host. The listener is attached IMMEDIATELY at
  // parse time (not inside waitForGlobal): miniPaint assigns window.FileOpen
  // only inside its window.load init, which races with the host posting
  // `minipaint:load-image` on the iframe's load event. A timer-polled listener
  // would register one macrotask too late and silently drop the first
  // "Send to Editor" image on a cold mount. FileOpen is resolved on demand, so
  // the already-loaded case (FileOpen ready instantly) works identically.
  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "minipaint:load-image" && d.url) {
      waitForGlobal("FileOpen", function (FileOpen) {
        try {
          FileOpen.open_resource(d.url);
        } catch (e) {
          reportError("open_resource failed", e);
        }
      });
    }
  });

  window.addEventListener("message", function (ev) {
    var d = ev.data;
    if (!d || typeof d !== "object") return;
    if (d.type === "minipaint:save-result" && window.alertify) {
      if (d.ok) window.alertify.success("Saved to Curator: " + d.path);
      else window.alertify.error("Save failed: " + (d.error || "unknown error"));
    }
  });
})();
