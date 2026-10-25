/**
 * GET/PUT/DELETE /api/custom-endpoint — the user's own OpenAI-compatible
 * endpoint (fork addition): the LLM router / LiteLLM / vLLM / Ollama /
 * gateway every `custom` model runs through.
 *
 * GET → { baseUrl, models, keyPresent, contextWindows } (never the key).
 * PUT   → { baseUrl, apiKey? } — normalizes the URL, DISCOVERS its model
 *         list from GET {base}/models (with the key when given, else the
 *         one already saved), saves url + models + key. A failed discovery
 *         saves NOTHING and reports the endpoint's own error, so a typo
 *         can never leave a half-configured provider behind.
 * PATCH → { contextWindows?, maxOutputs? } — per-model window and reply-cap
 *          overrides (fork fix). Separate from PUT on purpose: retyping a
 *          number must not re-run discovery or need the key, and a bad value
 *          must fail without disturbing the endpoint. A maxOutput of 0 means
 *          NO LIMIT (the field is left off the request); blank clears an
 *          override.
 * DELETE → clears the endpoint and its saved key.
 *
 * The key rides the keys seam under CUSTOM_ENDPOINT_API_KEY, so it is
 * masked in every response and env wins over the file exactly like every
 * other provider key.
 */
import { CUSTOM_ENDPOINT_KEY_VAR, EMPTY_ENDPOINT, MAX_CONTEXT_WINDOW, MAX_OUTPUT_TOKENS, MIN_CONTEXT_WINDOW, deleteKey, keyValue, modelsUrl, normalizeEndpointUrl, parseModelList, readEndpoint, saveEndpoint, saveOverrides, saveKey, writeEndpoint } from "@/src/server";

export const dynamic = "force-dynamic";

function view() {
	const record = readEndpoint();
	return Response.json({ baseUrl: record.baseUrl, models: record.models, contextWindows: record.contextWindows ?? {}, maxOutputs: record.maxOutputs ?? {}, keyPresent: keyValue(CUSTOM_ENDPOINT_KEY_VAR) !== undefined });
}

/** Translate a discovery failure into a message the user can act on. */
async function discover(baseUrl: string, apiKey: string | undefined): Promise<{ ok: true; models: ReturnType<typeof parseModelList> } | { ok: false; status: number; error: string }> {
	let res: Response;
	try {
		res = await fetch(modelsUrl(baseUrl), {
			headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
			signal: AbortSignal.timeout(20_000),
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, status: 502, error: `could not reach ${modelsUrl(baseUrl)} — ${message}` };
	}
	if (!res.ok) {
		const body = (await res.text().catch(() => "")).slice(0, 300);
		const hint = res.status === 401 || res.status === 403 ? " (the key looks wrong or missing)" : res.status === 404 ? " (does it expose /models? paste the full base, e.g. …/v1)" : "";
		return { ok: false, status: 502, error: `${modelsUrl(baseUrl)} answered ${res.status}${hint}${body ? ` — ${body}` : ""}` };
	}
	const models = parseModelList(await res.json().catch(() => null));
	if (!models.length) return { ok: false, status: 502, error: `${modelsUrl(baseUrl)} returned no models` };
	return { ok: true, models };
}

export async function GET() {
	return view();
}

export async function PUT(request: Request) {
	const body = (await request.json().catch(() => null)) as { baseUrl?: unknown; apiKey?: unknown } | null;
	if (!body || typeof body.baseUrl !== "string") return Response.json({ error: "baseUrl is required" }, { status: 400 });
	const baseUrl = normalizeEndpointUrl(body.baseUrl);
	if (!baseUrl) return Response.json({ error: "baseUrl must be an http(s) URL, e.g. https://llmrouter.example.com/v1" }, { status: 400 });

	const typedKey = typeof body.apiKey === "string" && body.apiKey.trim() ? body.apiKey.trim() : undefined;
	const apiKey = typedKey ?? keyValue(CUSTOM_ENDPOINT_KEY_VAR);
	if (!apiKey) return Response.json({ error: "an API key is required for this endpoint" }, { status: 400 });

	const found = await discover(baseUrl, apiKey);
	if (!found.ok) return Response.json({ error: found.error }, { status: found.status });

	if (typedKey) {
		const saved = saveKey(CUSTOM_ENDPOINT_KEY_VAR, typedKey);
		if (!saved.ok) return Response.json({ error: saved.error }, { status: 400 });
	}
	const record = await saveEndpoint(baseUrl, found.models);
	return Response.json({ baseUrl: record.baseUrl, models: record.models, keyPresent: true });
}

export async function PATCH(request: Request) {
	const body = (await request.json().catch(() => null)) as { contextWindows?: unknown; maxOutputs?: unknown } | null;
	const isMap = (v: unknown) => typeof v === "object" && v !== null;
	if (!body || (!isMap(body.contextWindows) && !isMap(body.maxOutputs))) return Response.json({ error: "contextWindows or maxOutputs is required" }, { status: 400 });
	const record = readEndpoint();
	if (!record.baseUrl) return Response.json({ error: "connect an endpoint first" }, { status: 400 });
	// Validate against the models actually present, so a typo cannot be
	// stored against a model that is not there. Blank clears an override.
	const parse = (map: unknown, label: string, min: number, max: number): { values: Record<string, number> } | { error: string } => {
		const values: Record<string, number> = {};
		for (const [id, value] of Object.entries(map as Record<string, unknown>)) {
			if (!record.models.some((m) => m.id === id)) return { error: `unknown model: ${id}` };
			if (value === null || value === "" || value === undefined) continue;
			const n = typeof value === "number" ? value : Number(value);
			if (!Number.isInteger(n) || n < min || n > max) return { error: `${id}: ${label} must be a whole number between ${min} and ${max}` };
			values[id] = n;
		}
		return { values };
	};
	const overrides: { contextWindows?: Record<string, number>; maxOutputs?: Record<string, number> } = {};
	if (isMap(body.contextWindows)) {
		const parsed = parse(body.contextWindows, "context window", MIN_CONTEXT_WINDOW, MAX_CONTEXT_WINDOW);
		if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
		overrides.contextWindows = parsed.values;
	}
	if (isMap(body.maxOutputs)) {
		const parsed = parse(body.maxOutputs, "reply cap (0 = no limit)", 0, MAX_OUTPUT_TOKENS);
		if ("error" in parsed) return Response.json({ error: parsed.error }, { status: 400 });
		overrides.maxOutputs = parsed.values;
	}
	const saved = await saveOverrides(overrides);
	return Response.json({ baseUrl: saved.baseUrl, models: saved.models, contextWindows: saved.contextWindows ?? {}, maxOutputs: saved.maxOutputs ?? {}, keyPresent: keyValue(CUSTOM_ENDPOINT_KEY_VAR) !== undefined });
}

export async function DELETE() {
	await writeEndpoint(EMPTY_ENDPOINT);
	deleteKey(CUSTOM_ENDPOINT_KEY_VAR);
	return view();
}