import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const HELPER_PATH = join(process.cwd(), 'scripts/web-only-target-preflight.py')
export const PYTHON_BIN = '/usr/bin/python3', BASH_BIN = '/usr/bin/bash', SLEEP_BIN = '/usr/bin/sleep'
export const FIXTURE_ID = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
export const FIXTURE_IMAGE = 'sha256:1111111111111111111111111111111111111111111111111111111111111111'

export interface Sandbox {
  dir: string; opRoot: string; spyLog: string
  runHelper: (args: string[], env?: Record<string, string>) => ReturnType<typeof spawnSync>
  runDocker: (args: string[], env?: Record<string, string>) => ReturnType<typeof spawnSync>
  cleanup: () => void
}

export function createSandbox(): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'web-target-sb-'))
  const binDir = join(dir, 'bin'), opRoot = join(dir, 'op-root'), spyLog = join(dir, 'spy.log')
  mkdirSync(binDir, { recursive: true }); mkdirSync(opRoot, { recursive: true })
  writeFileSync(join(opRoot, 'docker-compose.yml'), 'services:\n  web:\n    image: asados-web:latest\n')
  writeFileSync(join(opRoot, '.env'), 'PORT=3000\n'); writeFileSync(spyLog, '')

  for (const [bin, src] of [['bash', BASH_BIN], ['sh', BASH_BIN], ['python3', PYTHON_BIN], ['sleep', SLEEP_BIN]]) {
    if (!existsSync(src)) throw new Error(`Missing ${src}`)
    symlinkSync(src, join(binDir, bin))
  }
  writeFileSync(join(binDir, 'curl'), '#!/bin/sh\necho "deny: curl" >&2\nexit 1\n', { mode: 0o755 })

  const dockerBin = join(binDir, 'docker')
  writeFileSync(dockerBin, `#!/bin/bash
set -euo pipefail
printf '%s | DOCKER_HOST=%s | DOCKER_CONTEXT=%s\\n' "$*" "\${DOCKER_HOST:-none}" "\${DOCKER_CONTEXT:-none}" >> "$SPY_LOG"
for a in "$@"; do
  case "$a" in run|rm|compose|tag|build|push|up|down) echo "deny mutation: $a" >&2; exit 1 ;; esac
done
if [[ "\${1:-}" != "--host" || "\${2:-}" != "unix:///var/run/docker.sock" ]]; then echo "deny host" >&2; exit 1; fi
if [[ -n "\${FAKE_DOCKER_DELAY:-}" ]]; then sleep "$FAKE_DOCKER_DELAY"; fi
if [[ -n "\${FAKE_DOCKER_EXIT:-}" && "\$FAKE_DOCKER_EXIT" != "0" ]]; then echo "\${FAKE_DOCKER_STDERR:-fail}" >&2; exit "\$FAKE_DOCKER_EXIT"; fi
case "\${3:-}" in
  ps)
    if [[ $# -ne 8 || "\$4" != "-aq" || "\$5" != "--filter" || "\$6" != "label=com.docker.compose.project=asados" || "\$7" != "--filter" || "\$8" != "label=com.docker.compose.service=web" ]]; then
      echo "deny ps args" >&2; exit 1
    fi
    printf '%s\\n' "\${FAKE_DOCKER_PS_OUTPUT:-${FIXTURE_ID}}"; exit 0 ;;
  inspect)
    if [[ $# -ne 4 ]]; then echo "deny inspect arg count: $#" >&2; exit 1; fi
    case "\$4" in
      "${FIXTURE_ID}"|crm-sofia-web|asados-web) printf '%s\\n' "\${FAKE_DOCKER_INSPECT_OUTPUT:-[]}"; exit 0 ;;
      *) echo "deny unknown inspect target: \$4" >&2; exit 1 ;;
    esac ;;
  *) echo "deny unknown docker command: \${3:-}" >&2; exit 1 ;;
esac
`, { mode: 0o755 })

  const runHelper = (args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync(PYTHON_BIN, [HELPER_PATH, ...args], {
      cwd: opRoot, env: { PATH: binDir, PYTHONDONTWRITEBYTECODE: '1', SPY_LOG: spyLog, ...extraEnv },
      timeout: 20000, encoding: 'utf8',
    })
  const runDocker = (args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync(dockerBin, args, { env: { SPY_LOG: spyLog, ...extraEnv }, encoding: 'utf8' })

  return { dir, opRoot, spyLog, runHelper, runDocker, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function makeInspectFixture(opRoot: string, overrides: Record<string, unknown> = {}, containerOverrides: Record<string, unknown> = {}) {
  const Labels = {
    'com.docker.compose.project': 'asados', 'com.docker.compose.service': 'web',
    'com.docker.compose.project.working_dir': opRoot,
    'com.docker.compose.project.config_files': join(opRoot, 'docker-compose.yml'),
    ...overrides,
  }
  return JSON.stringify([{
    Id: FIXTURE_ID, Name: '/crm-sofia-web', Image: FIXTURE_IMAGE,
    Config: { Image: 'crm-sofia-web:20261002', Labels }, ...containerOverrides,
  }])
}
