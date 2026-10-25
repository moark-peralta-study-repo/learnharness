/**
 * The custom OpenAI-compatible endpoint (fork addition): URL normalization,
 * model-list parsing, the configured gate, and the live-state push. Pure —
 * no network, no LLM.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import {
	CUSTOM_PROVIDER_ID,
	EMPTY_ENDPOINT,
	currentEndpoint,
	customEndpointConfigured,
	modelsUrl,
	normalizeEndpointUrl,
	parseModelList,
	setCurrentEndpoint,
} from "../src/agent/custom-endpoint.ts";
import { piEngineForSpec, piModels } from "../src/agent/models.ts";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

describe("normalizeEndpointUrl", () => {
	it("assumes /v1 on a bare origin", () => {
		assert.equal(normalizeEndpointUrl("https://llmrouter.boyemma.com"), "https://llmrouter.boyemma.com/v1");
	});

	it("keeps a typed path, strips trailing slashes and query noise", () => {
		assert.equal(normalizeEndpointUrl(" https://gw.example.com/openai/v1/ "), "https://gw.example.com/openai/v1");
		assert.equal(normalizeEndpointUrl("http://127.0.0.1:11434/v1?x=1#y"), "http://127.0.0.1:11434/v1");
	});

	it("rejects non-http(s) and junk", () => {
		assert.equal(normalizeEndpointUrl("file:///tmp/x"), null);
		assert.equal(normalizeEndpointUrl("not a url"), null);
		assert.equal(normalizeEndpointUrl("  "), null);
	});

	it("modelsUrl appends /models without doubling the slash", () => {
		assert.equal(modelsUrl("https://gw.example.com/v1"), "https://gw.example.com/v1/models");
		assert.equal(modelsUrl("https://gw.example.com/v1/"), "https://gw.example.com/v1/models");
	});
});

describe("parseModelList", () => {
	it("reads the OpenAI shape, sorts by id and dedupes", () => {
		const models = parseModelList({ data: [{ id: "b" }, { id: "a" }, { id: "a" }, { nope: 1 }] });
		assert.deepEqual(models.map((m) => m.id), ["a", "b"]);
	});

	it("accepts a bare array (some local servers)", () => {
		assert.deepEqual(parseModelList([{ id: "only" }]).map((m) => m.id), ["only"]);
	});

	it("parks an explicit reasoning:false, leaving absence alone", () => {
		assert.deepEqual(parseModelList({ data: [{ id: "plain", reasoning: false }] })[0]!.reasoning, false);
		assert.equal(parseModelList({ data: [{ id: "default" }] })[0]!.reasoning, undefined);
	});

	it("keeps advertised context window and vision, never invents them", () => {
		const [withMeta] = parseModelList({ data: [{ id: "v", context_length: 32000, modalities: { input: ["text", "image"] } }] });
		assert.equal(withMeta!.contextWindow, 32000);
		assert.equal(withMeta!.vision, true);
		const [plain] = parseModelList({ data: [{ id: "p" }] });
		assert.equal(plain!.contextWindow, undefined);
		assert.equal(plain!.vision, undefined);
		assert.equal(plain!.name, "p");
	});

	it("garbage in, empty list out", () => {
		assert.deepEqual(parseModelList(null), []);
		assert.deepEqual(parseModelList({ data: "nope" }), []);
	});
});

describe("customEndpointConfigured", () => {
	it("needs both a URL and a model", () => {
		assert.equal(customEndpointConfigured(EMPTY_ENDPOINT), false);
		assert.equal(customEndpointConfigured({ baseUrl: "https://x/v1", models: [], updatedAt: "" }), false);
		assert.equal(customEndpointConfigured({ baseUrl: "https://x/v1", models: [{ id: "m", name: "m" }], updatedAt: "" }), true);
	});
});

describe("the provider", () => {
	beforeEach(() => setCurrentEndpoint(EMPTY_ENDPOINT));

	it("registers with no models while unconfigured", () => {
		const provider = piModels().getProviders().find((p) => p.id === CUSTOM_PROVIDER_ID);
		assert.ok(provider, "custom provider is always registered");
		assert.equal(provider!.getModels().length, 0);
	});

	it("publishes the pushed record live — no restart, straight from the state", () => {
		setCurrentEndpoint({ baseUrl: "https://gw.example.com/v1", models: [{ id: "m1", name: "M One", contextWindow: 4096, vision: true }], updatedAt: "" });
		assert.equal(currentEndpoint().baseUrl, "https://gw.example.com/v1");
		const model = piModels().getModel(CUSTOM_PROVIDER_ID, "m1");
		assert.ok(model, "the pushed model resolves");
		assert.equal(model!.baseUrl, "https://gw.example.com/v1", "each model is pinned to the endpoint");
		assert.deepEqual(model!.input, ["text", "image"]);
		assert.equal(model!.contextWindow, 4096);
	});

	it("endpoint models are reasoning by default (the thinking picker offers levels)", () => {
		setCurrentEndpoint({ baseUrl: "https://gw.example.com/v1", models: [{ id: "m1", name: "M One" }], updatedAt: "" });
		const engine = piEngineForSpec({ provider: CUSTOM_PROVIDER_ID, id: "m1", thinkingLevel: "high" });
		assert.equal(engine.level, "high");
		assert.ok(getSupportedThinkingLevels(engine.model).includes("high"));
	});

	it("an endpoint can opt a model back out of reasoning", () => {
		setCurrentEndpoint({ baseUrl: "https://gw.example.com/v1", models: [{ id: "plain", name: "Plain", reasoning: false }], updatedAt: "" });
		const engine = piEngineForSpec({ provider: CUSTOM_PROVIDER_ID, id: "plain" });
		assert.deepEqual(getSupportedThinkingLevels(engine.model), ["off"]);
	});

	it("builds an engine for a custom model (the chat path)", () => {
		setCurrentEndpoint({ baseUrl: "https://gw.example.com/v1", models: [{ id: "m1", name: "M One" }], updatedAt: "" });
		const engine = piEngineForSpec({ provider: CUSTOM_PROVIDER_ID, id: "m1" });
		assert.equal(engine.model.id, "m1");
		// UNSET level on a reasoning-capable model takes the baked default
		// order's first entry (medium) — not off, which used to make the
		// picker look like it had nothing to offer.
		assert.equal(engine.level, "medium");
	});

	it("an unknown id still throws honestly", () => {
		assert.throws(() => piEngineForSpec({ provider: CUSTOM_PROVIDER_ID, id: "ghost" }), /no model ghost/);
	});
});