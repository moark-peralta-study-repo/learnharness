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
 * PATCH → { contextWindows } — per-model context-window overrides (fork
 *          fix). Separate from PUT on purpose: retyping a window must not
 *          re-run discovery or need the key, and a bad number must fail
 *          without disturbing the endpoint.
 * DELETE → clears the endpoint and its saved key.
 *
 * The key rides the keys seam under CUSTOM_ENDPOINT_API_KEY, so it is
 * masked in every response and env wins over the file exactly like every
 * other provider key.
 */
import { CUSTOM_ENDPOINT_KEY_VAR, EMPTY_ENDPOINT, MAX_CONTEXT_WINDOW, MIN_CONTEXT_WINDOW, deleteKey, keyValue, modelsUrl, normalizeEndpointUrl, parseModelList, readEndpoint, saveContextWindows, saveEndpoint, saveKey, writeEndpoint } from "@/src/server";

export const dynamic = "force-dynamic";

function view() {
	const record = readEndpoint();
	return Response.json({ baseUrl: record.baseUrl, models: record.models, contextWindows: record.contextWindows ?? {}, keyPresent: keyValue(CUSTOM_ENDPOINT_KEY_VAR) !== undefined });
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
	const body = (await request.json().catch(() => null)) as { contextWindows?: unknown } | null;
	if (!body || typeof body.contextWindows !== "object" || body.contextWindows === null) return Response.json({ error: "contextWindows is required" }, { status: 400 });
	const record = readEndpoint();
	if (!record.baseUrl) return Response.json({ error: "connect an endpoint first" }, { status: 400 });
	// Validate against the models actually present, so a typo cannot be
	// stored against a model that is not there.
	for (const [id, value] of Object.entries(body.contextWindows as Record<string, unknown>)) {
		if (!record.models.some((m) => m.id === id)) return Response.json({ error: `unknown model: ${id}` }, { status: 400 });
		if (value === null || value === "" || value === undefined) continue;
		const window = typeof value === "number" ? value : Number(value);
		if (!Number.isInteger(window) || window < MIN_CONTEXT_WINDOW || window > MAX_CONTEXT_WINDOW) {
			return Response.json({ error: `${id}: context window must be a whole number between ${MIN_CONTEXT_WINDOW} and ${MAX_CONTEXT_WINDOW}` }, { status: 400 });
		}
	}
	const cleaned = Object.fromEntries(
		Object.entries(body.contextWindows as Record<string, unknown>)
			.filter(([, v]) => v !== null && v !== "" && v !== undefined)
			.map(([id, v]) => [id, Number(v)]),
	);
	const saved = await saveContextWindows(cleaned);
	return Response.json({ baseUrl: saved.baseUrl, models: saved.models, contextWindows: saved.contextWindows ?? {}, keyPresent: keyValue(CUSTOM_ENDPOINT_KEY_VAR) !== undefined });
}

export async function DELETE() {
	await writeEndpoint(EMPTY_ENDPOINT);
	deleteKey(CUSTOM_ENDPOINT_KEY_VAR);
	return view();
}