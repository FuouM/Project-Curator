/**
 * Minimal typed DOM builder helpers shared by all dynasty-scans views.
 */

type Attrs = {
  class?: string;
  style?: string;
  title?: string;
  id?: string;
  type?: string;
  value?: string;
  min?: string;
  max?: string;
  placeholder?: string;
};

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === "class") node.className = v;
      else if (k === "style") node.style.cssText = v;
      else if (k === "title") node.title = v;
      else if (k === "id") node.id = v;
      else if (k === "value" && "value" in node) (node as { value: string }).value = v;
      else node.setAttribute(k, String(v));
    }
  }
  for (const child of children) {
    if (child == null) continue;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

export function text(s: string | number | null | undefined): Text {
  return document.createTextNode(s == null ? "" : String(s));
}

export function icon(className: string): HTMLElement {
  return el("i", { class: className });
}

/** WinForms-style section container: `.group-box` fieldset with a title header. */
export function group(
  titleHtml: string,
  ...children: (Node | string | null | undefined)[]
): HTMLElement {
  const box = el("div", { class: "group-box" });
  const head = el("div", { class: "group-box-title" });
  head.innerHTML = titleHtml;
  box.appendChild(head);
  for (const child of children) {
    if (child == null) continue;
    box.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return box;
}
