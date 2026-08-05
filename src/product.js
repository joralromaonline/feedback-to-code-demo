export const transactions = [
  { company: "Northwind Labs", plan: "Scale", amount: "$12,480", status: "Paid", date: "Aug 05, 2026", initials: "NL", accent: "violet" },
  { company: "Cobalt Systems", plan: "Growth", amount: "$8,920", status: "Pending review", date: "Aug 05, 2026", initials: "CS", accent: "cyan" },
  { company: "Vertex Cloud", plan: "Scale", amount: "$16,240", status: "Paid", date: "Aug 04, 2026", initials: "VC", accent: "lime" },
  { company: "Atlas Studio", plan: "Starter", amount: "$2,840", status: "Failed", date: "Aug 04, 2026", initials: "AS", accent: "rose" },
  { company: "Helio Robotics", plan: "Growth", amount: "$9,640", status: "Paid", date: "Aug 03, 2026", initials: "HR", accent: "amber" }
];

export function filterTransactions(query = "", status = "all") {
  const normalizedQuery = query.trim().toLowerCase();
  return transactions.filter((transaction) => {
    const queryMatches = !normalizedQuery || transaction.company.toLowerCase().includes(normalizedQuery);
    const statusMatches = status === "all" || transaction.status.toLowerCase().startsWith(status);
    return queryMatches && statusMatches;
  });
}

function renderTransactions() {
  const body = document.querySelector("#transactions-body");
  const query = document.querySelector("#transaction-search")?.value || "";
  const status = document.querySelector("#status-filter")?.value || "all";
  const rows = filterTransactions(query, status);
  if (!body) return;
  body.innerHTML = rows.length ? rows.map((transaction) => {
    const statusClass = transaction.status.toLowerCase().replaceAll(" ", "-");
    const feedbackAttribute = transaction.status === "Pending review" ? ' data-feedback-id="transaction-status-review"' : "";
    return `<tr data-feedback-id="transaction-${transaction.initials.toLowerCase()}"><td><div class="customer"><span class="avatar avatar--${transaction.accent}">${transaction.initials}</span><strong>${transaction.company}</strong></div></td><td><span class="muted">${transaction.plan}</span></td><td><strong>${transaction.amount}</strong></td><td><span class="status status--${statusClass}"${feedbackAttribute}><i></i>${transaction.status}</span></td><td><span class="muted">${transaction.date}</span></td><td><button class="row-menu" aria-label="Actions for ${transaction.company}"><i data-lucide="more-horizontal"></i></button></td></tr>`;
  }).join("") : '<tr><td colspan="6"><div class="empty">No transactions match the current filters.</div></td></tr>';
  window.lucide?.createIcons();
}

if (typeof document !== "undefined") {
  document.querySelector("#transaction-search")?.addEventListener("input", renderTransactions);
  document.querySelector("#status-filter")?.addEventListener("change", renderTransactions);
  renderTransactions();
  window.lucide?.createIcons();
}
