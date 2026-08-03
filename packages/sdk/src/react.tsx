"use client";

import { createElement, Fragment, useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from "react";
import { FeedbackController, selectElementSnapshot, type FeedbackUiState } from "./browser.ts";
import { submitFeedback, type FeedbackClientConfig, type FeedbackDraft } from "./index.ts";
import type { SelectedElement } from "../../domain/src/index.ts";

export interface FeedbackProviderProps {
  children: ReactNode;
  projectKey: string;
  apiUrl: string;
  environment: "development" | "staging";
  enabled: boolean;
  appRevision?: string;
  shortcut?: boolean;
  redactSelectors?: string[];
  onSubmitted?: (result: { feedbackId: string; requestId: string }) => void;
}

const DEFAULT_REDACT_SELECTORS = ["input", "textarea", "[data-feedback-redact]", "[data-sensitive]"];

function browserDraftKey(projectKey: string): string { return `feedback-code:draft:${projectKey}`; }

async function captureViewport(selectedElement: Element, redactSelectors: string[]): Promise<{ mimeType: "image/webp"; base64: string } | undefined> {
  type Html2Canvas = (element: HTMLElement, options?: Partial<import("html2canvas").Options>) => Promise<HTMLCanvasElement>;
  const html2canvas = (await import("html2canvas")).default as unknown as Html2Canvas;
  const rectangle = selectedElement.getBoundingClientRect();
  const highlight = document.createElement("div");
  highlight.dataset.feedbackCaptureHighlight = "true";
  highlight.style.cssText = `position:fixed;left:${rectangle.left}px;top:${rectangle.top}px;width:${rectangle.width}px;height:${rectangle.height}px;border:3px solid #38bdf8;border-radius:6px;box-sizing:border-box;pointer-events:none;z-index:2147483645`;
  document.body.appendChild(highlight);
  try {
    const canvas = await html2canvas(document.body, {
      backgroundColor: null,
      useCORS: true,
      logging: false,
      scale: Math.min(window.devicePixelRatio || 1, 2),
      width: window.innerWidth,
      height: window.innerHeight,
      x: window.scrollX,
      y: window.scrollY,
      ignoreElements: (element) => element.hasAttribute("data-feedback-ignore"),
      onclone: (clonedDocument) => {
        for (const selector of redactSelectors) {
          for (const element of Array.from(clonedDocument.querySelectorAll(selector))) {
            if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.value = "••••••••";
            else element.textContent = "[REDACTED]";
            if (element instanceof HTMLElement) element.style.filter = "blur(8px)";
          }
        }
      }
    });
    const dataUrl = canvas.toDataURL("image/webp", 0.82);
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    if (Math.ceil(base64.length * 0.75) > 5 * 1024 * 1024) return undefined;
    return { mimeType: "image/webp", base64 };
  } finally {
    highlight.remove();
  }
}

export function FeedbackProvider(props: FeedbackProviderProps) {
  const [state, setState] = useState<FeedbackUiState>("idle");
  const [comment, setComment] = useState("");
  const [selected, setSelected] = useState<SelectedElement | null>(null);
  const [error, setError] = useState("");
  const [feedbackId, setFeedbackId] = useState("");
  const selectedNode = useRef<Element | null>(null);
  const controller = useRef<FeedbackController | null>(null);
  const shortcutEnabled = props.shortcut !== false;
  const redactionSelectors = useMemo(() => props.redactSelectors?.length ? props.redactSelectors : DEFAULT_REDACT_SELECTORS, [props.redactSelectors]);
  const clientConfig: FeedbackClientConfig = useMemo(() => ({ projectKey: props.projectKey, apiUrl: props.apiUrl, environment: props.environment, enabled: props.enabled }), [props.projectKey, props.apiUrl, props.environment, props.enabled]);

  useEffect(() => {
    if (!props.enabled || typeof window === "undefined") return;
    setComment(window.localStorage.getItem(browserDraftKey(props.projectKey)) || "");
  }, [props.enabled, props.projectKey]);

  useEffect(() => {
    if (!props.enabled || typeof document === "undefined") return;
    const nextController = new FeedbackController({
      enabled: true,
      onSelect: (element) => {
        const snapshot = selectElementSnapshot(element);
        if (!snapshot) return;
        selectedNode.current = element;
        setSelected(snapshot);
        setState("composing");
      },
      onStateChange: setState
    });
    controller.current = nextController;
    if (!shortcutEnabled) return () => nextController.unmount();
    const shortcutHandler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f") {
        event.preventDefault();
        nextController.startSelecting();
      }
    };
    document.addEventListener("keydown", shortcutHandler);
    return () => {
      document.removeEventListener("keydown", shortcutHandler);
      nextController.unmount();
    };
  }, [props.enabled, shortcutEnabled]);

  const updateComment = useCallback((value: string) => {
    setComment(value);
    if (typeof window !== "undefined") window.localStorage.setItem(browserDraftKey(props.projectKey), value);
  }, [props.projectKey]);

  const cancel = useCallback(() => {
    controller.current?.cancelSelecting();
    selectedNode.current = null;
    setSelected(null);
    setError("");
    setState("idle");
  }, []);

  const send = useCallback(async () => {
    if (!selected || !selectedNode.current || !comment.trim()) return;
    setError("");
    setState("capturing");
    let screenshot: FeedbackDraft["screenshot"];
    try { screenshot = await captureViewport(selectedNode.current, redactionSelectors); }
    catch { screenshot = undefined; }
    const draft: FeedbackDraft = {
      comment,
      page: { url: window.location.href, path: window.location.pathname, title: document.title, referrer: document.referrer || undefined },
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 },
      selectedElement: selected,
      appRevision: props.appRevision,
      screenshot
    };
    try {
      const response = await submitFeedback(clientConfig, draft);
      setFeedbackId(response.feedbackId);
      setState("submitted");
      updateComment("");
      props.onSubmitted?.({ feedbackId: response.feedbackId, requestId: response.requestId });
    } catch (submissionError) {
      setError(submissionError instanceof Error ? submissionError.message : "No se pudo enviar el feedback");
      setState("error");
    }
  }, [clientConfig, comment, props, redactionSelectors, selected, updateComment]);

  if (!props.enabled) return createElement(Fragment, null, props.children);

  return createElement(Fragment, null,
    props.children,
    createElement("div", { "data-feedback-ignore": "true", className: "feedback-code-root" },
      state === "idle" || state === "submitted" || state === "error"
        ? createElement("button", { type: "button", className: "feedback-code-launcher", onClick: () => controller.current?.startSelecting(), "aria-label": "Seleccionar un elemento para enviar feedback" }, "Feedback")
        : null,
      state === "selecting" ? createElement("div", { className: "feedback-code-hint", role: "status" }, "Selecciona un elemento · Esc para cancelar") : null,
      ["composing", "capturing", "error"].includes(state) && selected
        ? createElement("section", { className: "feedback-code-panel", role: "dialog", "aria-modal": "true", "aria-labelledby": "feedback-code-title" },
            createElement("h2", { id: "feedback-code-title" }, "Enviar feedback"),
            createElement("p", { className: "feedback-code-selected" }, `Elemento: ${selected.feedbackId || selected.testId || selected.accessibleName || selected.tagName}`),
            createElement("label", null, "¿Qué debería cambiar?",
              createElement("textarea", { value: comment, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => updateComment(event.currentTarget.value), rows: 5, maxLength: 2000, autoFocus: true, disabled: state === "capturing", placeholder: "Describe el problema y el resultado esperado" })
            ),
            error ? createElement("p", { className: "feedback-code-error", role: "alert" }, error) : null,
            createElement("p", { className: "feedback-code-privacy" }, "La captura redacta inputs y nodos sensibles. Revisa que no haya información privada visible."),
            createElement("div", { className: "feedback-code-actions" },
              createElement("button", { type: "button", className: "feedback-code-secondary", onClick: cancel, disabled: state === "capturing" }, "Cancelar"),
              createElement("button", { type: "button", className: "feedback-code-primary", onClick: () => void send(), disabled: state === "capturing" || !comment.trim() }, state === "capturing" ? "Capturando…" : state === "error" ? "Reintentar" : "Enviar")
            )
          )
        : null,
      state === "submitted"
        ? createElement("div", { className: "feedback-code-toast", role: "status" },
            createElement("span", null, `Feedback enviado · ${feedbackId}`),
            createElement("button", { type: "button", onClick: cancel, "aria-label": "Cerrar confirmación" }, "×")
          )
        : null
    )
  );
}
