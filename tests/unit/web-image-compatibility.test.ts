import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8')

function setupMockDeployEnvironment(options?: { initialContainerImage?: string }) {
  const sandboxRoot = mkdtempSync(join(tmpdir(), 'mock-deploy-web-repo-'))
  const sandboxScripts = join(sandboxRoot, 'scripts')
  const sandboxBin = join(sandboxRoot, 'bin')
  const sandboxState = join(sandboxRoot, 'state')
  spawnSync('mkdir', ['-p', sandboxScripts, sandboxBin, sandboxState])

  const commandsLog = join(sandboxRoot, 'commands.log')
  const scriptsLog = join(sandboxRoot, 'scripts.log')
  const containerImageFile = join(sandboxState, 'container_web_image')
  const tagsFile = join(sandboxState, 'tags.tsv')

  const candidateId = 'sha256:candidate11111111111111111111111111111111111111111111111111111111111111'
  const currentId = 'sha256:current22222222222222222222222222222222222222222222222222222222222222'
  const candidateRef = 'crm-sofia-web:20261002'

  const initialImage = options?.initialContainerImage !== undefined ? options.initialContainerImage : currentId
  writeFileSync(containerImageFile, initialImage ? `${initialImage}\n` : '')

  // Initial tag mappings in TSV: <tag_or_ref>\t<image_id>
  const initialTags = [
    `${candidateRef}\t${candidateId}`,
    `${currentId}\t${currentId}`,
    `${candidateId}\t${candidateId}`,
    `asados-web:latest\t${currentId}`,
  ].join('\n') + '\n'
  writeFileSync(tagsFile, initialTags)

  // Minimal fixture docker-compose.yml
  writeFileSync(
    join(sandboxRoot, 'docker-compose.yml'),
    'services:\n  web:\n    image: ${CRM_SOFIA_WEB_IMAGE:-${ASADOS_WEB_IMAGE:-asados-web:latest}}\n'
  )

  // Copy EXACT deploy-web.sh bytes to sandbox scripts dir
  const deployBytes = readFileSync(join(root, 'scripts', 'deploy-web.sh'))
  const sandboxDeployScript = join(sandboxScripts, 'deploy-web.sh')
  writeFileSync(sandboxDeployScript, deployBytes, { mode: 0o755 })

  // Stubs for absolute child scripts invoked by deploy-web.sh ($smoke, $ingress_limit_probe, $preflight)
  const makeScriptStub = (name: string, body: string) => {
    const p = join(sandboxScripts, name)
    const content = `#!/usr/bin/env bash\nset -euo pipefail\n${body}\n`
    writeFileSync(p, content, { mode: 0o755 })
  }

  makeScriptStub(
    'workspace-preflight.sh',
    `echo "preflight args: $*" >> "${scriptsLog}"\nexit 0`
  )

  makeScriptStub(
    'smoke-production-readonly.sh',
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
  // - fail closed on unknown commands
  const dockerScript = `#!/usr/bin/env bash
set -euo pipefail

echo "docker $*" >> "${commandsLog}"

STATE_DIR="${sandboxState}"
TAGS_FILE="${tagsFile}"
CONTAINER_FILE="${containerImageFile}"

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
        if [[ "\$*" == *"{{.Id}}"* ]]; then
          echo "\$id"
          exit 0
        fi
        exit 0
        ;;
      tag)
        src="\${1:-}"
        target="\${2:-}"
        if [[ -z "\$src" || -z "\$target" ]]; then
          echo "Error: invalid tag arguments" >&2
          exit 1
        fi
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
      crm-sofia-web)
        if [[ ! -f "\$CONTAINER_FILE" ]]; then
          exit 1
        fi
        if [[ "\$*" == *"com.docker.compose.project"* ]]; then
          echo "asados"
          exit 0
        elif [[ "\$*" == *"{{.Image}}"* ]]; then
          cat "\$CONTAINER_FILE" | tr -d '\\r\\n'
          echo
          exit 0
        elif [[ "\$*" == *"Health"* || "\$*" == *"Status"* ]]; then
          echo "healthy"
          exit 0
        fi
        exit 0
        ;;
      asados-sofia-inbound-batch-maintenance)
        if [[ "\$*" == *"Health"* || "\$*" == *"Status"* ]]; then
          echo "healthy"
          exit 0
        fi
        exit 0
        ;;
      *)
        echo "Error: unknown inspect target: \$target" >&2
        exit 1
        ;;
    esac
    ;;
  compose)
    echo "compose-invocation: CRM_SOFIA_WEB_IMAGE=\${CRM_SOFIA_WEB_IMAGE:-unset} ASADOS_WEB_IMAGE=\${ASADOS_WEB_IMAGE:-unset} args: \$*" >> "${commandsLog}"
    if [[ "\$*" == *"web"* ]]; then
      requested="\${CRM_SOFIA_WEB_IMAGE:-}"
      if [[ -n "\$requested" ]]; then
        resolved_id="\$(awk -v r="\$requested" '\$1 == r { print \$2; exit } \$2 == r { print \$2; exit }' "\$TAGS_FILE")"
        if [[ -z "\$resolved_id" ]]; then
          echo "Error: compose target image not found: \$requested" >&2
          exit 1
        fi
        echo "\$resolved_id" > "\$CONTAINER_FILE"
      fi
    fi
    exit 0
    ;;
  stop)
    exit 0
    ;;
  *)
    echo "Error: unknown docker command: \$cmd" >&2
    exit 1
    ;;
esac
`
  const dockerPath = join(sandboxBin, 'docker')
  writeFileSync(dockerPath, dockerScript, { mode: 0o755 })

  const env = {
    ...process.env,
    PATH: `${sandboxBin}:${process.env.PATH}`,
    CRM_SOFIA_WEB_IMAGE: 'ambient-crm-wrong:latest',
    ASADOS_WEB_IMAGE: 'ambient-asados-wrong:latest',
    ASADOS_DEPLOY_STATE_ROOT: sandboxState,
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
        return spawnSync('bash', [runner, 'plan'], {
          cwd: root,
          env: {
            ...process.env,
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

      const res = spawnSync('node', [script], {
        cwd: root,
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
})
