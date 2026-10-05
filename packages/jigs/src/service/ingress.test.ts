import { createHmac } from "node:crypto";
import { expect, test } from "vitest";
import { verifyPagerDutySignature } from "./ingress.ts";

const hmac = (body: string, secret: string) =>
  createHmac("sha256", secret).update(body).digest("hex");

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
