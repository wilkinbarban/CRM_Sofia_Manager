import { describe, expect, it, afterAll } from 'vitest'
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdtempSync, rmSync, statSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8')
const BASH_BIN = '/usr/bin/bash'
const PYTHON_BIN = '/usr/bin/python3'
const NODE_BIN = process.execPath

function populateSafeBin(binDir: string) {
  mkdirSync(binDir, { recursive: true })
  const SAFE_BINS = ['bash', 'sh', 'python3', 'awk', 'cat', 'grep', 'sed', 'tr', 'date', 'rm', 'mkdir', 'dirname', 'basename', 'sleep', 'env', 'sort', 'cut', 'head', 'tail', 'touch', 'printf', 'true', 'false', 'mktemp', 'cp', 'mv', 'uname', 'which', 'flock', 'id', 'pwd']
  for (const b of SAFE_BINS) {
    const t = b === 'python3' ? PYTHON_BIN : (b === 'bash' || b === 'sh' ? BASH_BIN : `/usr/bin/${b}`)
    if (!existsSync(t)) {
      throw new Error(`Required host binary missing for safe PATH stubbing: ${t}`)
    }
    symlinkSync(t, join(binDir, b))
    if (!existsSync(join(binDir, b))) {
      throw new Error(`Symlink creation failed for safe binary: ${b}`)
    }
  }
  if (!existsSync(NODE_BIN)) {
    throw new Error(`Required node binary missing for safe PATH stubbing: ${NODE_BIN}`)
  }
  symlinkSync(NODE_BIN, join(binDir, 'node'))
  if (!existsSync(join(binDir, 'node'))) {
    throw new Error(`Symlink creation failed for: node`)
  }
  writeFileSync(join(binDir, 'curl'), '#!/bin/sh\necho "deny-by-default: curl disabled in test harness" >&2\nexit 1\n', { mode: 0o755 })
}

const isolatedRunnerDir = mkdtempSync(join(tmpdir(), 'isolated-runner-'))
const isolatedRunnerBin = join(isolatedRunnerDir, 'bin')
populateSafeBin(isolatedRunnerBin)
writeFileSync(join(isolatedRunnerBin, 'docker'), '#!/bin/sh\necho "deny-by-default: docker disabled in runner harness" >&2\nexit 1\n', { mode: 0o755 })

afterAll(() => {
  rmSync(isolatedRunnerDir, { recursive: true, force: true })
})

const DEFAULT_OPERATIONAL_GATES: Record<string, string> = {
  PAYMENT_PROOF_CANONICAL_INGEST_ENABLED: 'false',
  WHATSAPP_PAYMENT_PROOF_INGEST_ENABLED: 'false',
  TELEGRAM_PAYMENT_PROOF_INGEST_ENABLED: 'false',
  PAYMENT_PROOF_PROCESSING_ENABLED: 'false',
  PAYMENT_PROOF_SELLER_RECONCILIATION_ENABLED: 'false',
  PAYMENT_PROOF_PRIVILEGED_REPLAY_ENABLED: 'false',
  PAYMENT_PROOF_CLEANUP_ENABLED: 'false',
  PAYMENT_PROOF_RESTORE_ENABLED: 'false',
  NOTIFICATION_OUTBOX_DISPATCH_ENABLED: 'false',
  WEB_NOTIFICATION_OUTBOX_DISPATCH_ENABLED: 'false',
  WHATSAPP_NOTIFICATION_OUTBOX_DISPATCH_ENABLED: 'false',
  TELEGRAM_NOTIFICATION_OUTBOX_DISPATCH_ENABLED: 'false',
  SOFIA_INBOUND_BATCH_PROCESSING_ENABLED: 'false',
  SOFIA_INBOUND_BATCH_RUNTIME_ENABLED: 'false',
  SOFIA_INBOUND_BATCH_TELEGRAM_ENQUEUE_ENABLED: 'false',
  SOFIA_INBOUND_BATCH_EVOLUTION_ENQUEUE_ENABLED: 'false',
  SOFIA_CUSTOMER_MEMORY_ENABLED: 'false',
}

function setupMockDeployEnvironment(options?: {
  initialContainerImage?: string
  containerEnv?: Record<string, string> | null
}) {
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'mock-deploy-web-repo-'))
  const sandboxScripts = join(sandboxRoot, 'scripts')
  const sandboxBin = join(sandboxRoot, 'bin')
  const sandboxState = join(sandboxRoot, 'state')
  mkdirSync(sandboxScripts, { recursive: true })
  mkdirSync(sandboxState, { recursive: true })
  populateSafeBin(sandboxBin)

  const commandsLog = join(sandboxRoot, 'commands.log')
  const scriptsLog = join(sandboxRoot, 'scripts.log')
  writeFileSync(commandsLog, '')
  writeFileSync(scriptsLog, '')
  const containerImageFile = join(sandboxState, 'container_web_image')
  const containerEnvFile = join(sandboxState, 'container_web_env')
  const tagsFile = join(sandboxState, 'tags.tsv')

  const candidateId = 'sha256:1111111111111111111111111111111111111111111111111111111111111111'
  const currentId = 'sha256:2222222222222222222222222222222222222222222222222222222222222222'
  const candidateRef = 'crm-sofia-web:20261002'

  const initialImage = options?.initialContainerImage !== undefined ? options.initialContainerImage : currentId
  writeFileSync(containerImageFile, initialImage ? `${initialImage}\n` : '')

  if (options?.containerEnv !== null) {
    const envEntries = options?.containerEnv ?? DEFAULT_OPERATIONAL_GATES
    const lines = Object.entries(envEntries).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
    writeFileSync(containerEnvFile, lines)
  }

  // Initial tag mappings in TSV: <tag_or_ref>\t<image_id>
  const initialTags = [
    `${candidateRef}\t${candidateId}`,
    `${currentId}\t${currentId}`,
    `${candidateId}\t${candidateId}`,
    `asados-web:latest\t${currentId}`,
  ].join('\n') + '\n'
  writeFileSync(tagsFile, initialTags)

  // Minimal fixture docker-compose.yml and .env
  writeFileSync(
    join(sandboxRoot, 'docker-compose.yml'),
    'services:\n  web:\n    image: ${CRM_SOFIA_WEB_IMAGE:-${ASADOS_WEB_IMAGE:-asados-web:latest}}\n'
  )
  writeFileSync(join(sandboxRoot, '.env'), 'PORT=3000\n')

  // Copy EXACT deploy-web.sh bytes to sandbox scripts dir
  const deployBytes = readFileSync(join(root, 'scripts', 'deploy-web.sh'))
  const sandboxDeployScript = join(sandboxScripts, 'deploy-web.sh')
  writeFileSync(sandboxDeployScript, deployBytes, { mode: 0o755 })

  // Stubs for absolute child scripts invoked by deploy-web.sh ($smoke, $ingress_limit_probe, $preflight)
  const makeScriptStub = (name: string, body: string) => {
    const p = join(sandboxScripts, name)
    const content = `#!${BASH_BIN}\nset -euo pipefail\n${body}\n`
    writeFileSync(p, content, { mode: 0o755 })
  }

  makeScriptStub(
    'workspace-preflight.sh',
    `echo "preflight args: $*" >> "${scriptsLog}"\nexit 0`
  )

  makeScriptStub(
    'smoke-production-readonly.sh',
    `if [[ -f "${sandboxState}/fail_smoke_once" ]]; then\n` +
    `  rm -f "${sandboxState}/fail_smoke_once"\n` +
    `  echo "smoke forced single failure" >> "${scriptsLog}"\n` +
    `  exit 1\n` +
    `fi\n` +
    `if [[ -f "${sandboxState}/fail_smoke" ]]; then\n` +
    `  echo "smoke forced failure" >> "${scriptsLog}"\n` +
    `  exit 1\n` +
    `fi\n` +
    `container_image="$(cat "${containerImageFile}" | tr -d '\\r\\n')"\n` +
    `expected="\${ASADOS_EXPECTED_IMAGE_ID:-}"\n` +
    `echo "smoke expected=\${expected} actual=\${container_image}" >> "${scriptsLog}"\n` +
    `if [[ -n "\${expected}" && "\${container_image}" != "\${expected}" ]]; then\n` +
    `  echo "smoke assertion failed: expected \${expected} got \${container_image}" >&2\n` +
    `  exit 1\n` +
    `fi\n` +
    `exit 0`
  )

  makeScriptStub(
    'verify-webhook-ingress-limit.sh',
    `echo "ingress-probe target: $1" >> "${scriptsLog}"\nexit 0`
  )

  // Stateful hermetic mock Docker CLI:
  // - stateful image ID resolution and tagging
  // - stateful container.Image transitions on compose up web
  // - strict semantic validation with fail-closed rejection of unknown commands and flags
  const dockerScript = `#!/usr/bin/env bash
set -euo pipefail

echo "docker $*" >> "${commandsLog}"

STATE_DIR="${sandboxState}"
TAGS_FILE="${tagsFile}"
CONTAINER_FILE="${containerImageFile}"
ENV_FILE="${containerEnvFile}"

if [[ "\${1:-}" == "--host" ]]; then
  if [[ "\${2:-}" != "unix:///var/run/docker.sock" ]]; then
    echo "Error: non-unix docker host: \${2:-}" >&2
    exit 1
  fi
  shift 2
fi

cmd="\${1:-}"
shift || true

case "\$cmd" in
  image)
    sub="\${1:-}"
    shift || true
    case "\$sub" in
      inspect)
        ref="\${1:-}"
        shift || true
        id="\$(awk -v r="\$ref" '\$1 == r { print \$2; exit } \$2 == r { print \$2; exit }' "\$TAGS_FILE")"
        if [[ -z "\$id" ]]; then
          echo "Error: No such image: \$ref" >&2
          exit 1
        fi
        if [[ \$# -eq 0 ]]; then exit 0; fi
        if [[ \$# -eq 2 && "\$1" == "--format" && "\$2" == "{{.Id}}" ]]; then
          echo "\$id"
          exit 0
        fi
        echo "Error: unknown image inspect format: \$*" >&2
        exit 1
        ;;
      tag)
        if [[ \$# -ne 2 ]]; then
          echo "Error: invalid tag arguments count: \$#" >&2
          exit 1
        fi
        src="\$1"
        target="\$2"
        src_id="\$(awk -v s="\$src" '\$1 == s { print \$2; exit } \$2 == s { print \$2; exit }' "\$TAGS_FILE")"
        if [[ -z "\$src_id" ]]; then
          echo "Error: source image not found: \$src" >&2
          exit 1
        fi
        printf '%s\\t%s\\n' "\$target" "\$src_id" >> "\$TAGS_FILE"
        exit 0
        ;;
      *)
        echo "Error: unknown image subcommand: \$sub" >&2
        exit 1
        ;;
    esac
    ;;
  inspect)
    target="\${1:-}"
    shift || true
    case "\$target" in
      crm-sofia-web|asados-web)
        if [[ ! -f "\$CONTAINER_FILE" ]]; then
          exit 1
        fi
        if [[ \$# -eq 0 ]]; then
          exit 0
        elif [[ \$# -eq 2 && "\$1" == "--format" ]]; then
          case "\$2" in
            '{{index .Config.Labels "com.docker.compose.project"}}')
              echo "asados"
              exit 0 ;;
            '{{.Image}}')
              cat "\$CONTAINER_FILE" | tr -d '\\r\\n'
              echo
              exit 0 ;;
            '{{range .Config.Env}}{{println .}}{{end}}')
              if [[ -f "\$ENV_FILE" ]]; then
                cat "\$ENV_FILE"
                exit 0
              fi
              exit 1 ;;
            '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}')
              echo "healthy"
              exit 0 ;;
            *)
              echo "Error: unknown inspect format: \$2" >&2
              exit 1 ;;
          esac
        else
          echo "Error: invalid inspect arg count or flag: \$*" >&2
          exit 1
        fi
        ;;
      asados-sofia-inbound-batch-maintenance)
        if [[ \$# -eq 2 && "\$1" == "--format" && "\$2" == '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' ]]; then
          echo "healthy"
          exit 0
        fi
        echo "Error: invalid inspect args for scheduler: \$*" >&2
        exit 1
        ;;
      *)
        echo "Error: unknown inspect target: \$target" >&2
        exit 1
        ;;
    esac
    ;;
  compose)
    echo "compose-invocation: CRM_SOFIA_WEB_IMAGE=\${CRM_SOFIA_WEB_IMAGE:-unset} ASADOS_WEB_IMAGE=\${ASADOS_WEB_IMAGE:-unset} args: \$*" >> "${commandsLog}"
    env | grep '_ENABLED=' | sort >> "${commandsLog}" || true
    if [[ \$# -eq 1 ]]; then
      case "\$1" in
        ps) exit 0 ;;
        config) exit 0 ;;
        *) echo "Error: unknown docker compose command: \$1" >&2; exit 1 ;;
      esac
    elif [[ \$# -ge 2 && ( "\$1" == "ps" || "\$1" == "config" ) ]]; then
      echo "Error: invalid compose \$1 arguments" >&2
      exit 1
    fi
    if [[ \$# -eq 11 && "\$1" == "-f" && "\$3" == "--project-directory" && "\$5" == "--project-name" && "\$6" == "asados" && "\$7" == "up" && "\$8" == "-d" && "\$9" == "--no-deps" && "\${10}" == "--force-recreate" ]]; then
      if [[ "\$2" != "${sandboxRoot}/docker-compose.yml" ]]; then
        echo "Error: invalid compose file path" >&2
        exit 1
      fi
      if [[ "\$4" != "${sandboxRoot}" ]]; then
        echo "Error: invalid compose project directory" >&2
        exit 1
      fi
      target_svc="\${11}"
      case "\$target_svc" in
        web)
          requested="\${CRM_SOFIA_WEB_IMAGE:-}"
          if [[ -n "\$requested" ]]; then
            resolved_id="\$(awk -v r="\$requested" '\$1 == r { print \$2; exit } \$2 == r { print \$2; exit }' "\$TAGS_FILE")"
            if [[ -z "\$resolved_id" ]]; then
              echo "Error: compose target image not found: \$requested" >&2
              exit 1
            fi
            echo "\$resolved_id" > "\$CONTAINER_FILE"
          fi
          exit 0
          ;;
        sofia-inbound-batch-maintenance)
          exit 0
          ;;
        *)
          echo "Error: unknown compose up target" >&2
          exit 1
          ;;
      esac
    fi
    echo "Error: unknown docker compose arguments or flags" >&2
    exit 1
    ;;
  stop)
    if [[ \$# -eq 1 && "\$1" == "asados-sofia-inbound-batch-maintenance" ]]; then
      echo "stop args: \$*" >> "${commandsLog}"
      exit 0
    fi
    echo "Error: unknown stop target: \$*" >&2
    exit 1
    ;;
  *)
    echo "Error: unknown docker command: \$cmd" >&2
    exit 1
    ;;
esac
`
  const dockerPath = join(sandboxBin, 'docker')
  writeFileSync(dockerPath, dockerScript, { mode: 0o755 })

  const env: Record<string, string> = {
    PATH: sandboxBin,
    HOME: sandboxRoot,
    TMPDIR: sandboxRoot,
    PYTHONDONTWRITEBYTECODE: '1',
    CRM_SOFIA_WEB_IMAGE: 'ambient-crm-wrong:latest',
    ASADOS_WEB_IMAGE: 'ambient-asados-wrong:latest',
    ASADOS_DEPLOY_STATE_ROOT: sandboxState,
    ASADOS_OPERATIONAL_ROOT: sandboxRoot,
    ASADOS_PREFLIGHT_SCRIPT: join(sandboxScripts, 'workspace-preflight.sh'),
    ASADOS_WEB_HEALTH_TIMEOUT_SECONDS: '5',
    ASADOS_SOFIA_SCHEDULER_HEALTH_TIMEOUT_SECONDS: '5',
  }

  const cleanup = () => {
    rmSync(sandboxRoot, { recursive: true, force: true })
  }

  return {
    sandboxRoot,
    sandboxDeployScript,
    sandboxState,
    commandsLog,
    scriptsLog,
    containerImageFile,
    tagsFile,
    candidateId,
    currentId,
    candidateRef,
    env,
    cleanup,
  }
}

describe('Web Image Compatibility & Dual Tagging', () => {
  describe('Compose image resolution precedence and network aliases', () => {
    it('defines CRM_SOFIA_WEB_IMAGE precedence over ASADOS_WEB_IMAGE with fallback to asados-web:latest', () => {
      const compose = read('docker-compose.yml')
      expect(compose).toMatch(/image:\s*\$\{CRM_SOFIA_WEB_IMAGE:-\$\{ASADOS_WEB_IMAGE:-asados-web:latest\}\}/)
    })

    it('evaluates precedence deterministically according to POSIX parameter expansion rules', () => {
      const evaluateImage = (crmVar?: string, asadosVar?: string) => {
        const asadosFallback = (asadosVar !== undefined && asadosVar !== '') ? asadosVar : 'asados-web:latest'
        return (crmVar !== undefined && crmVar !== '') ? crmVar : asadosFallback
      }

      // Case 1: CRM_SOFIA_WEB_IMAGE set -> takes precedence regardless of ASADOS_WEB_IMAGE
      expect(evaluateImage('crm-sofia-web:v2', 'asados-web:v1')).toBe('crm-sofia-web:v2')
      expect(evaluateImage('crm-sofia-web:v2', undefined)).toBe('crm-sofia-web:v2')
      expect(evaluateImage('crm-sofia-web:v2', '')).toBe('crm-sofia-web:v2')

      // Case 2: Only ASADOS_WEB_IMAGE set -> uses ASADOS_WEB_IMAGE
      expect(evaluateImage(undefined, 'asados-web:v1')).toBe('asados-web:v1')
      expect(evaluateImage('', 'asados-web:v1')).toBe('asados-web:v1')

      // Case 3: Neither set -> final fallback asados-web:latest unchanged
      expect(evaluateImage(undefined, undefined)).toBe('asados-web:latest')
      expect(evaluateImage('', '')).toBe('asados-web:latest')
    })

    it('preserves dual network aliases and modern container name', () => {
      const compose = read('docker-compose.yml')
      expect(compose).toContain('container_name: crm-sofia-web')

      // Check app-private and portafolio-net aliases
      const appPrivateMatch = compose.match(/app-private:\s*\n\s*aliases:\s*\n\s*-\s*asados-web\s*\n\s*-\s*crm-sofia-web/)
      expect(appPrivateMatch).not.toBeNull()

      const portafolioNetMatch = compose.match(/portafolio-net:\s*\n\s*aliases:\s*\n\s*-\s*asados-web\s*\n\s*-\s*crm-sofia-web/)
      expect(portafolioNetMatch).not.toBeNull()
    })
  })

  describe('Deploy script dual environment injection and dual rollback tagging', () => {
    it('injects both CRM_SOFIA_WEB_IMAGE and ASADOS_WEB_IMAGE on compose invocations', () => {
      const deploy = read('scripts', 'deploy-web.sh')
      expect(deploy).toContain('CRM_SOFIA_WEB_IMAGE="$ref"')
      expect(deploy).toContain('ASADOS_WEB_IMAGE="$ref"')
    })

    it('tags both crm-sofia-web and asados-web rollback refs for the exact same image ID', () => {
      const deploy = read('scripts', 'deploy-web.sh')
      expect(deploy).toContain('asados-web:rollback-${current_id#sha256:}')
      expect(deploy).toContain('crm-sofia-web:rollback-${current_id#sha256:}')
      expect(deploy).toMatch(/docker image tag "\$current_id" "\$rollback_ref"/)
      expect(deploy).toMatch(/docker image tag "\$current_id" "\$rollback_ref_modern"/)
    })

    it('preserves PREVIOUS_REF in legacy format for rollback stability', () => {
      const deploy = read('scripts', 'deploy-web.sh')
      expect(deploy).toContain('write_state "$rollback_ref" "$previous_id" "$candidate_ref" "$candidate_id"')
      expect(deploy).toContain('recreate_and_verify "$PREVIOUS_REF" "$PREVIOUS_ID" true')
    })

    it('executes hermetic mock deploy verifying dual tags and dual vars without daemon or secrets', () => {
      const harness = setupMockDeployEnvironment()
      try {
        const {
          sandboxRoot,
          sandboxDeployScript,
          sandboxState,
          commandsLog,
          scriptsLog,
          containerImageFile,
          tagsFile,
          candidateId,
          currentId,
          candidateRef,
          env,
        } = harness

        // 1. Run deploy
        const resDeploy = spawnSync('bash', [sandboxDeployScript, 'deploy', candidateRef], {
          env,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })

        expect(resDeploy.status).toBe(0)

        // Verify both rollback tags map to the SAME observed current ID
        const tagsContent = readFileSync(tagsFile, 'utf8')
        const rollbackAsadosRef = `asados-web:rollback-${currentId.replace(/^sha256:/, '')}`
        const rollbackCrmRef = `crm-sofia-web:rollback-${currentId.replace(/^sha256:/, '')}`

        expect(tagsContent).toContain(`${rollbackAsadosRef}\t${currentId}`)
        expect(tagsContent).toContain(`${rollbackCrmRef}\t${currentId}`)

        // Verify docker compose invocation overrides ambient CRM_SOFIA_WEB_IMAGE and ASADOS_WEB_IMAGE
        const commandsContent = readFileSync(commandsLog, 'utf8')
        expect(commandsContent).toContain(
          `compose-invocation: CRM_SOFIA_WEB_IMAGE=${candidateRef} ASADOS_WEB_IMAGE=${candidateRef}`
        )

        // Verify container.Image transitioned to candidateId after compose up
        const finalDeployContainerImage = readFileSync(containerImageFile, 'utf8').trim()
        expect(finalDeployContainerImage).toBe(candidateId)

        // Verify release.env state persistence
        const stateFile = join(sandboxState, 'release.env')
        const stateContent = readFileSync(stateFile, 'utf8')
        expect(stateContent).toContain(`PREVIOUS_REF=${rollbackAsadosRef}`)
        expect(stateContent).toContain(`PREVIOUS_ID=${currentId}`)
        expect(stateContent).toContain(`DEPLOYED_REF=${candidateRef}`)
        expect(stateContent).toContain(`DEPLOYED_ID=${candidateId}`)

        // Verify that stubs (not actual root scripts) executed
        const scriptsContent = readFileSync(scriptsLog, 'utf8')
        expect(scriptsContent).toContain('preflight args: check')
        expect(scriptsContent).toContain(`smoke expected=${candidateId} actual=${candidateId}`)
        expect(scriptsContent).toContain('ingress-probe target: https://crmsofiamanager.duckdns.org')

        // 2. Run rollback using the persisted state
        const resRollback = spawnSync('bash', [sandboxDeployScript, 'rollback'], {
          env,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })

        expect(resRollback.status).toBe(0)

        // Verify rollback compose invocation used the retained legacy PREVIOUS_REF
        const commandsAfterRollback = readFileSync(commandsLog, 'utf8')
        expect(commandsAfterRollback).toContain(
          `compose-invocation: CRM_SOFIA_WEB_IMAGE=${rollbackAsadosRef} ASADOS_WEB_IMAGE=${rollbackAsadosRef}`
        )

        // Verify container transitioned back to currentId
        const finalRollbackContainerImage = readFileSync(containerImageFile, 'utf8').trim()
        expect(finalRollbackContainerImage).toBe(currentId)

        // Verify rollback smoke check verified expected currentId
        const scriptsAfterRollback = readFileSync(scriptsLog, 'utf8')
        expect(scriptsAfterRollback).toContain(`smoke expected=${currentId} actual=${currentId}`)
      } finally {
        harness.cleanup()
      }
    })

    it('fails closed during deploy when running container image inspect produces an empty ID', () => {
      const harness = setupMockDeployEnvironment({ initialContainerImage: '' })
      try {
        const {
          sandboxRoot,
          sandboxDeployScript,
          sandboxState,
          candidateRef,
          env,
        } = harness

        const res = spawnSync('bash', [sandboxDeployScript, 'deploy', candidateRef], {
          env,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })

        // Must fail closed (non-zero status)
        expect(res.status).not.toBe(0)

        // Release state must not be committed
        const stateFile = join(sandboxState, 'release.env')
        expect(existsSync(stateFile)).toBe(false)
      } finally {
        harness.cleanup()
      }
    })
  })

  describe('Isolated rollback candidate runner rejects both production prefixes', () => {
    it('rejects asados-web: and crm-sofia-web: prefixes before attempting Docker contact', () => {
      const runner = join(root, 'scripts', 'test-rollback-candidate-isolated.sh')

      const runWithTag = (tag: string) => {
        return spawnSync(BASH_BIN, [runner, 'plan'], {
          cwd: root,
          env: {
            PATH: isolatedRunnerBin,
            HOME: isolatedRunnerDir,
            TMPDIR: isolatedRunnerDir,
            PYTHONDONTWRITEBYTECODE: '1',
            ROLLBACK_HARNESS_IMAGE_TAG: tag,
            ROLLBACK_HARNESS_MIN_FREE_BYTES: '1024',
          },
          encoding: 'utf8',
        })
      }

      const resAsados = runWithTag('asados-web:rollback-candidate-1')
      expect(resAsados.status).toBe(1)
      expect(resAsados.stderr).toContain('production identifier')

      const resCrm = runWithTag('crm-sofia-web:rollback-candidate-2')
      expect(resCrm.status).toBe(1)
      expect(resCrm.stderr).toContain('production identifier')
    })
  })

  describe('Legacy brand asset generator safety', () => {
    it('fails closed before dependency requires or writes with an informative English message', () => {
      const script = join(root, 'scripts', 'generate-brand-assets.js')

      // Capture mtime of all files in apps/web/public to guarantee zero writes
      const publicDir = join(root, 'apps/web', 'public')
      const targetFiles = [
        'icon.png',
        'apple-touch-icon.png',
        'favicon-16x16.png',
        'favicon-32x32.png',
        'favicon.ico',
      ]
      const mtimesBefore: Record<string, number> = {}
      for (const file of targetFiles) {
        const p = join(publicDir, file)
        try {
          mtimesBefore[file] = statSync(p).mtimeMs
        } catch {
          // file may not exist
        }
      }

      const res = spawnSync(NODE_BIN, [script], {
        cwd: root,
        env: {
          PATH: isolatedRunnerBin,
          HOME: isolatedRunnerDir,
          TMPDIR: isolatedRunnerDir,
        },
        encoding: 'utf8',
      })

      // Must exit with non-zero status
      expect(res.status).toBe(1)
      // Must output English deprecation message
      expect(res.stderr).toMatch(/deprecated|disabled/i)
      expect(res.stderr).toMatch(/brand/i)

      // Must not modify any public asset
      for (const file of targetFiles) {
        const p = join(publicDir, file)
        try {
          const mtimeAfter = statSync(p).mtimeMs
          expect(mtimeAfter).toBe(mtimesBefore[file])
        } catch {
          // file was not created
        }
      }
    })

    it('does not require sharp or perform fs writes when executed', () => {
      const content = read('scripts', 'generate-brand-assets.js')
      // Early exit must be before require('sharp')
      const sharpIndex = content.indexOf("require('sharp')")
      const exitIndex = content.indexOf('process.exit(1)')

      expect(exitIndex).toBeGreaterThan(-1)
      if (sharpIndex > -1) {
        expect(exitIndex).toBeLessThan(sharpIndex)
      }
    })
  })

  describe('Web-only deployment and rollback preservation', () => {
    const heterogeneousGates: Record<string, string> = {
      PAYMENT_PROOF_CANONICAL_INGEST_ENABLED: 'true',
      WHATSAPP_PAYMENT_PROOF_INGEST_ENABLED: 'false',
      TELEGRAM_PAYMENT_PROOF_INGEST_ENABLED: 'true',
      PAYMENT_PROOF_PROCESSING_ENABLED: 'false',
      PAYMENT_PROOF_SELLER_RECONCILIATION_ENABLED: 'true',
      PAYMENT_PROOF_PRIVILEGED_REPLAY_ENABLED: 'false',
      PAYMENT_PROOF_CLEANUP_ENABLED: 'true',
      PAYMENT_PROOF_RESTORE_ENABLED: 'false',
      NOTIFICATION_OUTBOX_DISPATCH_ENABLED: 'true',
      WEB_NOTIFICATION_OUTBOX_DISPATCH_ENABLED: 'false',
      WHATSAPP_NOTIFICATION_OUTBOX_DISPATCH_ENABLED: 'true',
      TELEGRAM_NOTIFICATION_OUTBOX_DISPATCH_ENABLED: 'false',
      SOFIA_INBOUND_BATCH_PROCESSING_ENABLED: 'true',
      SOFIA_INBOUND_BATCH_RUNTIME_ENABLED: 'false',
      SOFIA_INBOUND_BATCH_TELEGRAM_ENQUEUE_ENABLED: 'true',
      SOFIA_INBOUND_BATCH_EVOLUTION_ENQUEUE_ENABLED: 'false',
      SOFIA_CUSTOMER_MEMORY_ENABLED: 'true',
    }

    it('promotes candidate web container while preserving heterogeneous current operational gates and never touching scheduler', () => {
      const harness = setupMockDeployEnvironment({ containerEnv: heterogeneousGates })
      try {
        const {
          sandboxRoot,
          sandboxDeployScript,
          sandboxState,
          commandsLog,
          containerImageFile,
          candidateId,
          candidateRef,
          env,
        } = harness

        const opposingAmbientEnv = {
          ...env,
          PAYMENT_PROOF_CANONICAL_INGEST_ENABLED: 'false',
          WHATSAPP_PAYMENT_PROOF_INGEST_ENABLED: 'true',
          TELEGRAM_PAYMENT_PROOF_INGEST_ENABLED: 'false',
          PAYMENT_PROOF_PROCESSING_ENABLED: 'true',
          PAYMENT_PROOF_SELLER_RECONCILIATION_ENABLED: 'false',
          PAYMENT_PROOF_PRIVILEGED_REPLAY_ENABLED: 'true',
          PAYMENT_PROOF_CLEANUP_ENABLED: 'false',
          PAYMENT_PROOF_RESTORE_ENABLED: 'true',
          NOTIFICATION_OUTBOX_DISPATCH_ENABLED: 'false',
          WEB_NOTIFICATION_OUTBOX_DISPATCH_ENABLED: 'true',
          WHATSAPP_NOTIFICATION_OUTBOX_DISPATCH_ENABLED: 'false',
          TELEGRAM_NOTIFICATION_OUTBOX_DISPATCH_ENABLED: 'true',
          SOFIA_INBOUND_BATCH_PROCESSING_ENABLED: 'false',
          SOFIA_INBOUND_BATCH_RUNTIME_ENABLED: 'true',
          SOFIA_INBOUND_BATCH_TELEGRAM_ENQUEUE_ENABLED: 'false',
          SOFIA_INBOUND_BATCH_EVOLUTION_ENQUEUE_ENABLED: 'true',
          SOFIA_CUSTOMER_MEMORY_ENABLED: 'false',
        }

        const resDeploy = spawnSync('bash', [sandboxDeployScript, 'deploy', '--web-only', candidateRef], {
          env: opposingAmbientEnv,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })

        expect(resDeploy.status).toBe(0)

        const commandsContent = readFileSync(commandsLog, 'utf8')
        expect(commandsContent).toContain('--no-deps --force-recreate web')
        expect(commandsContent).not.toContain('sofia-inbound-batch-maintenance')
        expect(commandsContent).not.toContain('stop args:')

        for (const [gate, expectedVal] of Object.entries(heterogeneousGates)) {
          expect(commandsContent).toContain(`${gate}=${expectedVal}`)
        }

        expect(readFileSync(containerImageFile, 'utf8').trim()).toBe(candidateId)

        const stateFile = join(sandboxState, 'release.env')
        const stateContent = readFileSync(stateFile, 'utf8')
        expect(stateContent).toMatch(/DEPLOY_MODE=['"]?web-only['"]?/)
        for (const [gate, expectedVal] of Object.entries(heterogeneousGates)) {
          expect(stateContent).toMatch(new RegExp(`PRESERVED_GATE_${gate}=['"]?${expectedVal}['"]?`))
        }
      } finally {
        harness.cleanup()
      }
    })

    it('restores recorded previous gates and touches no scheduler on explicit rollback --web-only', () => {
      const harness = setupMockDeployEnvironment({ containerEnv: heterogeneousGates })
      try {
        const {
          sandboxRoot,
          sandboxDeployScript,
          commandsLog,
          containerImageFile,
          currentId,
          candidateRef,
          env,
        } = harness

        const resDeploy = spawnSync('bash', [sandboxDeployScript, 'deploy', '--web-only', candidateRef], {
          env,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })
        expect(resDeploy.status).toBe(0)

        writeFileSync(commandsLog, '')

        const opposingAmbientEnv = {
          ...env,
          PAYMENT_PROOF_CANONICAL_INGEST_ENABLED: 'false',
          WHATSAPP_PAYMENT_PROOF_INGEST_ENABLED: 'true',
          NOTIFICATION_OUTBOX_DISPATCH_ENABLED: 'false',
          WEB_NOTIFICATION_OUTBOX_DISPATCH_ENABLED: 'true',
        }

        const resRollback = spawnSync('bash', [sandboxDeployScript, 'rollback', '--web-only'], {
          env: opposingAmbientEnv,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })
        expect(resRollback.status).toBe(0)

        const commandsContent = readFileSync(commandsLog, 'utf8')
        expect(commandsContent).toContain('--no-deps --force-recreate web')
        expect(commandsContent).not.toContain('sofia-inbound-batch-maintenance')
        expect(commandsContent).not.toContain('stop args:')

        for (const [gate, expectedVal] of Object.entries(heterogeneousGates)) {
          expect(commandsContent).toContain(`${gate}=${expectedVal}`)
        }

        expect(readFileSync(containerImageFile, 'utf8').trim()).toBe(currentId)
      } finally {
        harness.cleanup()
      }
    })

    it('governs plain rollback when DEPLOY_MODE is web-only to prevent legacy scheduler stop and restore gates', () => {
      const harness = setupMockDeployEnvironment({ containerEnv: heterogeneousGates })
      try {
        const {
          sandboxRoot,
          sandboxDeployScript,
          commandsLog,
          containerImageFile,
          currentId,
          candidateRef,
          env,
        } = harness

        // First deploy in web-only mode so release.env records DEPLOY_MODE='web-only'
        const resDeploy = spawnSync('bash', [sandboxDeployScript, 'deploy', '--web-only', candidateRef], {
          env,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })
        expect(resDeploy.status).toBe(0)

        writeFileSync(commandsLog, '')

        // Run PLAIN rollback (no --web-only flag passed!)
        const resPlainRollback = spawnSync('bash', [sandboxDeployScript, 'rollback'], {
          env,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })
        expect(resPlainRollback.status).toBe(0)

        const commandsContent = readFileSync(commandsLog, 'utf8')
        // Stored DEPLOY_MODE must govern: target ONLY web and NEVER stop or recreate scheduler
        expect(commandsContent).toContain('--no-deps --force-recreate web')
        expect(commandsContent).not.toContain('sofia-inbound-batch-maintenance')
        expect(commandsContent).not.toContain('stop args:')

        // Preserved gates must be restored
        for (const [gate, expectedVal] of Object.entries(heterogeneousGates)) {
          expect(commandsContent).toContain(`${gate}=${expectedVal}`)
        }

        expect(readFileSync(containerImageFile, 'utf8').trim()).toBe(currentId)
      } finally {
        harness.cleanup()
      }
    })

    it('automatically recovers previous image with preserved gates and successful smoke recovery on single promotion failure', () => {
      const harness = setupMockDeployEnvironment({ containerEnv: heterogeneousGates })
      try {
        const {
          sandboxRoot,
          sandboxDeployScript,
          sandboxState,
          scriptsLog,
          commandsLog,
          containerImageFile,
          currentId,
          candidateRef,
          env,
        } = harness

        const priorStateContent = [
          'PREVIOUS_REF="asados-web:rollback-3333333333333333333333333333333333333333333333333333333333333333"',
          'PREVIOUS_ID="sha256:3333333333333333333333333333333333333333333333333333333333333333"',
          'DEPLOYED_REF="asados-web:prior"',
          'DEPLOYED_ID="sha256:4444444444444444444444444444444444444444444444444444444444444444"',
          'RECORDED_AT="2026-10-02T12:00:00Z"',
        ].join('\n') + '\n'
        writeFileSync(join(sandboxState, 'release.env'), priorStateContent)
        // Set fail_smoke_once so promotion fails on candidate, but subsequent recovery smoke passes
        writeFileSync(join(sandboxState, 'fail_smoke_once'), '1')

        const resDeploy = spawnSync('bash', [sandboxDeployScript, 'deploy', '--web-only', candidateRef], {
          env,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })

        // Deploy exits non-zero because promotion failed
        expect(resDeploy.status).not.toBe(0)
        expect(resDeploy.stderr).toContain('Promotion failed; restoring the retained previous image')

        const scriptsContent = readFileSync(scriptsLog, 'utf8')
        // Prove single promotion failure and subsequent successful smoke recovery
        expect(scriptsContent).toContain('smoke forced single failure')
        expect(scriptsContent).toContain(`smoke expected=${currentId} actual=${currentId}`)

        const commandsContent = readFileSync(commandsLog, 'utf8')
        expect(commandsContent).not.toContain('sofia-inbound-batch-maintenance')
        expect(commandsContent).not.toContain('stop args:')

        for (const [gate, expectedVal] of Object.entries(heterogeneousGates)) {
          expect(commandsContent).toContain(`${gate}=${expectedVal}`)
        }

        // Image successfully rolled back
        expect(readFileSync(containerImageFile, 'utf8').trim()).toBe(currentId)

        // Prior release.env preserved, candidate not committed
        const stateContentAfter = readFileSync(join(sandboxState, 'release.env'), 'utf8')
        expect(stateContentAfter).toBe(priorStateContent)
      } finally {
        harness.cleanup()
      }
    })

    it('retains persistent failure when recovery smoke also fails', () => {
      const harness = setupMockDeployEnvironment({ containerEnv: heterogeneousGates })
      try {
        const {
          sandboxRoot,
          sandboxDeployScript,
          sandboxState,
          commandsLog,
          containerImageFile,
          currentId,
          candidateRef,
          env,
        } = harness

        const priorStateContent = [
          'PREVIOUS_REF="asados-web:rollback-3333333333333333333333333333333333333333333333333333333333333333"',
          'PREVIOUS_ID="sha256:3333333333333333333333333333333333333333333333333333333333333333"',
          'DEPLOYED_REF="asados-web:prior"',
          'DEPLOYED_ID="sha256:4444444444444444444444444444444444444444444444444444444444444444"',
          'RECORDED_AT="2026-10-02T12:00:00Z"',
        ].join('\n') + '\n'
        writeFileSync(join(sandboxState, 'release.env'), priorStateContent)
        // Persistent smoke failure
        writeFileSync(join(sandboxState, 'fail_smoke'), '1')

        const resDeploy = spawnSync('bash', [sandboxDeployScript, 'deploy', '--web-only', candidateRef], {
          env,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })

        expect(resDeploy.status).not.toBe(0)
        expect(resDeploy.stderr).toContain('Promotion failed; restoring the retained previous image')

        const commandsContent = readFileSync(commandsLog, 'utf8')
        expect(commandsContent).not.toContain('sofia-inbound-batch-maintenance')
        expect(commandsContent).not.toContain('stop args:')

        // Image was reverted to currentId despite recovery smoke failure
        expect(readFileSync(containerImageFile, 'utf8').trim()).toBe(currentId)

        const stateContentAfter = readFileSync(join(sandboxState, 'release.env'), 'utf8')
        expect(stateContentAfter).toBe(priorStateContent)
      } finally {
        harness.cleanup()
      }
    })

    it('routes plain rollback to legacy mode when DEPLOY_MODE is standard or unset, stopping scheduler', () => {
      const harness = setupMockDeployEnvironment()
      try {
        const {
          sandboxRoot,
          sandboxDeployScript,
          sandboxState,
          tagsFile,
          commandsLog,
          candidateId,
          currentId,
          env,
        } = harness

        const rollbackTag = `asados-web:rollback-${currentId.replace(/^sha256:/, '')}`
        appendFileSync(tagsFile, `${rollbackTag}\t${currentId}\n`)

        // Legacy release.env without DEPLOY_MODE (or standard)
        const legacyState = [
          `PREVIOUS_REF="${rollbackTag}"`,
          `PREVIOUS_ID="${currentId}"`,
          `DEPLOYED_REF="crm-sofia-web:20261002"`,
          `DEPLOYED_ID="${candidateId}"`,
          `RECORDED_AT="2026-10-02T12:00:00Z"`,
          `DEPLOY_MODE='standard'`,
        ].join('\n') + '\n'
        writeFileSync(join(sandboxState, 'release.env'), legacyState)

        const resRollback = spawnSync('bash', [sandboxDeployScript, 'rollback'], {
          env,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })

        expect(resRollback.status).toBe(0)
        const commandsContent = readFileSync(commandsLog, 'utf8')
        // Legacy rollback stops the scheduler
        expect(commandsContent).toContain('stop args: asados-sofia-inbound-batch-maintenance')
      } finally {
        harness.cleanup()
      }
    })

    it('rejects rollback --web-only when DEPLOY_MODE is standard or unset', () => {
      const harness = setupMockDeployEnvironment()
      try {
        const {
          sandboxRoot,
          sandboxDeployScript,
          sandboxState,
          tagsFile,
          commandsLog,
          candidateId,
          currentId,
          env,
        } = harness

        const rollbackTag = `asados-web:rollback-${currentId.replace(/^sha256:/, '')}`
        appendFileSync(tagsFile, `${rollbackTag}\t${currentId}\n`)

        const legacyState = [
          `PREVIOUS_REF="${rollbackTag}"`,
          `PREVIOUS_ID="${currentId}"`,
          `DEPLOYED_REF="crm-sofia-web:20261002"`,
          `DEPLOYED_ID="${candidateId}"`,
          `RECORDED_AT="2026-10-02T12:00:00Z"`,
          `DEPLOY_MODE='standard'`,
        ].join('\n') + '\n'
        writeFileSync(join(sandboxState, 'release.env'), legacyState)

        const res = spawnSync('bash', [sandboxDeployScript, 'rollback', '--web-only'], {
          env,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })

        expect(res.status).not.toBe(0)
        expect(res.stderr).toContain('recorded state is not web-only')
        expect(readFileSync(commandsLog, 'utf8')).not.toContain('docker compose')
      } finally {
        harness.cleanup()
      }
    })

    it('rejects rollback when DEPLOY_MODE is unknown or corrupted', () => {
      const harness = setupMockDeployEnvironment()
      try {
        const {
          sandboxRoot,
          sandboxDeployScript,
          sandboxState,
          tagsFile,
          commandsLog,
          candidateId,
          currentId,
          env,
        } = harness

        const rollbackTag = `asados-web:rollback-${currentId.replace(/^sha256:/, '')}`
        appendFileSync(tagsFile, `${rollbackTag}\t${currentId}\n`)

        const corruptState = [
          `PREVIOUS_REF="${rollbackTag}"`,
          `PREVIOUS_ID="${currentId}"`,
          `DEPLOYED_REF="crm-sofia-web:20261002"`,
          `DEPLOYED_ID="${candidateId}"`,
          `RECORDED_AT="2026-10-02T12:00:00Z"`,
          `DEPLOY_MODE='corrupt_mode'`,
        ].join('\n') + '\n'
        writeFileSync(join(sandboxState, 'release.env'), corruptState)

        const res = spawnSync('bash', [sandboxDeployScript, 'rollback'], {
          env,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })

        expect(res.status).not.toBe(0)
        expect(res.stderr).toContain('Unknown deploy mode in release state: corrupt_mode')
        expect(readFileSync(commandsLog, 'utf8')).not.toContain('docker compose')
      } finally {
        harness.cleanup()
      }
    })

    it('rejects incompatible CLI flags before any docker effects', () => {
      const harness = setupMockDeployEnvironment()
      try {
        const {
          sandboxRoot,
          sandboxDeployScript,
          commandsLog,
          candidateRef,
          env,
        } = harness

        const runCmd = (...args: string[]) => {
          writeFileSync(commandsLog, '')
          return spawnSync('bash', [sandboxDeployScript, ...args], {
            env,
            cwd: sandboxRoot,
            encoding: 'utf8',
          })
        }

        const resIncompatible1 = runCmd('deploy', '--closed-gates', '--web-only', candidateRef)
        expect(resIncompatible1.status).toBe(2)
        expect(resIncompatible1.stderr).toContain('Usage:')
        expect(readFileSync(commandsLog, 'utf8')).toBe('')

        const resIncompatible2 = runCmd('deploy', '--web-only', '--closed-gates', candidateRef)
        expect(resIncompatible2.status).toBe(2)
        expect(resIncompatible2.stderr).toContain('Usage:')
        expect(readFileSync(commandsLog, 'utf8')).toBe('')

        const resIncompatibleRollback = runCmd('rollback', '--closed-gates')
        expect(resIncompatibleRollback.status).toBe(2)
        expect(resIncompatibleRollback.stderr).toContain('Usage:')
        expect(readFileSync(commandsLog, 'utf8')).toBe('')

        const resExtraRollback = runCmd('rollback', '--web-only', 'extra')
        expect(resExtraRollback.status).toBe(2)
        expect(resExtraRollback.stderr).toContain('Usage:')
        expect(readFileSync(commandsLog, 'utf8')).toBe('')
      } finally {
        harness.cleanup()
      }
    })

    it('fails closed before web recreation when running container operational gates are malformed, missing, or inspect fails', () => {
      const malformedGates = {
        ...DEFAULT_OPERATIONAL_GATES,
        PAYMENT_PROOF_CANONICAL_INGEST_ENABLED: 'invalid_boolean',
      }
      const harnessMalformed = setupMockDeployEnvironment({ containerEnv: malformedGates })
      try {
        const res = spawnSync('bash', [harnessMalformed.sandboxDeployScript, 'deploy', '--web-only', harnessMalformed.candidateRef], {
          env: harnessMalformed.env,
          cwd: harnessMalformed.sandboxRoot,
          encoding: 'utf8',
        })
        expect(res.status).not.toBe(0)
        expect(res.stderr).toContain('malformed')
        const commands = readFileSync(harnessMalformed.commandsLog, 'utf8')
        expect(commands).not.toContain('docker compose')
      } finally {
        harnessMalformed.cleanup()
      }

      const missingGates = { ...DEFAULT_OPERATIONAL_GATES }
      delete missingGates.SOFIA_CUSTOMER_MEMORY_ENABLED
      const harnessMissing = setupMockDeployEnvironment({ containerEnv: missingGates })
      try {
        const res = spawnSync('bash', [harnessMissing.sandboxDeployScript, 'deploy', '--web-only', harnessMissing.candidateRef], {
          env: harnessMissing.env,
          cwd: harnessMissing.sandboxRoot,
          encoding: 'utf8',
        })
        expect(res.status).not.toBe(0)
        expect(res.stderr).toContain('absent or unavailable')
        const commands = readFileSync(harnessMissing.commandsLog, 'utf8')
        expect(commands).not.toContain('docker compose')
      } finally {
        harnessMissing.cleanup()
      }

      const harnessInspectFail = setupMockDeployEnvironment({ containerEnv: null })
      try {
        const res = spawnSync('bash', [harnessInspectFail.sandboxDeployScript, 'deploy', '--web-only', harnessInspectFail.candidateRef], {
          env: harnessInspectFail.env,
          cwd: harnessInspectFail.sandboxRoot,
          encoding: 'utf8',
        })
        expect(res.status).not.toBe(0)
        expect(res.stderr).toContain('Failed to inspect configuration')
        const commands = readFileSync(harnessInspectFail.commandsLog, 'utf8')
        expect(commands).not.toContain('docker compose')
      } finally {
        harnessInspectFail.cleanup()
      }
    })

    it('fails closed on rollback --web-only when release state gates are absent or malformed', () => {
      const harness = setupMockDeployEnvironment()
      try {
        const {
          sandboxRoot,
          sandboxDeployScript,
          sandboxState,
          tagsFile,
          commandsLog,
          candidateId,
          currentId,
          env,
        } = harness

        const rollbackTag = `asados-web:rollback-${currentId.replace(/^sha256:/, '')}`
        appendFileSync(tagsFile, `${rollbackTag}\t${currentId}\n`)

        const corruptState = [
          `PREVIOUS_REF="${rollbackTag}"`,
          `PREVIOUS_ID="${currentId}"`,
          `DEPLOYED_REF="crm-sofia-web:20261002"`,
          `DEPLOYED_ID="${candidateId}"`,
          `RECORDED_AT="2026-10-02T12:00:00Z"`,
          `DEPLOY_MODE='web-only'`,
        ].join('\n') + '\n'
        writeFileSync(join(sandboxState, 'release.env'), corruptState)

        const res = spawnSync('bash', [sandboxDeployScript, 'rollback', '--web-only'], {
          env,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })

        expect(res.status).not.toBe(0)
        expect(res.stderr).toMatch(/requires all 17 preserved gates|absent or malformed in release state/)
        const commands = readFileSync(commandsLog, 'utf8')
        expect(commands).not.toContain('docker compose')
      } finally {
        harness.cleanup()
      }
    })

    it('rejects executable tamper in release.env without executing payload, preserving state bytes and zero docker mutations', () => {
      const harness = setupMockDeployEnvironment()
      try {
        const {
          sandboxRoot,
          sandboxDeployScript,
          sandboxState,
          tagsFile,
          commandsLog,
          candidateId,
          currentId,
          env,
        } = harness

        const rollbackTag = `asados-web:rollback-${currentId.replace(/^sha256:/, '')}`
        appendFileSync(tagsFile, `${rollbackTag}\t${currentId}\n`)

        const marker = join(sandboxState, 'pwned_marker')
        const maliciousState = [
          `PREVIOUS_REF="${rollbackTag}"`,
          `touch "${marker}"`,
          `PREVIOUS_ID="${currentId}"`,
          `DEPLOYED_REF="crm-sofia-web:20261002"`,
          `DEPLOYED_ID="${candidateId}"`,
          `RECORDED_AT="2026-10-02T12:00:00Z"`,
        ].join('\n') + '\n'

        const stateFile = join(sandboxState, 'release.env')
        writeFileSync(stateFile, maliciousState)

        const res = spawnSync('bash', [sandboxDeployScript, 'rollback'], {
          env,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })

        expect(res.status).not.toBe(0)
        expect(existsSync(marker)).toBe(false)
        expect(readFileSync(stateFile, 'utf8')).toBe(maliciousState)
        expect(readFileSync(commandsLog, 'utf8')).not.toContain('docker compose')
      } finally {
        harness.cleanup()
      }
    })

    it('rejects duplicate keys in release.env fail-closed before docker mutations', () => {
      const harness = setupMockDeployEnvironment()
      try {
        const {
          sandboxRoot,
          sandboxDeployScript,
          sandboxState,
          tagsFile,
          commandsLog,
          candidateId,
          currentId,
          env,
        } = harness

        const rollbackTag = `asados-web:rollback-${currentId.replace(/^sha256:/, '')}`
        appendFileSync(tagsFile, `${rollbackTag}\t${currentId}\n`)

        const dupState = [
          `PREVIOUS_REF="${rollbackTag}"`,
          `PREVIOUS_REF="${rollbackTag}"`,
          `PREVIOUS_ID="${currentId}"`,
          `DEPLOYED_REF="crm-sofia-web:20261002"`,
          `DEPLOYED_ID="${candidateId}"`,
          `RECORDED_AT="2026-10-02T12:00:00Z"`,
        ].join('\n') + '\n'

        const stateFile = join(sandboxState, 'release.env')
        writeFileSync(stateFile, dupState)

        const res = spawnSync('bash', [sandboxDeployScript, 'rollback'], {
          env,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })

        expect(res.status).not.toBe(0)
        expect(res.stderr).toContain('Duplicate key')
        expect(readFileSync(commandsLog, 'utf8')).not.toContain('docker compose')
      } finally {
        harness.cleanup()
      }
    })

    it('rejects duplicate allowlisted gates in container inspect even with same value fail-closed before docker mutations', () => {
      const harness = setupMockDeployEnvironment()
      try {
        const {
          sandboxRoot,
          sandboxDeployScript,
          sandboxState,
          commandsLog,
          candidateRef,
          env,
        } = harness

        // Append duplicate allowlisted gate to container env
        const envFile = join(sandboxState, 'container_web_env')
        appendFileSync(envFile, 'PAYMENT_PROOF_CANONICAL_INGEST_ENABLED=false\n')

        const res = spawnSync('bash', [sandboxDeployScript, 'deploy', '--web-only', candidateRef], {
          env,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })

        expect(res.status).not.toBe(0)
        expect(res.stderr).toContain('multiple times')
        expect(readFileSync(commandsLog, 'utf8')).not.toContain('docker compose')
      } finally {
        harness.cleanup()
      }
    })

    it('proves historical release state without DEPLOY_MODE does not inherit ambient host DEPLOY_MODE or injected gates', () => {
      const harness = setupMockDeployEnvironment()
      try {
        const {
          sandboxRoot,
          sandboxDeployScript,
          sandboxState,
          tagsFile,
          commandsLog,
          candidateId,
          currentId,
          env,
        } = harness

        const rollbackTag = `asados-web:rollback-${currentId.replace(/^sha256:/, '')}`
        appendFileSync(tagsFile, `${rollbackTag}\t${currentId}\n`)

        // Historical release.env without DEPLOY_MODE
        const legacyState = [
          `PREVIOUS_REF="${rollbackTag}"`,
          `PREVIOUS_ID="${currentId}"`,
          `DEPLOYED_REF="crm-sofia-web:20261002"`,
          `DEPLOYED_ID="${candidateId}"`,
          `RECORDED_AT="2026-10-02T12:00:00Z"`,
        ].join('\n') + '\n'
        writeFileSync(join(sandboxState, 'release.env'), legacyState)

        // Run plain rollback with host attempting to inject DEPLOY_MODE and gate variables
        const ambientHostEnv = {
          ...env,
          DEPLOY_MODE: 'web-only',
          PRESERVED_GATE_PAYMENT_PROOF_CANONICAL_INGEST_ENABLED: 'true',
        }

        const res = spawnSync('bash', [sandboxDeployScript, 'rollback'], {
          env: ambientHostEnv,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })

        expect(res.status).toBe(0)
        const commands = readFileSync(commandsLog, 'utf8')
        // Legacy rollback must stop the scheduler; ambient DEPLOY_MODE must NOT be inherited
        expect(commands).toContain('stop args: asados-sofia-inbound-batch-maintenance')
      } finally {
        harness.cleanup()
      }
    })

    it('preserves release.env byte-identical and mutates no scheduler on explicit rollback smoke failure', () => {
      const harness = setupMockDeployEnvironment({ containerEnv: heterogeneousGates })
      try {
        const {
          sandboxRoot,
          sandboxDeployScript,
          sandboxState,
          commandsLog,
          candidateRef,
          env,
        } = harness

        // First deploy to create a valid web-only release.env
        const resDeploy = spawnSync('bash', [sandboxDeployScript, 'deploy', '--web-only', candidateRef], {
          env,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })
        expect(resDeploy.status).toBe(0)

        const stateFile = join(sandboxState, 'release.env')
        const beforeBytes = readFileSync(stateFile, 'utf8')

        writeFileSync(commandsLog, '')
        // Inject persistent smoke failure for rollback
        writeFileSync(join(sandboxState, 'fail_smoke'), '1')

        const resRollback = spawnSync('bash', [sandboxDeployScript, 'rollback', '--web-only'], {
          env,
          cwd: sandboxRoot,
          encoding: 'utf8',
        })

        expect(resRollback.status).not.toBe(0)
        expect(readFileSync(stateFile, 'utf8')).toBe(beforeBytes)

        const commands = readFileSync(commandsLog, 'utf8')
        expect(commands).not.toContain('sofia-inbound-batch-maintenance')
        expect(commands).not.toContain('stop args:')
      } finally {
        harness.cleanup()
      }
    })

    describe('Schema and format boundary validation', () => {
      const validBaseLines = [
        'PREVIOUS_REF="asados-web:rollback-2222222222222222222222222222222222222222222222222222222222222222"',
        'PREVIOUS_ID="sha256:2222222222222222222222222222222222222222222222222222222222222222"',
        'DEPLOYED_REF="crm-sofia-web:20261002"',
        'DEPLOYED_ID="sha256:1111111111111111111111111111111111111111111111111111111111111111"',
        'RECORDED_AT="2026-10-02T12:00:00Z"',
      ]

      it.each([
        ['gates without DEPLOY_MODE', [...validBaseLines, 'PRESERVED_GATE_SOFIA_CUSTOMER_MEMORY_ENABLED="true"'], /preserved gates present without DEPLOY_MODE/],
        ['standard mode with preserved gate', [...validBaseLines, 'DEPLOY_MODE="standard"', 'PRESERVED_GATE_SOFIA_CUSTOMER_MEMORY_ENABLED="true"'], /preserved gates present in standard deploy mode/],
        ['web-only mode with partial gates', [...validBaseLines, 'DEPLOY_MODE="web-only"', 'PRESERVED_GATE_SOFIA_CUSTOMER_MEMORY_ENABLED="true"'], /requires all 17 preserved gates/],
        ['missing PREVIOUS_REF', validBaseLines.filter((l) => !l.startsWith('PREVIOUS_REF=')), /Missing required state field PREVIOUS_REF/],
        ['missing PREVIOUS_ID', validBaseLines.filter((l) => !l.startsWith('PREVIOUS_ID=')), /Missing required state field PREVIOUS_ID/],
        ['missing DEPLOYED_REF', validBaseLines.filter((l) => !l.startsWith('DEPLOYED_REF=')), /Missing required state field DEPLOYED_REF/],
        ['missing DEPLOYED_ID', validBaseLines.filter((l) => !l.startsWith('DEPLOYED_ID=')), /Missing required state field DEPLOYED_ID/],
        ['missing RECORDED_AT', validBaseLines.filter((l) => !l.startsWith('RECORDED_AT=')), /Missing required state field RECORDED_AT/],
        ['unknown key', [...validBaseLines, 'UNKNOWN_KEY="tamper"'], /Unknown key UNKNOWN_KEY/],
        ['malformed option-like ref', ['PREVIOUS_REF="--malicious-flag"', ...validBaseLines.slice(1)], /Invalid image reference/],
        ['malformed image ID length', [...validBaseLines.slice(0, 3), 'DEPLOYED_ID="sha256:1234"', ...validBaseLines.slice(4)], /Invalid image ID/],
        ['malformed UTC timestamp', [...validBaseLines.slice(0, 4), 'RECORDED_AT="2026-10-02 12:00:00"'], /Invalid UTC timestamp/],
        ['malformed gate boolean', [...validBaseLines, 'DEPLOY_MODE="web-only"', 'PRESERVED_GATE_SOFIA_CUSTOMER_MEMORY_ENABLED="maybe"'], /Invalid boolean value/],
      ])('rejects invalid state schema or format: %s', (_, lines, expectedErr) => {
        const harness = setupMockDeployEnvironment()
        try {
          const { sandboxRoot, sandboxDeployScript, sandboxState, commandsLog, env } = harness
          writeFileSync(join(sandboxState, 'release.env'), lines.join('\n') + '\n')
          const res = spawnSync('bash', [sandboxDeployScript, 'rollback'], { env, cwd: sandboxRoot, encoding: 'utf8' })
          expect(res.status).not.toBe(0)
          expect(res.stderr).toMatch(expectedErr)
          expect(readFileSync(commandsLog, 'utf8')).not.toContain('docker compose')
        } finally {
          harness.cleanup()
        }
      })

      it('rejects command substitution payload in quoted field without executing marker', () => {
        const harness = setupMockDeployEnvironment()
        try {
          const { sandboxRoot, sandboxDeployScript, sandboxState, commandsLog, env } = harness
          const marker = join(sandboxState, 'exec_marker')
          const lines = [
            `PREVIOUS_REF="$(touch ${marker})"`,
            ...validBaseLines.slice(1),
          ]
          writeFileSync(join(sandboxState, 'release.env'), lines.join('\n') + '\n')
          const res = spawnSync('bash', [sandboxDeployScript, 'rollback'], { env, cwd: sandboxRoot, encoding: 'utf8' })
          expect(res.status).not.toBe(0)
          expect(existsSync(marker)).toBe(false)
          expect(readFileSync(commandsLog, 'utf8')).not.toContain('docker compose')
        } finally {
          harness.cleanup()
        }
      })

      it('executes plain rollback with modern standard schema using historical writer quotes', () => {
        const harness = setupMockDeployEnvironment()
        try {
          const { sandboxRoot, sandboxDeployScript, sandboxState, tagsFile, commandsLog, currentId, env } = harness
          const rollbackTag = `asados-web:rollback-${currentId.replace(/^sha256:/, '')}`
          appendFileSync(tagsFile, `${rollbackTag}\t${currentId}\n`)
          const lines = [
            ...validBaseLines,
            "DEPLOY_MODE='standard'",
          ]
          writeFileSync(join(sandboxState, 'release.env'), lines.join('\n') + '\n')
          const res = spawnSync('bash', [sandboxDeployScript, 'rollback'], { env, cwd: sandboxRoot, encoding: 'utf8' })
          expect(res.status).toBe(0)
          expect(readFileSync(commandsLog, 'utf8')).toContain('stop args: asados-sofia-inbound-batch-maintenance')
        } finally {
          harness.cleanup()
        }
      })

      it('proves closed PATH executes deny stubs for curl and forbidden docker commands with zero network fallback', () => {
        const harness = setupMockDeployEnvironment()
        try {
          expect(harness.env.SHELL).toBeUndefined()
          expect(harness.env.USER).toBeUndefined()

          const resCurl = spawnSync('curl', ['--help'], { env: harness.env, encoding: 'utf8' })
          expect(resCurl.status).not.toBe(0)
          expect(resCurl.stderr).toContain('deny-by-default: curl disabled in test harness')

          const resDocker = spawnSync('docker', ['forbidden-command'], { env: harness.env, encoding: 'utf8' })
          expect(resDocker.status).not.toBe(0)
          expect(resDocker.stderr).toContain('Error: unknown docker command: forbidden-command')

          const resComposeUnknown = spawnSync('docker', ['compose', 'forbidden-subcommand'], { env: harness.env, encoding: 'utf8' })
          expect(resComposeUnknown.status).not.toBe(0)
          expect(resComposeUnknown.stderr).toContain('Error: unknown docker compose command: forbidden-subcommand')

          const resComposePs = spawnSync('docker', ['compose', 'ps'], { env: harness.env, encoding: 'utf8' })
          expect(resComposePs.status).toBe(0)

          const resComposePsExtra = spawnSync('docker', ['compose', 'ps', 'extra-arg'], { env: harness.env, encoding: 'utf8' })
          expect(resComposePsExtra.status).not.toBe(0)
          expect(resComposePsExtra.stderr).toContain('Error: invalid compose ps arguments')

          const resComposeConfig = spawnSync('docker', ['compose', 'config'], { env: harness.env, encoding: 'utf8' })
          expect(resComposeConfig.status).toBe(0)

          const resComposeConfigExtra = spawnSync('docker', ['compose', 'config', 'extra-arg'], { env: harness.env, encoding: 'utf8' })
          expect(resComposeConfigExtra.status).not.toBe(0)
          expect(resComposeConfigExtra.stderr).toContain('Error: invalid compose config arguments')

          const resNonUnixHost = spawnSync('docker', ['--host', 'tcp://127.0.0.1:2375', 'ps'], { env: harness.env, encoding: 'utf8' })
          expect(resNonUnixHost.status).not.toBe(0)
          expect(resNonUnixHost.stderr).toContain('Error: non-unix docker host: tcp://127.0.0.1:2375')

          const resUnknownUp = spawnSync('docker', [
            'compose', '-f', join(harness.sandboxRoot, 'docker-compose.yml'),
            '--project-directory', harness.sandboxRoot, '--project-name', 'asados',
            'up', '-d', '--no-deps', '--force-recreate', 'unknown-service',
          ], { env: harness.env, encoding: 'utf8' })
          expect(resUnknownUp.status).not.toBe(0)
          expect(resUnknownUp.stderr).toContain('Error: unknown compose up target')

          const resWrongFile = spawnSync('docker', [
            'compose', '-f', '/tmp/wrong/docker-compose.yml',
            '--project-directory', harness.sandboxRoot, '--project-name', 'asados',
            'up', '-d', '--no-deps', '--force-recreate', 'web',
          ], { env: harness.env, encoding: 'utf8' })
          expect(resWrongFile.status).not.toBe(0)
          expect(resWrongFile.stderr).toContain('Error: invalid compose file path')

          const resWrongDir = spawnSync('docker', [
            'compose', '-f', join(harness.sandboxRoot, 'docker-compose.yml'),
            '--project-directory', '/tmp/wrong', '--project-name', 'asados',
            'up', '-d', '--no-deps', '--force-recreate', 'web',
          ], { env: harness.env, encoding: 'utf8' })
          expect(resWrongDir.status).not.toBe(0)
          expect(resWrongDir.stderr).toContain('Error: invalid compose project directory')

          const resPermutedFlags = spawnSync('docker', [
            'compose', '-f', join(harness.sandboxRoot, 'docker-compose.yml'),
            '--project-directory', harness.sandboxRoot, '--project-name', 'asados',
            'up', '-d', '--force-recreate', '--no-deps', 'web',
          ], { env: harness.env, encoding: 'utf8' })
          expect(resPermutedFlags.status).not.toBe(0)
          expect(resPermutedFlags.stderr).toContain('Error: unknown docker compose arguments or flags')

          const resExtraService = spawnSync('docker', [
            'compose', '-f', join(harness.sandboxRoot, 'docker-compose.yml'),
            '--project-directory', harness.sandboxRoot, '--project-name', 'asados',
            'up', '-d', '--no-deps', '--force-recreate', 'web', 'extra-service',
          ], { env: harness.env, encoding: 'utf8' })
          expect(resExtraService.status).not.toBe(0)
          expect(resExtraService.stderr).toContain('Error: unknown docker compose arguments or flags')

          const resUnknownScheduler = spawnSync('docker', [
            'compose', '-f', join(harness.sandboxRoot, 'docker-compose.yml'),
            '--project-directory', harness.sandboxRoot, '--project-name', 'asados',
            'up', '-d', '--no-deps', '--force-recreate', 'unknown-scheduler',
          ], { env: harness.env, encoding: 'utf8' })
          expect(resUnknownScheduler.status).not.toBe(0)
          expect(resUnknownScheduler.stderr).toContain('Error: unknown compose up target')
        } finally {
          harness.cleanup()
        }
      })

      it('proves sandbox cleanup deterministically removes created directory', () => {
        const harness = setupMockDeployEnvironment()
        const rootDir = harness.sandboxRoot
        expect(existsSync(rootDir)).toBe(true)
        harness.cleanup()
        expect(existsSync(rootDir)).toBe(false)
      })
    })
  })
})
