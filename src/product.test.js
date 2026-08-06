import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { filterTransactions, transactions } from "./product.js";

test("product dashboard exposes a realistic transaction model", () => {
  assert.equal(transactions.length, 5);
  assert.equal(filterTransactions("cobalt")[0]?.status, "Pending review");
  assert.equal(filterTransactions("", "paid").length, 3);
});

test("published page uses Lucide and stable feedback targets", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /lucide@/);
  assert.match(html, /data-feedback-id="transactions-panel"/);
  assert.match(html, /src\/feedback-sdk\.js/);
});

test("automation approves only the validated feedback commit and closes after deploy", async () => {
  const validate = await readFile(new URL("../.github/workflows/validate.yml", import.meta.url), "utf8");
  const pages = await readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8");

  assert.match(validate, /needs: \[invalidate-stale-approval, validate\]/);
  assert.match(validate, /needs\.validate\.result == 'success'/);
  assert.match(validate, /pull-requests: write/);
  assert.match(validate, /event: "APPROVE"/);
  assert.match(validate, /Automatic approval blocked by out-of-scope files/);
  assert.doesNotMatch(validate, /deploy-approved-preview:/);
  assert.doesNotMatch(validate, /actions\/deploy-pages@v4/);
  assert.match(pages, /needs: deploy/);
  assert.match(pages, /issues: write/);
  assert.match(pages, /listPullRequestsAssociatedWithCommit/);
  assert.match(pages, /feedback:status:deployed/);
  assert.match(pages, /state_reason: "completed"/);
});
