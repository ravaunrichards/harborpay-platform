import test from "node:test";
import assert from "node:assert/strict";
import {
  minorToDecimalString,
  parseAmountToMinor,
  validateDescription,
  validateEmail
} from "../src/money.js";

test("converts decimal amounts into integer minor units", () => {
  assert.equal(parseAmountToMinor("12.50"), 1250);
  assert.equal(parseAmountToMinor("1"), 100);
  assert.equal(parseAmountToMinor("1.2"), 120);
  assert.equal(minorToDecimalString(1250), "12.50");
});

test("rejects zero, negative, malformed, and excessive amounts", () => {
  for (const value of ["0", "-1", "1.234", "1,000", "abc", ""]) {
    assert.throws(() => parseAmountToMinor(value), (error) => error.status === 400);
  }
  assert.throws(() => parseAmountToMinor("10001.00"), (error) => error.status === 400);
});

test("normalizes and validates email addresses", () => {
  assert.equal(validateEmail(" USER@example.com "), "user@example.com");
  assert.throws(() => validateEmail("not-an-email"), (error) => error.status === 400);
});

test("requires a meaningful bounded payment description", () => {
  assert.equal(validateDescription("Service invoice"), "Service invoice");
  assert.throws(() => validateDescription("x"), (error) => error.status === 400);
  assert.throws(() => validateDescription("x".repeat(121)), (error) => error.status === 400);
});
