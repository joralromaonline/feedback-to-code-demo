"use client";

import { useEffect, useState, type ReactNode } from "react";
import { FeedbackProvider } from "@feedback-code/next/react";

type PublicState = { status?: string; issueUrl?: string; pullRequestUrl?: string };

export function FeedbackDemoProvider({ children }: { children: ReactNode }) {
  const [feedbackId, setFeedbackId] = useState("");
  const [state, setState] = useState<PublicState>({});
  const apiUrl = process.env.NEXT_PUBLIC_FEEDBACK_API_URL || "http://localhost:3001";

  useEffect(() => {
    if (!feedbackId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`${apiUrl}/v1/feedback/${feedbackId}`);
        const next = await response.json() as PublicState;
        if (cancelled) return;
        setState(next);
        if (!["pr_opened", "blocked", "failed"].includes(next.status || "")) window.setTimeout(poll, 1000);
      } catch {
        if (!cancelled) window.setTimeout(poll, 1500);
      }
    };
    void poll();
    return () => { cancelled = true; };
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
          {state.issueUrl ? <a href={state.issueUrl} target="_blank" rel="noreferrer">Issue</a> : null}
          {state.pullRequestUrl ? <a href={state.pullRequestUrl} target="_blank" rel="noreferrer">Pull Request</a> : null}
        </aside>
      ) : null}
    </FeedbackProvider>
  );
}
