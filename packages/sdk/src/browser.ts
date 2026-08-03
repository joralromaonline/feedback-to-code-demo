import type { SelectedElement } from "../../domain/src/index.ts";

export function normalizeText(value: string | null | undefined, max = 300): string | undefined {
  const normalized = (value || "").replace(/\s+/g, " ").trim();
  return normalized ? normalized.slice(0, max) : undefined;
}

export function redactText(value: string | null | undefined, selectors: string[] = ["input", "textarea", "[data-feedback-redact]", "[data-sensitive]"]): string | undefined {
  if (!value) return undefined;
  let output = value;
  for (const selector of selectors) {
    if (selector === "input" || selector === "textarea" || selector.includes("sensitive") || selector.includes("redact")) {
      output = "[REDACTED]";
    }
  }
  return normalizeText(output);
}

function cssPath(element: Element): string {
  const pieces: string[] = [];
  let current: Element | null = element;
  while (current && current.nodeType === 1 && pieces.length < 6) {
    const tag = current.tagName.toLowerCase();
    const id = current.getAttribute("id");
    if (id) {
      pieces.unshift(`${tag}#${CSS.escape(id)}`);
      break;
    }
    const parentElement: Element | null = current.parentElement;
    const siblings: Element[] = parentElement ? (Array.from(parentElement.children) as Element[]).filter((child: Element) => child.tagName === current?.tagName) : [];
    const index = siblings.indexOf(current) + 1;
    pieces.unshift(`${tag}:nth-of-type(${Math.max(index, 1)})`);
    current = parentElement;
  }
  return pieces.join(" > ");
}

export function selectElementSnapshot(element: Element): SelectedElement | null {
  if (element.closest("[data-feedback-ignore]")) return null;
  const rect = element.getBoundingClientRect();
  const attributes: Record<string, string> = {};
  for (const attribute of Array.from(element.attributes).slice(0, 32)) {
    if (attribute.name === "value" || attribute.name === "placeholder") continue;
    attributes[attribute.name] = attribute.value.slice(0, 300);
  }
  const ancestors: Array<{ tagName: string; role?: string; testId?: string }> = [];
  let ancestor = element.parentElement;
  while (ancestor && ancestors.length < 6) {
    if (!ancestor.hasAttribute("data-feedback-ignore")) {
      ancestors.push({
        tagName: ancestor.tagName.toLowerCase(),
        role: ancestor.getAttribute("role") || undefined,
        testId: ancestor.getAttribute("data-testid") || undefined
      });
    }
    ancestor = ancestor.parentElement;
  }
  const selected: SelectedElement = {
    tagName: element.tagName.toLowerCase(),
    role: element.getAttribute("role") || undefined,
    accessibleName: element.getAttribute("aria-label") || normalizeText(element.textContent),
    textPreview: element.matches("input, textarea, [data-sensitive]") ? "[REDACTED]" : redactText(element.textContent),
    attributes,
    testId: element.getAttribute("data-testid") || undefined,
    feedbackId: element.getAttribute("data-feedback-id") || undefined,
    cssPath: cssPath(element),
    boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    ancestorSummary: ancestors
  };
  return selected;
}

export type FeedbackUiState = "idle" | "selecting" | "composing" | "capturing" | "submitted" | "error";

export interface FeedbackControllerOptions {
  enabled: boolean;
  onSelect: (element: Element) => void;
  onStateChange?: (state: FeedbackUiState) => void;
}

/** Minimal DOM controller. It is constructed only in the browser, so SSR never touches window/document. */
export class FeedbackController {
  private state: FeedbackUiState = "idle";
  private button?: HTMLButtonElement;
  private options: FeedbackControllerOptions;
  private keydownHandler?: (event: KeyboardEvent) => void;
  private selectionCleanup?: () => void;
  private highlighted?: { element: HTMLElement; outline: string; outlineOffset: string };

  constructor(options: FeedbackControllerOptions) {
    this.options = options;
  }

  mount(): void {
    if (!this.options.enabled || typeof document === "undefined") return;
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Feedback";
    button.setAttribute("aria-label", "Activar modo de feedback");
    button.dataset.feedbackIgnore = "true";
    button.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:8px 12px;border-radius:999px;border:1px solid #334155;background:#0f172a;color:white;cursor:pointer";
    button.addEventListener("click", () => this.startSelecting());
    document.body.appendChild(button);
    this.button = button;
    this.keydownHandler = (event) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        this.startSelecting();
      }
    };
    document.addEventListener("keydown", this.keydownHandler);
  }

  unmount(): void {
    this.selectionCleanup?.();
    if (this.keydownHandler && typeof document !== "undefined") document.removeEventListener("keydown", this.keydownHandler);
    this.button?.remove();
    this.button = undefined;
  }

  getState(): FeedbackUiState {
    return this.state;
  }

  startSelecting(): void {
    if (typeof document === "undefined") return;
    this.selectionCleanup?.();
    this.setState("selecting");
    const restoreHighlight = () => {
      if (!this.highlighted) return;
      this.highlighted.element.style.outline = this.highlighted.outline;
      this.highlighted.element.style.outlineOffset = this.highlighted.outlineOffset;
      this.highlighted = undefined;
    };
    const moveHandler = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest("[data-feedback-ignore]")) {
        restoreHighlight();
        return;
      }
      restoreHighlight();
      this.highlighted = { element: target, outline: target.style.outline, outlineOffset: target.style.outlineOffset };
      target.style.outline = "2px solid #38bdf8";
      target.style.outlineOffset = "2px";
    };
    const clickHandler = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.closest("[data-feedback-ignore]")) return;
      event.preventDefault();
      event.stopPropagation();
      this.selectionCleanup?.();
      this.setState("composing");
      this.options.onSelect(target);
    };
    const escapeHandler = (event: KeyboardEvent) => {
      if (event.key === "Escape") this.cancelSelecting();
    };
    this.selectionCleanup = () => {
      document.removeEventListener("mousemove", moveHandler, true);
      document.removeEventListener("click", clickHandler, true);
      document.removeEventListener("keydown", escapeHandler, true);
      restoreHighlight();
      this.selectionCleanup = undefined;
    };
    document.addEventListener("mousemove", moveHandler, true);
    document.addEventListener("click", clickHandler, true);
    document.addEventListener("keydown", escapeHandler, true);
  }

  cancelSelecting(): void {
    this.selectionCleanup?.();
    this.setState("idle");
  }

  markSubmitted(): void { this.setState("submitted"); }
  markError(): void { this.setState("error"); }

  private setState(state: FeedbackUiState): void {
    this.state = state;
    this.options.onStateChange?.(state);
  }
}
