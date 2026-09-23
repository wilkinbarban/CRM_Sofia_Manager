export const CANONICAL_NOTIFICATION_SOUND_KEY = 'crm_notificacoes_som'
export const LEGACY_NOTIFICATION_SOUND_KEY = 'asados_notificacoes_som'
export const CANONICAL_SOUND_PREFERENCE_KEY = CANONICAL_NOTIFICATION_SOUND_KEY
export const LEGACY_SOUND_PREFERENCE_KEY = LEGACY_NOTIFICATION_SOUND_KEY
export const DEFAULT_NOTIFICATION_SOUND_ENABLED = true
export const DEFAULT_SOUND_PREFERENCE = DEFAULT_NOTIFICATION_SOUND_ENABLED

export type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function resolveStorage(customStorage?: StorageLike | null): StorageLike | null {
  if (customStorage !== undefined) {
    return customStorage
  }
  if (typeof window === 'undefined') {
    return null
  }
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

/**
 * Browser-safe, migration-aware reader for the notification sound preference.
 *
 * Contract:
 * - Canonical key: `crm_notificacoes_som`
 * - Uses legacy `asados_notificacoes_som` ONLY when canonical key is absent (null/undefined).
 * - Migrates only valid boolean string values ("true" / "false") into the canonical key.
 * - Leaves legacy key read-only (untouched in storage).
 * - Default behavior remains sound enabled (true) when neither valid value exists.
 * - Safely handles environments without window/localStorage (SSR) or storage access errors.
 */
export function getNotificationSoundPreference(storage?: StorageLike | null): boolean {
  const s = resolveStorage(storage)
  if (!s) {
    return DEFAULT_NOTIFICATION_SOUND_ENABLED
  }

  let canonicalRaw: string | null = null
  try {
    canonicalRaw = s.getItem(CANONICAL_NOTIFICATION_SOUND_KEY)
  } catch {
    return DEFAULT_NOTIFICATION_SOUND_ENABLED
  }

  // Canonical key is present
  if (canonicalRaw !== null && canonicalRaw !== undefined) {
    if (canonicalRaw === 'true') {
      return true
    }
    if (canonicalRaw === 'false') {
      return false
    }
    // Present but malformed: neither valid value exists -> default enabled
    return DEFAULT_NOTIFICATION_SOUND_ENABLED
  }

  // Canonical key is absent: inspect legacy key for migration
  let legacyRaw: string | null = null
  try {
    legacyRaw = s.getItem(LEGACY_NOTIFICATION_SOUND_KEY)
  } catch {
    return DEFAULT_NOTIFICATION_SOUND_ENABLED
  }

  if (legacyRaw === 'true' || legacyRaw === 'false') {
    try {
      s.setItem(CANONICAL_NOTIFICATION_SOUND_KEY, legacyRaw)
    } catch {
      // Browser-safe fallback if writing fails (e.g. quota exceeded)
    }
    return legacyRaw === 'true'
  }

  // Neither valid value exists
  return DEFAULT_NOTIFICATION_SOUND_ENABLED
}

export const readNotificationSoundPreference = getNotificationSoundPreference
export const isNotificationSoundEnabled = getNotificationSoundPreference

/**
 * Browser-safe writer for notification sound preference.
 * Writes exclusively to the canonical storage key.
 */
export function setNotificationSoundPreference(
  enabled: boolean,
  storage?: StorageLike | null,
): void {
  const s = resolveStorage(storage)
  if (!s) {
    return
  }

  try {
    s.setItem(CANONICAL_NOTIFICATION_SOUND_KEY, String(enabled))
  } catch {
    // Browser-safe: ignore write failures in sandboxes or quota exceeded
  }
}
