/**
 * The custom OpenAI-compatible endpoint's IDENTITY (fork addition) — pure
 * core facts, browser-safe.
 *
 * They live in core rather than beside the provider code (src/agent/
 * custom-endpoint.ts) because three layers need them and only core is
 * importable by all of them: the agent layer builds the provider, the
 * server layer keys rows and the catalog by them, the shell reads the id
 * off the /api/models + /api/keys payloads. The agent module re-exports
 * these two so its own consumers keep one import site.
 */

/** pi-ai provider id for the user's endpoint (fixed — one endpoint per app). */
export const CUSTOM_PROVIDER_ID = "custom";
/** Human label (the provider-picker row, the error copy). */
export const CUSTOM_PROVIDER_LABEL = "Custom endpoint";
/** The keys-seam env var the endpoint's key rides in. */
export const CUSTOM_ENDPOINT_KEY_VAR = "CUSTOM_ENDPOINT_API_KEY";
