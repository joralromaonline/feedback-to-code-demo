import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("checkout submit keeps its label visible", async () => {
  const css = await readFile(new URL("./checkout.css", import.meta.url), "utf8");
  assert.match(css, /\.checkout-submit/);
  assert.match(css, /max-width:\s+(none|[0-9]+px)/);
});
