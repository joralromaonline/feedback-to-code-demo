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
