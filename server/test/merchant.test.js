import test from "node:test";
import assert from "node:assert/strict";
import {
  validateMerchantName,
  validateOrderReference,
  validatePaymentLinkTitle,
  validateOptionalUrl
} from "../src/merchant.js";

test("validates merchant display names", () => {
  assert.equal(validateMerchantName("Harbor Store"), "Harbor Store");
  assert.throws(() => validateMerchantName("x"), (error) => error.status === 400);
  assert.throws(() => validateMerchantName("x".repeat(121)), (error) => error.status === 400);
});

test("validates order references without accepting unsafe characters", () => {
  assert.equal(validateOrderReference("INV-2026-001"), "INV-2026-001");
  assert.throws(() => validateOrderReference(" "), (error) => error.status === 400);
  assert.throws(() => validateOrderReference("bad reference"), (error) => error.status === 400);
});

test("validates payment link titles", () => {
  assert.equal(validatePaymentLinkTitle("Service invoice"), "Service invoice");
  assert.throws(() => validatePaymentLinkTitle("x"), (error) => error.status === 400);
});

test("accepts only HTTPS merchant websites", () => {
  assert.equal(validateOptionalUrl("https://example.com"), "https://example.com/");
  assert.equal(validateOptionalUrl(""), null);
  assert.throws(() => validateOptionalUrl("http://example.com"), (error) => error.status === 400);
});
