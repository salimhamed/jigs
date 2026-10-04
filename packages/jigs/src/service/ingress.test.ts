import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import {
  verifyGithubSignature,
  verifyLinearSignature,
  verifyPagerDutySignature,
} from "./ingress.ts";

const hmac = (body: string, secret: string) =>
  createHmac("sha256", secret).update(body).digest("hex");

test("github signature verifies against the raw body", () => {
  const body = JSON.stringify({ action: "submitted" });
  const header = `sha256=${hmac(body, "s3cret")}`;
  expect(verifyGithubSignature(body, header, "s3cret")).toBe(true);
});

test("github signature rejects a tampered body", () => {
  const header = `sha256=${hmac('{"action":"submitted"}', "s3cret")}`;
  expect(verifyGithubSignature('{"action":"approved"}', header, "s3cret")).toBe(false);
});

test("github signature rejects the wrong secret", () => {
  const body = "{}";
  const header = `sha256=${hmac(body, "other")}`;
  expect(verifyGithubSignature(body, header, "s3cret")).toBe(false);
});

test("github signature rejects a malformed or missing header", () => {
  const body = "{}";
  expect(verifyGithubSignature(body, undefined, "s3cret")).toBe(false);
  expect(verifyGithubSignature(body, hmac(body, "s3cret"), "s3cret")).toBe(false);
  expect(verifyGithubSignature(body, "sha256=", "s3cret")).toBe(false);
  expect(verifyGithubSignature(body, "sha256=abc123", "s3cret")).toBe(false);
  expect(verifyGithubSignature(body, `sha256=${"zz".repeat(32)}`, "s3cret")).toBe(false);
});

test("linear signature verifies and rejects the wrong secret", () => {
  const body = JSON.stringify({ type: "Comment" });
  expect(verifyLinearSignature(body, hmac(body, "lin-secret"), "lin-secret")).toBe(true);
  expect(verifyLinearSignature(body, hmac(body, "wrong"), "lin-secret")).toBe(false);
  expect(verifyLinearSignature(body, undefined, "lin-secret")).toBe(false);
});

test("pagerduty signature verifies a v1 hmac of the raw body", () => {
  const body = JSON.stringify({ event: { event_type: "incident.triggered" } });
  expect(verifyPagerDutySignature(body, `v1=${hmac(body, "pd-secret")}`, "pd-secret")).toBe(true);
  expect(verifyPagerDutySignature(body, `v1=${hmac(body, "wrong")}`, "pd-secret")).toBe(false);
  expect(verifyPagerDutySignature(`${body} `, `v1=${hmac(body, "pd-secret")}`, "pd-secret")).toBe(
    false,
  );
});

test("pagerduty signature accepts any one of several v1 values, as during secret rotation", () => {
  const body = "{}";
  const header = `v1=${hmac(body, "old-secret")},v1=${hmac(body, "pd-secret")}`;
  expect(verifyPagerDutySignature(body, header, "pd-secret")).toBe(true);
  expect(verifyPagerDutySignature(body, header.replace(",", ", "), "pd-secret")).toBe(true);
  expect(verifyPagerDutySignature(body, header, "other-secret")).toBe(false);
});

test("pagerduty signature rejects a malformed or missing header", () => {
  const body = "{}";
  expect(verifyPagerDutySignature(body, undefined, "pd-secret")).toBe(false);
  expect(verifyPagerDutySignature(body, "", "pd-secret")).toBe(false);
  expect(verifyPagerDutySignature(body, hmac(body, "pd-secret"), "pd-secret")).toBe(false);
  expect(verifyPagerDutySignature(body, `v0=${hmac(body, "pd-secret")}`, "pd-secret")).toBe(false);
  expect(verifyPagerDutySignature(body, "v1=", "pd-secret")).toBe(false);
  expect(verifyPagerDutySignature(body, `v1=${"zz".repeat(32)}`, "pd-secret")).toBe(false);
});
