"use client";
/**
 * Settings → Providers → Custom endpoint (fork addition): the user's own
 * OpenAI-compatible LLM router (llmrouter, LiteLLM, vLLM, Ollama, any
 * gateway speaking /chat/completions). Once the URL verifies, its models
 * federate into every model picker as the `custom` provider.
 *
 * The section is one small form: base URL, API key, Connect. Saving
 * fetches {base}/models with the key — a wrong URL or key fails HERE, with
 * the endpoint's own answer, and nothing is stored. Re-connecting with the
 * URL only re-runs discovery against the key already saved (that is how you
 * pick up new models); Disconnect clears both.
 */

import { useCallback, useEffect, useState } from "react";
import { SettingsSection } from "./controls.tsx";

interface EndpointView {
	baseUrl: string;
	models: { id: string; name: string }[];
	contextWindows: Record<string, number>;
	maxOutputs: Record<string, number>;
	keyPresent: boolean;
}

const INPUT = "w-full rounded border border-border bg-background px-2 py-1 font-mono text-xs text-foreground outline-none focus:border-foreground/40";

export function CustomEndpointSection() {
	const [view, setView] = useState<EndpointView | null>(null);
	const [url, setUrl] = useState("");
	const [key, setKey] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);
	/** Draft per-model windows: a string while typing, so the field can be
	 *  emptied; saved as numbers. */
	const [windows, setWindows] = useState<Record<string, string>>({});
	const [outputs, setOutputs] = useState<Record<string, string>>({});
	const [windowError, setWindowError] = useState<string | null>(null);
	const [windowSaved, setWindowSaved] = useState<string | null>(null);

	const load = useCallback(() => {
		fetch("/api/custom-endpoint")
			.then((r) => (r.ok ? r.json() : null))
			.then((b: EndpointView | null) => {
				if (!b) return;
				setView(b);
				setUrl((current) => current || b.baseUrl);
				setWindows(Object.fromEntries(b.models.map((m) => [m.id, b.contextWindows?.[m.id] ? String(b.contextWindows[m.id]) : ""])));
				setOutputs(Object.fromEntries(b.models.map((m) => [m.id, b.maxOutputs?.[m.id] !== undefined ? String(b.maxOutputs[m.id]) : ""])));
			})
			.catch(() => undefined);
	}, []);
	useEffect(load, [load]);

	async function connect() {
		setBusy(true);
		setError(null);
		setSaved(false);
		try {
			const res = await fetch("/api/custom-endpoint", {
				method: "PUT",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ baseUrl: url, ...(key.trim() ? { apiKey: key.trim() } : {}) }),
			});
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			if (!res.ok) {
				setError(body.error ?? `request failed (${res.status})`);
				return;
			}
			setKey("");
			setSaved(true);
			load();
		} catch {
			setError("could not reach the app server");
		} finally {
			setBusy(false);
		}
	}

	/** Save ONE model's row — window and reply cap together (PATCH never
	 *  re-runs discovery). Blank clears; a 0 cap means no limit. */
	async function saveRow(id: string) {
		setWindowError(null);
		setWindowSaved(null);
		// Merge the rest in so saving one row cannot clear the others.
		const map = (draft: Record<string, string>) =>
			Object.fromEntries(Object.entries(draft).map(([k, v]) => [k, v.trim() ? Number(v) : null]));
		try {
			const res = await fetch("/api/custom-endpoint", {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ contextWindows: map(windows), maxOutputs: map(outputs) }),
			});
			const body = (await res.json().catch(() => ({}))) as { error?: string };
			if (!res.ok) {
				setWindowError(body.error ?? `request failed (${res.status})`);
				return;
			}
			setWindowSaved(id);
			load();
		} catch {
			setWindowError("could not reach the app server");
		}
	}

	async function disconnect() {
		setBusy(true);
		setError(null);
		await fetch("/api/custom-endpoint", { method: "DELETE" }).catch(() => undefined);
		setKey("");
		setSaved(false);
		load();
		setBusy(false);
	}

	const connected = Boolean(view?.baseUrl && view.models.length);

	return (
		<SettingsSection
			title="Custom endpoint"
			hint="Any OpenAI-compatible URL (your LLM router, LiteLLM, vLLM, Ollama). Its models appear in every model picker as “Custom endpoint”."
			testid="settings-custom-endpoint"
		>
			<label className="flex flex-col gap-1">
				<span className="text-xs text-muted-foreground">Base URL</span>
				<input
					className={INPUT}
					data-testid="custom-endpoint-url"
					value={url}
					onChange={(e) => setUrl(e.target.value)}
					placeholder="https://llmrouter.boyemma.com/v1"
					spellCheck={false}
					disabled={busy}
				/>
			</label>
			<label className="flex flex-col gap-1">
				<span className="text-xs text-muted-foreground">API key{view?.keyPresent ? " (already saved — leave blank to reuse)" : ""}</span>
				<input
					className={INPUT}
					data-testid="custom-endpoint-key"
					type="password"
					value={key}
					onChange={(e) => setKey(e.target.value)}
					placeholder={view?.keyPresent ? "••••••••" : "sk-…"}
					spellCheck={false}
					autoComplete="off"
					disabled={busy}
				/>
			</label>
			<div className="flex items-center gap-2">
				<button
					type="button"
					data-testid="custom-endpoint-connect"
					onClick={() => void connect()}
					disabled={busy || !url.trim()}
					className="rounded border border-border px-3 py-1 text-xs hover:bg-foreground/5 disabled:opacity-50"
				>
					{busy ? "Checking…" : connected ? "Re-check & save" : "Connect"}
				</button>
				{connected && (
					<button type="button" onClick={() => void disconnect()} disabled={busy} className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50">
						Disconnect
					</button>
				)}
			</div>
			{error && <p data-testid="custom-endpoint-error" className="text-xs text-red-500">{error}</p>}
			{saved && !error && <p className="text-xs text-muted-foreground">Connected — the models are in your pickers now.</p>}
			{connected && (
				<>
					<p data-testid="custom-endpoint-models" className="text-xs text-muted-foreground">
						{view!.models.length} model{view!.models.length === 1 ? "" : "s"} available from this endpoint.
					</p>
					<div className="flex flex-col gap-1">
						<span className="text-xs text-muted-foreground">
							Context window per model — leave blank to use what the endpoint reports (or the app’s 128k default when it reports nothing).
						</span>
						{view!.models.map((model) => (
							<div key={model.id} className="flex items-center gap-2">
								<span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground">{model.name}</span>
								<input
									className={`${INPUT} w-28`}
									data-testid={`custom-endpoint-window-${model.id}`}
									inputMode="numeric"
									aria-label={`${model.name} context window`}
									value={windows[model.id] ?? ""}
									onChange={(e) => setWindows((prev) => ({ ...prev, [model.id]: e.target.value.replace(/[^0-9]/g, "") }))}
									placeholder="128000"
									disabled={busy}
								/>
								<input
									className={`${INPUT} w-24`}
									data-testid={`custom-endpoint-output-${model.id}`}
									inputMode="numeric"
									aria-label={`${model.name} reply cap`}
									value={outputs[model.id] ?? ""}
									onChange={(e) => setOutputs((prev) => ({ ...prev, [model.id]: e.target.value.replace(/[^0-9]/g, "") }))}
									placeholder="8192"
									disabled={busy}
								/>
								<button
									type="button"
									data-testid={`custom-endpoint-window-save-${model.id}`}
									onClick={() => void saveRow(model.id)}
									disabled={
										busy ||
										((windows[model.id] ?? "") === String(view!.contextWindows?.[model.id] ?? "") &&
											(outputs[model.id] ?? "") === String(view!.maxOutputs?.[model.id] ?? ""))
									}
									className="rounded border border-border px-2 py-1 text-xs hover:bg-foreground/5 disabled:opacity-40"
								>
									Save
								</button>
								{windowSaved === model.id && <span className="text-xs text-muted-foreground">Saved</span>}
							</div>
						))}
						<span className="text-xs text-muted-foreground">
							Second box is the reply cap (<span className="font-mono">max_tokens</span>) — leave blank for the default (window-bounded, 8192), or <span className="font-mono">0</span> for no limit.
						</span>
						{windowError && (
							<p data-testid="custom-endpoint-window-error" className="text-xs text-red-500">
								{windowError}
							</p>
						)}
					</div>
				</>
			)}
		</SettingsSection>
	);
}