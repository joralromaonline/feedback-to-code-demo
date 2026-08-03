import { createHmac, timingSafeEqual } from "node:crypto";

export function signGitHubWebhook(secret: string, payload: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

export function verifyGitHubWebhook(secret: string, payload: Buffer | string, signature: string | undefined): boolean {
  if (!secret || !signature || !signature.startsWith("sha256=")) return false;
  const expected = Buffer.from(signGitHubWebhook(secret, payload), "utf8");
  const received = Buffer.from(signature, "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
