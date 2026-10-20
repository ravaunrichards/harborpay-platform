import test from "node:test";
import assert from "node:assert/strict";
import { parseMoneyAmount, validateRecipient } from "../src/validation.js";

test("accepts a valid two-decimal amount", () => assert.equal(parseMoneyAmount("12.50"), 12.5));
test("rejects zero and malformed amounts", () => {
  assert.throws(() => parseMoneyAmount("0"));
  assert.throws(() => parseMoneyAmount("1.234"));
  assert.throws(() => parseMoneyAmount("abc"));
});
test("normalizes recipient email", () => assert.equal(validateRecipient("USER@example.com"), "user@example.com"));
test("rejects invalid recipient email", () => assert.throws(() => validateRecipient("not-an-email")));
