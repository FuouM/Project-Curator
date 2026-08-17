export type SafeHtml = string & { __html: true };

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  return String.raw(strings, ...values) as SafeHtml;
}

export const TOKENS = {
  space: { xs: "2px", sm: "4px", md: "8px", lg: "12px", xl: "16px", "2xl": "24px" },
  radius: { sm: "2px", md: "4px", lg: "8px" },
  text: { xs: "9px", sm: "11px", md: "13px", lg: "15px" },
  color: {
    accent: "var(--sys-highlight-bg)",
    danger: "#a80000",
    subtle: "var(--sys-text-subtle)",
    border: "var(--sys-border-dark)",
    surface: "var(--sys-window-bg)",
    control: "var(--sys-control-bg)",
  },
} as const;

export interface ComponentVariant {
  name: string;
  render: () => SafeHtml;
}

export interface ComponentMeta {
  name: string;
  description: string;
  variants: ComponentVariant[];
}
