import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JevJudgmentProviderConfig } from "../../../src/adapters/typesafe/jev-judgment-provider.js";
import { resolveJudgmentBackend } from "../../../src/adapters/pi/resolve-judgment-provider.js";
import { JudgmentProviderError } from "../../../src/application/ports/judgment-provider.js";

function host(key?: string, fails = false): ExtensionContext {
  return { modelRegistry: { async getApiKeyForProvider(provider: string) {
    assert.equal(provider, "openrouter");
    if (fails) throw Error("PRIVATE_SECRET");
    return key;
  } } } as unknown as ExtensionContext;
}
const fake = (config: JevJudgmentProviderConfig) => ({
  async judge(): Promise<never> { assert.fail("no network call during credential resolution"); },
  config,
});

test("Pi OpenRouter key takes precedence over standalone OpenRouter and TypeSafe env keys", async () => {
  const backend = await resolveJudgmentBackend(host("pi-key"), {
    OPENROUTER_API_KEY: "env-openrouter", TYPESAFE_API_KEY: "env-typesafe",
    TYPESAFE_BASE_URL: "https://untrusted.example",
  }, fake);
  assert.equal(backend.recipient, "OpenRouter");
  assert.deepEqual((backend.provider as ReturnType<typeof fake>).config, {
    apiKey: "pi-key", baseURL: "https://openrouter.ai/api", defaultModel: "jev-1.13",
  });
});

test("falls back to OPENROUTER_API_KEY when Pi has no usable key", async () => {
  const backend = await resolveJudgmentBackend(host(undefined, true), {
    OPENROUTER_API_KEY: "env-key", TYPESAFE_API_KEY: "typesafe-key",
  }, fake);
  assert.equal(backend.recipient, "OpenRouter");
  assert.equal((backend.provider as ReturnType<typeof fake>).config.apiKey, "env-key");
});

test("falls back to direct TypeSafe only if OpenRouter is not configured", async () => {
  const backend = await resolveJudgmentBackend(host(), {
    OPENROUTER_API_KEY: "   ", TYPESAFE_API_KEY: "typesafe-key",
  }, fake);
  assert.equal(backend.recipient, "TypeSafe");
  assert.deepEqual((backend.provider as ReturnType<typeof fake>).config, {
    apiKey: "typesafe-key", baseURL: "https://api.typesafe.ai", defaultModel: "jev-latest",
  });
});

test("fails closed before constructing an SDK client when neither key exists", async () => {
  await assert.rejects(resolveJudgmentBackend(host(undefined, true), {
    OPENROUTER_API_KEY: "", TYPESAFE_API_KEY: "   ",
  }, () => assert.fail("must not instantiate")), (error: unknown) => {
    assert.ok(error instanceof JudgmentProviderError);
    assert.equal(error.code, "unauthorized");
    assert.doesNotMatch(error.message, /PRIVATE_SECRET/);
    return true;
  });
});
