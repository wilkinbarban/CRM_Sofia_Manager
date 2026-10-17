import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs'
import { spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export const HELPER_PATH = join(process.cwd(), 'scripts/web-only-target-preflight.py')
export const PYTHON_BIN = '/usr/bin/python3', BASH_BIN = '/usr/bin/bash', SLEEP_BIN = '/usr/bin/sleep'
export const FIXTURE_ID = '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
export const FIXTURE_IMAGE = 'sha256:1111111111111111111111111111111111111111111111111111111111111111'
export const FIXTURE_CANDIDATE_IMAGE_ID = 'sha256:2222222222222222222222222222222222222222222222222222222222222222'
export const FIXTURE_NETWORK_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

export const DEFAULT_HOST_CONFIG = { PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3020' }] }, Binds: [] }
export const DEFAULT_NETWORK_SETTINGS = {
  Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3020' }] },
  Networks: { asados_default: { NetworkID: FIXTURE_NETWORK_ID, Aliases: ['asados-web', 'crm-sofia-web'] } },
}

export interface Sandbox {
  dir: string; opRoot: string; spyLog: string
  runHelper: (args: string[], env?: Record<string, string>) => SpawnSyncReturns<string>
  runDocker: (args: string[], env?: Record<string, string>) => SpawnSyncReturns<string>
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

  const defaultCompose = JSON.stringify({
    services: { web: { image: 'asados-web:latest', ports: [{ mode: 'ingress', target: 3000, published: '3020', protocol: 'tcp', host_ip: '127.0.0.1' }], networks: { default: { aliases: ['asados-web', 'crm-sofia-web'] } } } },
    networks: { default: { name: 'asados_default' } },
  })
  const defaultImage = JSON.stringify([{ Id: FIXTURE_CANDIDATE_IMAGE_ID, Architecture: 'amd64', Os: 'linux' }])
  const defaultNetwork = JSON.stringify([{ Id: FIXTURE_NETWORK_ID, Name: 'asados_default', Labels: { 'com.docker.compose.project': 'asados' } }])

  const dockerBin = join(binDir, 'docker')
  writeFileSync(dockerBin, `#!/bin/bash
set -euo pipefail
DEFAULT_COMPOSE='${defaultCompose}'
DEFAULT_IMAGE='${defaultImage}'
DEFAULT_NETWORK='${defaultNetwork}'
printf '%s | DOCKER_HOST=%s | DOCKER_CONTEXT=%s\\n' "$*" "\${DOCKER_HOST:-none}" "\${DOCKER_CONTEXT:-none}" >> "$SPY_LOG"
for a in "$@"; do
  case "$a" in run|rm|tag|build|push|up|down) echo "deny mutation: $a" >&2; exit 1 ;; esac
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
  compose)
    if [[ $# -ne 14 || "\$4" != "--project-directory" || "\$6" != "--env-file" || "\$8" != "-f" || "\${10}" != "--project-name" || "\${12}" != "config" || "\${13}" != "--format" || "\${14}" != "json" ]]; then
      echo "deny compose args: $*" >&2; exit 1
    fi
    if [[ "\$5" != "${opRoot}" ]]; then echo "deny compose project-directory: \$5" >&2; exit 1; fi
    if [[ "\$7" != "${opRoot}/.env" ]]; then echo "deny compose env-file: \$7" >&2; exit 1; fi
    if [[ "\$9" != "${opRoot}/docker-compose.yml" ]]; then echo "deny compose config: \$9" >&2; exit 1; fi
    if [[ "\${11}" != "asados" ]]; then echo "deny compose project-name: \${11}" >&2; exit 1; fi
    if [[ -n "\${FAKE_DOCKER_COMPOSE_EXIT:-}" && "\$FAKE_DOCKER_COMPOSE_EXIT" != "0" ]]; then echo "\${FAKE_DOCKER_COMPOSE_STDERR:-fail}" >&2; exit "\$FAKE_DOCKER_COMPOSE_EXIT"; fi
    printf '%s\\n' "\${FAKE_DOCKER_COMPOSE_CONFIG_OUTPUT:-\$DEFAULT_COMPOSE}"; exit 0 ;;
  image)
    if [[ $# -ne 5 || "\$4" != "inspect" ]]; then echo "deny image inspect args: $*" >&2; exit 1; fi
    case "\$5" in asados-web:candidate|cand:v1|c:1) ;; *) echo "deny unknown image inspect locator: \$5" >&2; exit 1 ;; esac
    if [[ -n "\${FAKE_DOCKER_IMAGE_EXIT:-}" && "\$FAKE_DOCKER_IMAGE_EXIT" != "0" ]]; then echo "\${FAKE_DOCKER_IMAGE_STDERR:-fail}" >&2; exit "\$FAKE_DOCKER_IMAGE_EXIT"; fi
    printf '%s\\n' "\${FAKE_DOCKER_IMAGE_INSPECT_OUTPUT:-\$DEFAULT_IMAGE}"; exit 0 ;;
  network)
    if [[ $# -ne 5 || "\$4" != "inspect" ]]; then echo "deny network inspect args: $*" >&2; exit 1; fi
    case "\$5" in "${FIXTURE_NETWORK_ID}") ;; *) echo "deny unknown network inspect id: \$5" >&2; exit 1 ;; esac
    if [[ -n "\${FAKE_DOCKER_NETWORK_EXIT:-}" && "\$FAKE_DOCKER_NETWORK_EXIT" != "0" ]]; then echo "\${FAKE_DOCKER_NETWORK_STDERR:-fail}" >&2; exit "\$FAKE_DOCKER_NETWORK_EXIT"; fi
    printf '%s\\n' "\${FAKE_DOCKER_NETWORK_INSPECT_OUTPUT:-\$DEFAULT_NETWORK}"; exit 0 ;;
  *) echo "deny unknown docker command: \${3:-}" >&2; exit 1 ;;
esac
`, { mode: 0o755 })

  const runHelper = (args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync(PYTHON_BIN, [HELPER_PATH, ...args], {
      cwd: opRoot, env: { NODE_ENV: 'test', PATH: binDir, PYTHONDONTWRITEBYTECODE: '1', SPY_LOG: spyLog, ...extraEnv },
      timeout: 20000, encoding: 'utf8',
    })
  const runDocker = (args: string[], extraEnv: Record<string, string> = {}) =>
    spawnSync(dockerBin, args, { env: { NODE_ENV: 'test', SPY_LOG: spyLog, ...extraEnv }, encoding: 'utf8' })

  return { dir, opRoot, spyLog, runHelper, runDocker, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

export function makeInspectFixture(opRoot: string, overrides: Record<string, unknown> = {}, containerOverrides: Record<string, unknown> = {}) {
  const Labels = {
    'com.docker.compose.project': 'asados', 'com.docker.compose.service': 'web',
    'com.docker.compose.project.working_dir': opRoot,
    'com.docker.compose.project.config_files': join(opRoot, 'docker-compose.yml'),
    ...overrides,
  }
  const { HostConfig: oHost, NetworkSettings: oNet, ...restCtr } = containerOverrides as {
    HostConfig?: Record<string, unknown>
    NetworkSettings?: Record<string, unknown>
    [k: string]: unknown
  }
  const HostConfig = oHost ? { ...DEFAULT_HOST_CONFIG, ...oHost } : DEFAULT_HOST_CONFIG
  const NetworkSettings = oNet ? { ...DEFAULT_NETWORK_SETTINGS, ...oNet } : DEFAULT_NETWORK_SETTINGS
  return JSON.stringify([{
    Id: FIXTURE_ID, Name: '/crm-sofia-web', Image: FIXTURE_IMAGE,
    Config: { Image: 'crm-sofia-web:20261002', Labels },
    HostConfig, NetworkSettings, Mounts: [],
    ...restCtr,
  }])
}
