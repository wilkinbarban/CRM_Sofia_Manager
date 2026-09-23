import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CANONICAL_NOTIFICATION_SOUND_KEY,
  CANONICAL_SOUND_PREFERENCE_KEY,
  DEFAULT_NOTIFICATION_SOUND_ENABLED,
  DEFAULT_SOUND_PREFERENCE,
  getNotificationSoundPreference,
  isNotificationSoundEnabled,
  LEGACY_NOTIFICATION_SOUND_KEY,
  LEGACY_SOUND_PREFERENCE_KEY,
  readNotificationSoundPreference,
  setNotificationSoundPreference,
  type StorageLike,
} from '@/lib/notifications/sound-preference'

describe('sound-preference notification reader & migration', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  afterEach(() => {
    localStorage.clear()
    vi.restoreAllMocks()
  })

  describe('constants contract', () => {
    it('defines canonical and legacy storage keys correctly', () => {
      expect(CANONICAL_NOTIFICATION_SOUND_KEY).toBe('crm_notificacoes_som')
      expect(LEGACY_NOTIFICATION_SOUND_KEY).toBe('asados_notificacoes_som')
      expect(CANONICAL_SOUND_PREFERENCE_KEY).toBe('crm_notificacoes_som')
      expect(LEGACY_SOUND_PREFERENCE_KEY).toBe('asados_notificacoes_som')
      expect(DEFAULT_NOTIFICATION_SOUND_ENABLED).toBe(true)
      expect(DEFAULT_SOUND_PREFERENCE).toBe(true)
    })
  })

  describe('legacy migration', () => {
    it('migrates legacy muted ("false") into canonical key and leaves legacy key read-only', () => {
      localStorage.setItem('asados_notificacoes_som', 'false')

      const result = getNotificationSoundPreference()

      expect(result).toBe(false)
      expect(localStorage.getItem('crm_notificacoes_som')).toBe('false')
      expect(localStorage.getItem('asados_notificacoes_som')).toBe('false')
    })

    it('migrates legacy enabled ("true") into canonical key and leaves legacy key read-only', () => {
      localStorage.setItem('asados_notificacoes_som', 'true')

      const result = getNotificationSoundPreference()

      expect(result).toBe(true)
      expect(localStorage.getItem('crm_notificacoes_som')).toBe('true')
      expect(localStorage.getItem('asados_notificacoes_som')).toBe('true')
    })
  })

  describe('existing canonical precedence', () => {
    it('uses existing canonical muted ("false") and ignores legacy enabled ("true")', () => {
      localStorage.setItem('crm_notificacoes_som', 'false')
      localStorage.setItem('asados_notificacoes_som', 'true')

      const result = getNotificationSoundPreference()

      expect(result).toBe(false)
      expect(localStorage.getItem('crm_notificacoes_som')).toBe('false')
      expect(localStorage.getItem('asados_notificacoes_som')).toBe('true')
    })

    it('uses existing canonical enabled ("true") and ignores legacy muted ("false")', () => {
      localStorage.setItem('crm_notificacoes_som', 'true')
      localStorage.setItem('asados_notificacoes_som', 'false')

      const result = getNotificationSoundPreference()

      expect(result).toBe(true)
      expect(localStorage.getItem('crm_notificacoes_som')).toBe('true')
      expect(localStorage.getItem('asados_notificacoes_som')).toBe('false')
    })
  })

  describe('absent values', () => {
    it('returns default sound enabled (true) when neither canonical nor legacy exists', () => {
      const result = getNotificationSoundPreference()

      expect(result).toBe(true)
      expect(localStorage.getItem('crm_notificacoes_som')).toBeNull()
      expect(localStorage.getItem('asados_notificacoes_som')).toBeNull()
    })
  })

  describe('malformed values', () => {
    const malformedCases = [
      { name: 'arbitrary string', value: 'random_text' },
      { name: 'empty string', value: '' },
      { name: 'numeric zero', value: '0' },
      { name: 'numeric one', value: '1' },
      { name: 'uppercase TRUE', value: 'TRUE' },
      { name: 'uppercase FALSE', value: 'FALSE' },
      { name: 'stringified null', value: 'null' },
      { name: 'stringified undefined', value: 'undefined' },
      { name: 'whitespace', value: '   ' },
    ]

    for (const { name, value } of malformedCases) {
      it(`does not migrate malformed legacy value (${name}: "${value}") and returns default enabled (true)`, () => {
        localStorage.setItem('asados_notificacoes_som', value)

        const result = getNotificationSoundPreference()

        expect(result).toBe(true)
        expect(localStorage.getItem('crm_notificacoes_som')).toBeNull()
        expect(localStorage.getItem('asados_notificacoes_som')).toBe(value)
      })
    }

    it('returns default enabled (true) when canonical is malformed without falling back to legacy', () => {
      localStorage.setItem('crm_notificacoes_som', 'corrupt_value')
      localStorage.setItem('asados_notificacoes_som', 'false')

      const result = getNotificationSoundPreference()

      expect(result).toBe(true)
      expect(localStorage.getItem('crm_notificacoes_som')).toBe('corrupt_value')
      expect(localStorage.getItem('asados_notificacoes_som')).toBe('false')
    })

    it('returns default enabled (true) when canonical is empty string without falling back to legacy', () => {
      localStorage.setItem('crm_notificacoes_som', '')
      localStorage.setItem('asados_notificacoes_som', 'false')

      const result = getNotificationSoundPreference()

      expect(result).toBe(true)
      expect(localStorage.getItem('crm_notificacoes_som')).toBe('')
      expect(localStorage.getItem('asados_notificacoes_som')).toBe('false')
    })
  })

  describe('browser safety and resilience', () => {
    it('returns default true when storage is null (SSR environment simulation)', () => {
      expect(getNotificationSoundPreference(null)).toBe(true)
    })

    it('handles storage.getItem throwing SecurityError gracefully', () => {
      const failingStorage: StorageLike = {
        getItem: vi.fn().mockImplementation(() => {
          throw new Error('SecurityError: Access is denied')
        }),
        setItem: vi.fn(),
      }

      expect(getNotificationSoundPreference(failingStorage)).toBe(true)
    })

    it('handles storage.setItem throwing QuotaExceededError during migration without crashing', () => {
      const storageState = new Map<string, string>()
      storageState.set('asados_notificacoes_som', 'false')

      const failingSetStorage: StorageLike = {
        getItem: vi.fn((key: string) => storageState.get(key) ?? null),
        setItem: vi.fn(() => {
          throw new Error('QuotaExceededError')
        }),
      }

      const result = getNotificationSoundPreference(failingSetStorage)

      expect(result).toBe(false)
      expect(failingSetStorage.setItem).toHaveBeenCalledWith('crm_notificacoes_som', 'false')
    })

    it('safely handles setNotificationSoundPreference writing to canonical key', () => {
      setNotificationSoundPreference(false)
      expect(localStorage.getItem('crm_notificacoes_som')).toBe('false')

      setNotificationSoundPreference(true)
      expect(localStorage.getItem('crm_notificacoes_som')).toBe('true')
    })

    it('safely ignores write failure in setNotificationSoundPreference', () => {
      const failingStorage: StorageLike = {
        getItem: vi.fn().mockReturnValue(null),
        setItem: vi.fn(() => {
          throw new Error('Storage write failed')
        }),
      }

      expect(() => setNotificationSoundPreference(false, failingStorage)).not.toThrow()
    })
  })

  describe('api aliases parity', () => {
    it('readNotificationSoundPreference and isNotificationSoundEnabled behave identically', () => {
      localStorage.setItem('asados_notificacoes_som', 'false')

      expect(readNotificationSoundPreference()).toBe(false)
      expect(isNotificationSoundEnabled()).toBe(false)
    })
  })
})
