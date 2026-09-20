import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8')

describe('Supabase backup safety', () => {
  it('publishes only validated, checksummed, complete database and Storage backups atomically', () => {
    const backup = read('ops', 'supabase', 'backup.sh')

    expect(backup).toContain('.partial.')
    expect(backup).toContain('trap cleanup')
    expect(backup).toMatch(/pg_restore[^\n]*--list/)
    expect(backup).toContain('sha256sum -c SHA256SUMS')
    expect(backup).toContain('storage.tar.gz')
    expect(backup).toContain('.complete')
    expect(backup).toMatch(/mv[^\n]*work_directory[^\n]*destination/)
  })

  it('prevents overlapping scheduled runs and retains only completed backup directories', () => {
    const scheduled = read('ops', 'supabase', 'scheduled-backup.sh')

    expect(scheduled).toContain('flock -n')
    expect(scheduled).toContain('.backup.lock')
    expect(scheduled).toContain('.complete')
    expect(scheduled).not.toMatch(/find[^\n]*-exec rm -rf/)
  })

  it('never reseeds during migration and requires two explicit destructive seed confirmations', () => {
    const migrate = read('ops', 'supabase', 'migrate.sh')
    const seed = read('ops', 'supabase', 'seed.sh')

    expect(migrate).not.toContain('supabase/seed.sql')
    expect(migrate).not.toContain('TRUNCATE')
    expect(seed).toContain('--i-understand-this-replaces-data')
    expect(seed).toContain('ASADOS_ALLOW_DESTRUCTIVE_RESEED')
    expect(seed).toContain('YES_REPLACE_DATA')
    expect(seed).toContain('supabase/seed.sql')
  })
})

  it('creates a self-contained full database archive without schema filtering', () => {
    const backup = read('ops', 'supabase', 'backup.sh')

    expect(backup).not.toContain('--schema=')
    expect(backup).toMatch(/pg_dump[^\n]*--format=custom/)
  })

  it('provides a disposable restore drill with exact identity selectors and guaranteed cleanup', () => {
    const drill = read('ops', 'supabase', 'verify-backup-restore.sh')

    expect(drill).toContain('createdb')
    expect(drill).toContain('template0')
    expect(drill).toContain('pg_restore')
    expect(drill).toContain('dropdb')
    expect(drill).toContain('trap cleanup')
    expect(drill).toContain('auth.users')
    expect(drill).toContain('public.clientes')
    expect(drill).toContain('--email')
    expect(drill).toContain('--phone')
    expect(drill).not.toContain('--clean')
  })

  it('accepts identity flags before the final backup directory argument', () => {
    const result = spawnSync(join(root, 'ops', 'supabase', 'verify-backup-restore.sh'), [
      '--email', 'admin@crmsofiamanager.com.br',
      '--phone', '5541988888888',
      '/definitely/missing/backup',
    ], { encoding: 'utf8' })

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('/definitely/missing/backup')
    expect(result.stderr).not.toContain('cd to --email')
  })
