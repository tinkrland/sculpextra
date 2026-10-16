import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertLanguage,
  assertMarket,
  isMarket,
  ISO_3166_1_ALPHA_2,
  LanguageError,
  MarketError,
} from "../src/iso3166";
import { priorityScore } from "../src/priority";

const T0 = "2026-10-16T00:00:00.000Z";

test("the iso set holds all 249 officially assigned alpha-2 codes", () => {
  assert.equal(ISO_3166_1_ALPHA_2.size, 249);
  for (const code of ["US", "GB", "DE", "JP", "AU", "FR"]) {
    assert.ok(ISO_3166_1_ALPHA_2.has(code), code);
  }
});

test("uk is rejected: gb is the assigned code", () => {
  assert.equal(isMarket("UK"), false);
  assert.throws(() => assertMarket("UK"), MarketError);
});

test("assertMarket rejects lowercase, 3-letter and nonsense codes", () => {
  for (const bad of ["us", "usa", "U", "ZZ", "", "U1"]) {
    assert.throws(() => assertMarket(bad), MarketError, bad);
  }
  assert.doesNotThrow(() => assertMarket("US"));
});

test("assertLanguage accepts bcp-47 shapes and rejects the rest", () => {
  assert.doesNotThrow(() => assertLanguage("en-US"));
  assert.doesNotThrow(() => assertLanguage("en"));
  assert.doesNotThrow(() => assertLanguage("pt-BR"));
  assert.throws(() => assertLanguage("english"), LanguageError);
  assert.throws(() => assertLanguage(""), LanguageError);
});

test("priority is age in minutes and nothing else", () => {
  assert.equal(priorityScore(T0, "2026-10-16T00:10:00.000Z"), 10);
  assert.equal(priorityScore(T0, T0), 0);
  // future-dated opens clamp to zero instead of going negative
  assert.equal(priorityScore(T0, "2026-10-15T00:00:00.000Z"), 0);
  assert.throws(() => priorityScore("nope", T0));
  // two tickets of equal age score equally: no other input exists
  assert.equal(
    priorityScore(T0, "2026-10-16T01:00:00.000Z"),
    priorityScore(T0, "2026-10-16T01:00:00.000Z"),
  );
  // and the score grows with age
  assert.ok(priorityScore(T0, "2026-10-17T00:00:00.000Z") > priorityScore(T0, "2026-10-16T12:00:00.000Z"));
});
