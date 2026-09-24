import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'

const root = process.cwd()
const runnerPath = join(root, 'scripts/run-selfhost-supabase-tests.sh')
const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }

function withTempRepo(
  callback: (context: {
    tempDir: string
    mainRepo: string
    linkedWorktree: string
    fakeBinDir: string
    dockerLog: string
  }) => void,
  options: { mainRepoName?: string } = {},
) {
  const tempDir = mkdtempSync(join(tmpdir(), 'selfhost-runner-test-'))
  const mainRepo = join(tempDir, options.mainRepoName ?? 'main-repo')
  const linkedWorktree = join(tempDir, 'linked-wt')
  const fakeBinDir = join(tempDir, 'bin')
  const dockerLog = join(tempDir, 'docker.log')

  try {
    mkdirSync(join(mainRepo, 'ops/supabase'), { recursive: true })
    mkdirSync(join(mainRepo, 'scripts'), { recursive: true })
    mkdirSync(join(mainRepo, 'supabase/tests'), { recursive: true })
    mkdirSync(fakeBinDir, { recursive: true })

    const runnerContent = readFileSync(runnerPath, 'utf8')
    writeFileSync(join(mainRepo, 'scripts/run-selfhost-supabase-tests.sh'), runnerContent)
    chmodSync(join(mainRepo, 'scripts/run-selfhost-supabase-tests.sh'), 0o755)

    writeFileSync(join(mainRepo, 'ops/supabase/docker-compose.yml'), 'services:\n  db:\n    image: postgres:15\n')
    writeFileSync(join(mainRepo, 'supabase/tests/dummy.sql'), 'SELECT 1;\n')
    writeFileSync(join(mainRepo, '.gitignore'), 'ops/supabase/.env\n')

    execFileSync('git', ['init', '-b', 'main', mainRepo])
    execFileSync('git', ['-C', mainRepo, 'config', 'user.name', 'Test'])
    execFileSync('git', ['-C', mainRepo, 'config', 'user.email', 'test@example.com'])
    execFileSync('git', ['-C', mainRepo, 'add', '.'])
    execFileSync('git', ['-C', mainRepo, 'commit', '-m', 'init'])

    execFileSync('git', ['-C', mainRepo, 'worktree', 'add', linkedWorktree, '-b', 'branch-wt'])

    // Default stub docker with strict subcommand and argument boundary handling
    const fakeDocker = join(fakeBinDir, 'docker')
    writeFileSync(fakeDocker, `#!/bin/sh
echo "$@" >> "${dockerLog}"
subcmd="$1"
shift || true

case "$subcmd" in
  compose)
    compose_action=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --env-file|-f)
          shift 2 || shift $#
          ;;
        --env-file=*|-f=*)
          shift
          ;;
        config|ps|exec|up|down)
          compose_action="$1"
          shift
          break
          ;;
        *)
          shift
          ;;
      esac
    done

    case "$compose_action" in
      config)
        exit 0
        ;;
      ps)
        if [ "\${FAKE_DOCKER_DB_DOWN:-0}" = "1" ]; then
          exit 0
        fi
        echo "db running"
        exit 0
        ;;
      exec)
        exit 0
        ;;
      *)
        exit 0
        ;;
    esac
    ;;

  inspect)
    if [ "\${FAKE_DOCKER_CONTAINER_STOPPED:-0}" = "1" ]; then
      echo "false"
    else
      echo "true"
    fi
    exit 0
    ;;

  exec)
    is_pgtap=0
    for arg in "$@"; do
      case "$arg" in
        *"extname = 'pgtap'"*|*"pgtap"*)
          is_pgtap=1
          ;;
      esac
    done

    if [ "$is_pgtap" = "1" ]; then
      if [ "\${FAKE_DOCKER_NO_PGTAP:-0}" = "1" ]; then
        echo "0"
      else
        echo "1"
      fi
    fi
    exit 0
    ;;

  cp)
    exit 0
    ;;

  *)
    exit 1
    ;;
esac
`)
    chmodSync(fakeDocker, 0o755)

    callback({ tempDir, mainRepo, linkedWorktree, fakeBinDir, dockerLog })
  } finally {
    rmSync(tempDir, { recursive: true, force: true })
  }
}

describe('self-hosted Supabase SQL test runner', () => {
  it('provides an explicit self-hosted route without replacing the official local CLI command', () => {
    expect(existsSync(runnerPath)).toBe(true)
    expect(packageJson.scripts['supabase:test']).toBe('supabase test db')
    expect(packageJson.scripts['selfhost:test:db']).toBe('scripts/run-selfhost-supabase-tests.sh')
  })

  it('uses the canonical compose service and disposable test database without the CLI container name', () => {
    const runner = readFileSync(runnerPath, 'utf8')
    expect(runner).toContain('asados-supabase-db')
    expect(runner).toContain('createdb -U postgres "$database"')
    expect(runner).toContain('--exclude-schema=realtime')
    expect(runner).toContain('dropdb -U supabase_admin --if-exists --force "$database"')
    expect(runner).toContain('docker cp "$root/supabase/." "$container:$workspace"')
    expect(runner).toContain('encodeURIComponent')
    expect(runner).toContain('postgresql://supabase_admin:${postgres_password_uri}@127.0.0.1:5432/${database}')
    expect(runner).toContain('-v "runtime_dblink_conninfo=$conninfo"')
    expect(runner).toContain('psql -qX -U supabase_admin -d "$database"')
    expect(runner).not.toContain('-v "dblink_password=')
    expect(runner).not.toContain('set app.runtime_dblink_conninfo')
    expect(runner).toContain('Only files under supabase/tests may be run')
    expect(runner).not.toContain('supabase_db_Asados')
  })

  it('creates, restores, and drops a uniquely named database for each selected test', () => {
    const runner = readFileSync(runnerPath, 'utf8')
    const helperStart = runner.indexOf('run_test() {')
    const helperEnd = runner.indexOf('\n}', helperStart)
    const helper = runner.slice(helperStart, helperEnd)
    const loopStart = runner.indexOf('for test_file in "$@"; do')
    const loop = runner.slice(loopStart)

    expect(helperStart).toBeGreaterThan(-1)
    expect(helper).toContain('database="asados_sql_test_$$_$test_number"')
    expect(helper).toContain('createdb -U postgres "$database"')
    expect(helper).toContain("pg_restore -U supabase_admin -d '$database' --exit-on-error")
    expect(helper).toContain('postgresql://supabase_admin:${postgres_password_uri}@127.0.0.1:5432/${database}')
    expect(helper).toContain('psql -qX -U supabase_admin -d "$database"')
    expect(helper).toContain('cleanup_database')
    expect(loop).toContain('run_test "$test_file"')
    expect(runner.indexOf('docker cp "$root/supabase/." "$container:$workspace"')).toBeLessThan(loopStart)
    expect(runner).toContain('[ -z "$database" ] || docker exec "$container" dropdb')
    expect(runner).toContain('trap cleanup EXIT')
    expect(runner).toContain("trap 'cleanup; trap - EXIT; exit 129' HUP")
    expect(runner).toContain("trap 'cleanup; trap - EXIT; exit 130' INT")
    expect(runner).toContain("trap 'cleanup; trap - EXIT; exit 143' TERM")
    expect(runner).toContain('database=')
  })

  it('enforces static script invariants for POSIX safety, env-file flags, and zero worktree mutations', () => {
    const runner = readFileSync(runnerPath, 'utf8')

    // POSIX shell header and fail-closed flags
    expect(runner.startsWith('#!/bin/sh\nset -eu\n')).toBe(true)

    // Git discovery mechanisms
    expect(runner).toContain('git -C "$root" rev-parse --git-common-dir')
    expect(runner).toContain('git -C "$root" worktree list --porcelain')

    // Passes selected --env-file to every docker compose invocation
    const composeInvocations = runner
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('docker compose'))
    expect(composeInvocations.length).toBe(3)
    for (const invocation of composeInvocations) {
      expect(invocation).toContain('--env-file "$env_file"')
    }

    // Never copies, links, or mutates .env into the worktree
    expect(runner).not.toMatch(/cp\s+.*\.env/)
    expect(runner).not.toMatch(/ln\s+.*\.env/)
    expect(runner).not.toMatch(/symlink/i)

    // Diagnoses missing environment and missing password with exact parameters
    expect(runner).toContain('Missing self-hosted Supabase environment file.')
    expect(runner).toContain('Checked paths:')
    expect(runner).toContain('(cd ops/supabase && ./generate-env.sh)')
    expect(runner).toContain('Missing POSTGRES_PASSWORD in $env_file')
    expect(runner).toContain('Self-hosted Supabase db service is not running. Start it with: (cd $remediation_dir && docker compose up -d)')
  })

  it('automatically discovers canonical checkout .env from linked worktrees without copying or symlinking', () => {
    withTempRepo(({ mainRepo, linkedWorktree, fakeBinDir, dockerLog }) => {
      // Create canonical .env only
      writeFileSync(join(mainRepo, 'ops/supabase/.env'), 'POSTGRES_PASSWORD=canonical_secret_pw\n')

      const env = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` }
      const res = spawnSync('sh', [join(linkedWorktree, 'scripts/run-selfhost-supabase-tests.sh')], {
        env,
        encoding: 'utf8',
      })

      expect(res.status).toBe(0)

      // Verified: .env is never copied or symlinked into the linked worktree
      expect(existsSync(join(linkedWorktree, 'ops/supabase/.env'))).toBe(false)

      // Verified: docker compose received --env-file pointing to canonical checkout
      const log = readFileSync(dockerLog, 'utf8')
      const canonicalEnvPath = join(mainRepo, 'ops/supabase/.env')
      expect(log).toContain(`compose --env-file ${canonicalEnvPath}`)
      expect(log).toContain('runtime_dblink_conninfo=postgresql://supabase_admin:canonical_secret_pw@127.0.0.1:5432/')
    })
  })

  it('falls back to worktree list --porcelain when git common-dir discovery fails', () => {
    withTempRepo(({ mainRepo, linkedWorktree, fakeBinDir, dockerLog }) => {
      writeFileSync(join(mainRepo, 'ops/supabase/.env'), 'POSTGRES_PASSWORD=fallback_secret_pw\n')

      // Stub git that fails rev-parse --git-common-dir but delegates all other commands
      const fakeGit = join(fakeBinDir, 'git')
      writeFileSync(fakeGit, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "--git-common-dir" ]; then
    exit 1
  fi
done
exec /usr/bin/git "$@"
`)
      chmodSync(fakeGit, 0o755)

      const env = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` }
      const res = spawnSync('sh', [join(linkedWorktree, 'scripts/run-selfhost-supabase-tests.sh')], {
        env,
        encoding: 'utf8',
      })

      expect(res.status).toBe(0)
      expect(existsSync(join(linkedWorktree, 'ops/supabase/.env'))).toBe(false)

      const log = readFileSync(dockerLog, 'utf8')
      const canonicalEnvPath = join(mainRepo, 'ops/supabase/.env')
      expect(log).toContain(`compose --env-file ${canonicalEnvPath}`)
      expect(log).toContain('runtime_dblink_conninfo=postgresql://supabase_admin:fallback_secret_pw@127.0.0.1:5432/')
    })
  })

  it('prefers local ops/supabase/.env when present in the worktree', () => {
    withTempRepo(({ mainRepo, linkedWorktree, fakeBinDir, dockerLog }) => {
      writeFileSync(join(mainRepo, 'ops/supabase/.env'), 'POSTGRES_PASSWORD=canonical_pw\n')
      writeFileSync(join(linkedWorktree, 'ops/supabase/.env'), 'POSTGRES_PASSWORD=local_wt_pw\n')

      const env = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` }
      const res = spawnSync('sh', [join(linkedWorktree, 'scripts/run-selfhost-supabase-tests.sh')], {
        env,
        encoding: 'utf8',
      })

      expect(res.status).toBe(0)
      const log = readFileSync(dockerLog, 'utf8')
      const localEnvPath = join(linkedWorktree, 'ops/supabase/.env')
      expect(log).toContain(`compose --env-file ${localEnvPath}`)
      expect(log).toContain('runtime_dblink_conninfo=postgresql://supabase_admin:local_wt_pw@127.0.0.1:5432/')
    })
  })

  it('diagnoses missing environment by listing checked paths and the canonical generate-env.sh remediation', () => {
    withTempRepo(({ mainRepo, linkedWorktree, fakeBinDir }) => {
      // Neither mainRepo nor linkedWorktree has .env
      const env = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` }
      const res = spawnSync('sh', [join(linkedWorktree, 'scripts/run-selfhost-supabase-tests.sh')], {
        env,
        encoding: 'utf8',
      })

      expect(res.status).toBe(1)
      expect(res.stderr).toContain('Missing self-hosted Supabase environment file.')
      expect(res.stderr).toContain('Checked paths:')
      expect(res.stderr).toContain(`  - ${join(linkedWorktree, 'ops/supabase/.env')}`)
      expect(res.stderr).toContain(`  - ${join(mainRepo, 'ops/supabase/.env')}`)
      expect(res.stderr).toContain('(cd ops/supabase && ./generate-env.sh)')
    })
  })

  it('diagnoses missing POSTGRES_PASSWORD with the exact env-file path', () => {
    withTempRepo(({ mainRepo, linkedWorktree, fakeBinDir }) => {
      const canonicalEnv = join(mainRepo, 'ops/supabase/.env')
      writeFileSync(canonicalEnv, 'ANON_KEY=test_anon_key\nSERVICE_ROLE_KEY=test_service_key\n')

      const env = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` }
      const res = spawnSync('sh', [join(linkedWorktree, 'scripts/run-selfhost-supabase-tests.sh')], {
        env,
        encoding: 'utf8',
      })

      expect(res.status).toBe(1)
      expect(res.stderr).toContain(`Missing POSTGRES_PASSWORD in ${canonicalEnv}`)
    })
  })

  it('diagnoses DB service down with safe canonical remediation in linked worktree and canonical checkout', () => {
    withTempRepo(({ mainRepo, linkedWorktree, fakeBinDir }) => {
      writeFileSync(join(mainRepo, 'ops/supabase/.env'), 'POSTGRES_PASSWORD=canonical_secret_pw\n')

      const env = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, FAKE_DOCKER_DB_DOWN: '1' }

      // 1. Invoked from linked worktree: must remediate with canonical checkout ops/supabase
      const resWt = spawnSync('sh', [join(linkedWorktree, 'scripts/run-selfhost-supabase-tests.sh')], {
        env,
        encoding: 'utf8',
      })

      expect(resWt.status).toBe(1)
      expect(resWt.stderr).toContain('Self-hosted Supabase db service is not running.')
      expect(resWt.stderr).toContain(`Start it with: (cd ${mainRepo}/ops/supabase && docker compose up -d)`)

      // 2. Invoked from canonical checkout: must remediate with local ops/supabase
      const resMain = spawnSync('sh', [join(mainRepo, 'scripts/run-selfhost-supabase-tests.sh')], {
        env,
        encoding: 'utf8',
      })

      expect(resMain.status).toBe(1)
      expect(resMain.stderr).toContain('Self-hosted Supabase db service is not running.')
      expect(resMain.stderr).toContain('Start it with: (cd ops/supabase && docker compose up -d)')
    })
  })

  it('diagnoses stopped container and missing pgTAP extension via fake Docker boundaries', () => {
    withTempRepo(({ mainRepo, linkedWorktree, fakeBinDir }) => {
      writeFileSync(join(mainRepo, 'ops/supabase/.env'), 'POSTGRES_PASSWORD=canonical_secret_pw\n')

      // 1. Container stopped
      const envStopped = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, FAKE_DOCKER_CONTAINER_STOPPED: '1' }
      const resStopped = spawnSync('sh', [join(linkedWorktree, 'scripts/run-selfhost-supabase-tests.sh')], {
        env: envStopped,
        encoding: 'utf8',
      })
      expect(resStopped.status).toBe(1)
      expect(resStopped.stderr).toContain('Expected self-hosted database container is not running: asados-supabase-db')

      // 2. pgTAP extension missing
      const envNoPgtap = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, FAKE_DOCKER_NO_PGTAP: '1' }
      const resNoPgtap = spawnSync('sh', [join(linkedWorktree, 'scripts/run-selfhost-supabase-tests.sh')], {
        env: envNoPgtap,
        encoding: 'utf8',
      })
      expect(resNoPgtap.status).toBe(1)
      expect(resNoPgtap.stderr).toContain('pgTAP extension is unavailable in asados-supabase-db')
    })
  })

  it('rejects test files outside supabase/tests and diagnoses missing compose file', () => {
    withTempRepo(({ mainRepo, linkedWorktree, fakeBinDir }) => {
      writeFileSync(join(mainRepo, 'ops/supabase/.env'), 'POSTGRES_PASSWORD=canonical_secret_pw\n')
      const env = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` }

      // 1. Reject file outside supabase/tests
      const resInvalidFile = spawnSync('sh', [join(linkedWorktree, 'scripts/run-selfhost-supabase-tests.sh'), 'outside/invalid.sql'], {
        env,
        encoding: 'utf8',
      })
      expect(resInvalidFile.status).toBe(2)
      expect(resInvalidFile.stderr).toContain('Only files under supabase/tests may be run:')

      // 2. Missing compose file
      rmSync(join(linkedWorktree, 'ops/supabase/docker-compose.yml'))
      const resMissingCompose = spawnSync('sh', [join(linkedWorktree, 'scripts/run-selfhost-supabase-tests.sh')], {
        env,
        encoding: 'utf8',
      })
      expect(resMissingCompose.status).toBe(1)
      expect(resMissingCompose.stderr).toContain('Missing self-hosted Supabase compose file:')
    })
  })

  it('enforces fake Docker argument boundaries by rejecting unknown subcommands', () => {
    withTempRepo(({ fakeBinDir }) => {
      const res = spawnSync('docker', ['unknown-subcommand'], {
        env: { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}` },
        encoding: 'utf8',
      })
      expect(res.status).toBe(1)
    })
  })

  it('emits copy-paste safe POSIX-quoted remediation when canonical path contains whitespace and shell metacharacters', () => {
    withTempRepo(
      ({ mainRepo, linkedWorktree, fakeBinDir }) => {
        writeFileSync(join(mainRepo, 'ops/supabase/.env'), 'POSTGRES_PASSWORD=canonical_secret_pw\n')

        const env = { ...process.env, PATH: `${fakeBinDir}:${process.env.PATH}`, FAKE_DOCKER_DB_DOWN: '1' }
        const res = spawnSync('sh', [join(linkedWorktree, 'scripts/run-selfhost-supabase-tests.sh')], {
          env,
          encoding: 'utf8',
        })

        expect(res.status).toBe(1)
        expect(res.stderr).toContain('Self-hosted Supabase db service is not running.')

        const canonicalOps = join(mainRepo, 'ops/supabase')
        const expectedQuoted = `'${canonicalOps.replace(/'/g, "'\\''")}'`
        expect(res.stderr).toContain(`Start it with: (cd ${expectedQuoted} && docker compose up -d)`)

        // Verify copy-paste safety in POSIX shell without executing docker compose up
        const match = res.stderr.match(/Start it with: \(cd (.+) && docker compose up -d\)/)
        expect(match).not.toBeNull()
        const targetPath = match?.[1]
        expect(targetPath).toBe(expectedQuoted)
        if (!targetPath) {
          throw new Error('Expected targetPath to be present')
        }

        const evaluated = execFileSync('sh', ['-c', `cd ${targetPath} && pwd`], { encoding: 'utf8' }).trim()
        expect(evaluated).toBe(canonicalOps)
      },
      { mainRepoName: "canonical repo with spaces $dollar and 'quote" },
    )
  })
})
