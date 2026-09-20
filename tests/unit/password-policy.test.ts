import { describe, expect, it } from 'vitest'
import { validatePasswordPolicy, PASSWORD_POLICY_REQUIREMENTS } from '@/lib/auth/password-policy'

describe('Password Policy Enforcement', () => {
  it('accepts passwords meeting all complexity criteria', () => {
    expect(validatePasswordPolicy('Sofia2026!')).toEqual({ valid: true })
    expect(validatePasswordPolicy('SegredoForte1')).toEqual({ valid: true })
    expect(validatePasswordPolicy('P@ssw0rd99')).toEqual({ valid: true })
  })

  it('rejects passwords shorter than 8 characters', () => {
    const result = validatePasswordPolicy('Asad1!')
    expect(result.valid).toBe(false)
    expect(result.errors).toContain(PASSWORD_POLICY_REQUIREMENTS.minLength)
  })

  it('rejects passwords without uppercase letters', () => {
    const result = validatePasswordPolicy('sofia2026!')
    expect(result.valid).toBe(false)
    expect(result.errors).toContain(PASSWORD_POLICY_REQUIREMENTS.uppercase)
  })

  it('rejects passwords without lowercase letters', () => {
    const result = validatePasswordPolicy('SOFIA2026!')
    expect(result.valid).toBe(false)
    expect(result.errors).toContain(PASSWORD_POLICY_REQUIREMENTS.lowercase)
  })

  it('rejects passwords without numeric digits', () => {
    const result = validatePasswordPolicy('SofiaChurrasco!')
    expect(result.valid).toBe(false)
    expect(result.errors).toContain(PASSWORD_POLICY_REQUIREMENTS.number)
  })

  it('rejects empty or null passwords gracefully', () => {
    expect(validatePasswordPolicy('')).toEqual({
      valid: false,
      errors: expect.any(Array)
    })
    expect(validatePasswordPolicy(null as any)).toEqual({
      valid: false,
      errors: expect.any(Array)
    })
  })
})
