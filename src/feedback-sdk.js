const config = window.FEEDBACK_CONFIG || {};

function icon(name, size = 15) {
  return `<i data-lucide="${name}" style="width:${size}px;height:${size}px"></i>`;
}

function refreshIcons() { window.lucide?.createIcons(); }
function normalize(value, max = 300) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, max); }
function uuid() { return globalThis.crypto?.randomUUID?.() || "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (value) => { const random = Math.random() * 16 | 0; return (value === "x" ? random : (random & 3 | 8)).toString(16); }); }

function selectedElementSnapshot(element) {
  const rect = element.getBoundingClientRect();
  const attributes = {};
  for (const attribute of Array.from(element.attributes).slice(0, 32)) {
    if (!["value", "placeholder"].includes(attribute.name)) attributes[attribute.name] = attribute.value.slice(0, 300);
  }
  const ancestorSummary = [];
  let ancestor = element.parentElement;
  while (ancestor && ancestorSummary.length < 6) {
    ancestorSummary.push({ tagName: ancestor.tagName.toLowerCase(), role: ancestor.getAttribute("role") || undefined, testId: ancestor.getAttribute("data-testid") || undefined });
    ancestor = ancestor.parentElement;
  }
  return {
    tagName: element.tagName.toLowerCase(),
    role: element.getAttribute("role") || undefined,
    accessibleName: element.getAttribute("aria-label") || normalize(element.textContent),
    textPreview: element.matches("input,textarea,[data-sensitive]") ? "[REDACTED]" : normalize(element.textContent),
    attributes,
    testId: element.getAttribute("data-testid") || undefined,
    feedbackId: element.getAttribute("data-feedback-id") || undefined,
    boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    ancestorSummary
  };
}

function toast(message) {
  document.querySelector(".fc-toast")?.remove();
  const node = document.createElement("div");
  node.className = "fc-toast";
  node.dataset.feedbackIgnore = "true";
  node.innerHTML = `${icon("circle-check", 16)}<span></span>`;
  node.querySelector("span").textContent = message;
  document.body.appendChild(node);
  refreshIcons();
  setTimeout(() => node.remove(), 5000);
}

function mountDock(feedbackId) {
  document.querySelector(".fc-dock")?.remove();
  const dock = document.createElement("aside");
  dock.className = "fc-dock";
  dock.dataset.feedbackIgnore = "true";
  dock.innerHTML = `<header><i></i><span>Agent execution</span><code>${feedbackId.slice(0, 11)}</code></header><section><strong>received</strong><span>Preparing repository context and validation evidence.</span></section><div class="fc-progress"><i></i></div><footer></footer>`;
  document.body.appendChild(dock);
  const title = dock.querySelector("section strong");
  const description = dock.querySelector("section span");
  const progress = dock.querySelector(".fc-progress i");
  const footer = dock.querySelector("footer");
  const terminal = new Set(["pr_opened", "blocked", "failed"]);
  const poll = async () => {
    try {
      const response = await fetch(`${config.apiUrl.replace(/\/$/, "")}/v1/feedback/${feedbackId}`);
      const state = await response.json();
      title.textContent = String(state.status || "processing").replaceAll("_", " ");
      description.textContent = state.message || (state.status === "pr_opened" ? "Pull Request ready. Merge it, wait for Pages, then reload this product." : "The agent is processing the selected product context.");
      const widths = { received: "18%", processing: "45%", issue_created: "62%", pr_opened: "100%", blocked: "100%", failed: "100%" };
      progress.style.width = widths[state.status] || "45%";
      footer.replaceChildren();
      if (state.issueUrl) { const link = document.createElement("a"); link.href = state.issueUrl; link.target = "_blank"; link.rel = "noreferrer"; link.innerHTML = `${icon("file-text", 13)}Issue${icon("external-link", 11)}`; footer.appendChild(link); }
      if (state.pullRequestUrl) { const link = document.createElement("a"); link.href = state.pullRequestUrl; link.target = "_blank"; link.rel = "noreferrer"; link.innerHTML = `${icon("git-pull-request", 13)}Open PR${icon("external-link", 11)}`; footer.appendChild(link); const reload = document.createElement("button"); reload.innerHTML = `${icon("refresh-cw", 12)}Reload product`; reload.addEventListener("click", () => window.location.reload()); footer.appendChild(reload); }
      refreshIcons();
      if (!terminal.has(state.status)) setTimeout(poll, 2200);
    } catch { setTimeout(poll, 3500); }
  };
  void poll();
}

function composeFeedback(selected) {
  document.querySelector(".fc-panel")?.remove();
  const panel = document.createElement("section");
  panel.className = "fc-panel";
  panel.dataset.feedbackIgnore = "true";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.innerHTML = `<header><div><span>${icon("message-square-plus", 16)}</span><h2>Send product feedback</h2></div><button class="fc-close" aria-label="Close">${icon("x", 16)}</button></header><p class="fc-selected"></p><label>What should change?<textarea maxlength="2000" placeholder="Describe the expected result in your own words"></textarea></label><p class="fc-privacy">${icon("shield-check", 13)}Your comment and semantic UI context will be sent to the engineering agent.</p><p class="fc-error" hidden></p><div class="fc-actions"><button class="fc-cancel">Cancel</button><button class="fc-send" disabled>${icon("send", 13)}Send feedback</button></div>`;
  panel.querySelector(".fc-selected").textContent = `Selected: ${selected.feedbackId || selected.testId || selected.accessibleName || selected.tagName}`;
  document.body.appendChild(panel);
  const textarea = panel.querySelector("textarea");
  const send = panel.querySelector(".fc-send");
  const close = () => panel.remove();
  panel.querySelector(".fc-close").addEventListener("click", close);
  panel.querySelector(".fc-cancel").addEventListener("click", close);
  textarea.addEventListener("input", () => { send.disabled = !textarea.value.trim(); });
  send.addEventListener("click", async () => {
    const feedbackId = uuid();
    send.disabled = true;
    const error = panel.querySelector(".fc-error");
    try {
      const payload = {
        clientFeedbackId: feedbackId,
        comment: textarea.value.trim(),
        page: { url: window.location.href, path: window.location.pathname, title: document.title, ...(document.referrer ? { referrer: document.referrer } : {}) },
        environment: config.environment || "staging",
        viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio || 1 },
        selectedElement: selected,
        client: { sdkVersion: "0.1.0-standalone", userAgent: navigator.userAgent },
        appRevision: config.appRevision || "demo-base"
      };
      const response = await fetch(`${config.apiUrl.replace(/\/$/, "")}/v1/feedback`, { method: "POST", headers: { "content-type": "application/json", "x-feedback-project-key": config.projectKey, "idempotency-key": feedbackId }, body: JSON.stringify(payload) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Feedback service unavailable");
      close(); toast("Feedback received. The agent is now working."); mountDock(body.feedbackId);
    } catch (submissionError) {
      error.hidden = false;
      error.textContent = submissionError instanceof TypeError
        ? "The public feedback API is unreachable. Verify that the Cloudflare tunnel is running, then retry."
        : submissionError instanceof Error ? submissionError.message : "Unable to send feedback";
      send.disabled = false;
    }
  });
  refreshIcons();
  textarea.focus();
}

function startSelection() {
  const launcher = document.querySelector(".fc-launcher");
  launcher.hidden = true;
  const hint = document.createElement("div");
  hint.className = "fc-hint";
  hint.dataset.feedbackIgnore = "true";
  hint.innerHTML = `${icon("scan-search", 15)}Select any product element · Esc to cancel`;
  document.body.appendChild(hint);
  refreshIcons();
  let highlighted;
  let previousOutline = "";
  let previousOffset = "";
  const restore = () => { if (highlighted) { highlighted.style.outline = previousOutline; highlighted.style.outlineOffset = previousOffset; highlighted = undefined; } };
  const cleanup = () => { restore(); hint.remove(); launcher.hidden = false; document.removeEventListener("mousemove", move, true); document.removeEventListener("click", click, true); document.removeEventListener("keydown", keydown, true); };
  const move = (event) => { const target = event.target; if (!(target instanceof HTMLElement) || target.closest("[data-feedback-ignore]")) return restore(); restore(); highlighted = target; previousOutline = target.style.outline; previousOffset = target.style.outlineOffset; target.style.outline = "2px solid #8c7cf0"; target.style.outlineOffset = "2px"; };
  const click = (event) => { const target = event.target; if (!(target instanceof HTMLElement) || target.closest("[data-feedback-ignore]")) return; event.preventDefault(); event.stopPropagation(); const selected = selectedElementSnapshot(target.closest("[data-feedback-id]") || target); cleanup(); composeFeedback(selected); };
  const keydown = (event) => { if (event.key === "Escape") cleanup(); };
  document.addEventListener("mousemove", move, true); document.addEventListener("click", click, true); document.addEventListener("keydown", keydown, true);
}

if (config.enabled && /^https:\/\//.test(config.apiUrl || "") && config.projectKey) {
  const launcher = document.createElement("button");
  launcher.className = "fc-launcher";
  launcher.dataset.feedbackIgnore = "true";
  launcher.innerHTML = `${icon("message-square-plus", 16)}Feedback`;
  launcher.addEventListener("click", startSelection);
  document.body.appendChild(launcher);
  document.addEventListener("keydown", (event) => { if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "f") startSelection(); });
  refreshIcons();
}
