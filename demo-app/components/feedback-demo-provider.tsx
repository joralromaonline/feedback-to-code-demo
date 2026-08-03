"use client";

import { useEffect, useState, type ReactNode } from "react";
import { FeedbackProvider } from "@feedback-code/next/react";

type PublicState = { status?: string; issueUrl?: string; pullRequestUrl?: string; message?: string };

export function FeedbackDemoProvider({ children }: { children: ReactNode }) {
  const [feedbackId, setFeedbackId] = useState("");
  const [state, setState] = useState<PublicState>({});
  const apiUrl = process.env.NEXT_PUBLIC_FEEDBACK_API_URL || "http://localhost:3001";

  useEffect(() => {
    if (!feedbackId) return;
    let cancelled = false;
    let timer: number | undefined;
    const startedAt = Date.now();
    const schedule = (poll: () => Promise<void>, delayMs: number) => {
      if (cancelled) return;
      if (Date.now() - startedAt >= 30 * 60_000) {
        setState((current) => ({ ...current, status: "poll_timeout", message: "La consulta superó 30 minutos. Revisa los logs del worker." }));
        return;
      }
      timer = window.setTimeout(() => void poll(), delayMs);
    };
    const poll = async () => {
      try {
        const response = await fetch(`${apiUrl}/v1/feedback/${feedbackId}`);
        const next = await response.json() as PublicState;
        if (cancelled) return;
        setState(next);
        if (!["pr_opened", "blocked", "failed"].includes(next.status || "")) schedule(poll, 2_000);
      } catch {
        schedule(poll, 3_000);
      }
    };
    void poll();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [apiUrl, feedbackId]);

  return (
    <FeedbackProvider
      projectKey={process.env.NEXT_PUBLIC_FEEDBACK_PROJECT_KEY || "pk_demo_public_key_change_me"}
      apiUrl={apiUrl}
      environment={(process.env.NEXT_PUBLIC_FEEDBACK_ENVIRONMENT as "development" | "staging") || "development"}
      enabled={process.env.NEXT_PUBLIC_FEEDBACK_ENABLED !== "false"}
      appRevision={process.env.NEXT_PUBLIC_APP_REVISION || "demo-local"}
      onSubmitted={({ feedbackId: id }) => { setFeedbackId(id); setState({ status: "received" }); }}
    >
      {children}
      {feedbackId ? (
        <aside className="flowStatus" data-feedback-ignore aria-live="polite">
          <span>Flujo</span>
          <strong>{state.status || "received"}</strong>
          <small>{feedbackId}</small>
          {state.message ? <small>{state.message}</small> : null}
          {state.issueUrl ? <a href={state.issueUrl} target="_blank" rel="noreferrer">Issue</a> : null}
          {state.pullRequestUrl ? <a href={state.pullRequestUrl} target="_blank" rel="noreferrer">Pull Request</a> : null}
        </aside>
      ) : null}
    </FeedbackProvider>
  );
}
