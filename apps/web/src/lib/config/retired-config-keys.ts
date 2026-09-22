/**
 * Configuration keys owned by providers this system no longer talks to
 * (OpenRouter, OmniRoute).
 *
 * The retired provider was removed from every runtime path: no adapter reads
 * it, no action probes it and no UI renders it. This module is the single home
 * for the rule that keeps it retired, on both edges of the configuration
 * lifecycle:
 *
 * - the write edge (`salvarConfiguracaoAdmin`) refuses to persist a key that
 *   names a retired provider, so a new legacy row cannot be created even by an
 *   operator whose dashboard still has the old form cached;
 * - the server-to-client projection on `/atendimento/admin` drops such a key,
 *   secret or not, so a legacy or restored `configuracoes_sistema` row cannot
 *   put the retired provider back in front of the operator.
 *
 * The retirement check is independent of the secret-shaped pattern
 * (`_KEY`/`_TOKEN`/`_SECRET`): a retired non-secret key such as
 * `OPENROUTER_MODEL` or `OMNIROUTE_BASE_URL` would otherwise flow straight to
 * the client.
 */

/** Keys naming a retired provider, matched case-insensitively by name only. */
export const RETIRED_PROVIDER_CONFIG_KEY_PATTERN = /(OPENROUTER|OMNIROUTE)/i

/** Single predicate over a configuration key name; the one place the rule lives. */
export function isRetiredProviderConfigKey(key: string): boolean {
  return RETIRED_PROVIDER_CONFIG_KEY_PATTERN.test(key)
}

/**
 * Keys already reported in this process. Refusing the row is a per-render
 * decision, but the operator only needs the signal once: a legacy row restored
 * in `configuracoes_sistema` would otherwise warn on every render of the
 * dashboard.
 */
const warnedRetiredProviderKeys = new Set<string>()

/**
 * Reports, once per key per process, that a stored configuration row naming a
 * retired provider is being hidden. The operator gets a migration signal
 * (`delete the row`) without the render path flooding the logs.
 */
export function warnRetiredProviderConfigKeyOnce(key: string): void {
  if (warnedRetiredProviderKeys.has(key)) return

  warnedRetiredProviderKeys.add(key)
  console.warn(
    `[Config] Ignoring configuration key "${key}": it names a retired provider this system no longer ` +
      'talks to. Remove its `configuracoes_sistema` row to finish the migration.',
  )
}

/** Test-only reset for the once-per-process warning state, mirroring `resetLlmCreditStatusCacheForTests`. */
export function resetRetiredProviderConfigKeyWarningsForTests(): void {
  warnedRetiredProviderKeys.clear()
}
