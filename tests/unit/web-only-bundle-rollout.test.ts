/**
 * Dedicated unit test suite for web-only bundle rollout & rollback (B1b).
 * Pins production rollout contract:
 * - Promotion runs candidate-compose.json with project binding
 * - Promotion failure / probe failure triggers rollback-compose.json
 * - Post-promotion probe exit code 2 triggers rollback-compose.json
 * - Pre-mutation generation fault aborts before any compose up
 * - Denied tag aborts before any compose up
 * - Bundle residue removed on all exit paths
 */
import { describe, expect, it, afterEach } from 'vitest'
import { copyFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { ModuleKind, transpileModule } from 'typescript'
import { createDockerProcessBoundary } from '../helpers/web-docker-process-boundary'
import {
  FIXTURE_PROJECT, FIXTURE_SERVICE, FIXTURE_CONTAINER_ID,
  FIXTURE_INITIAL_IMAGE_ID, FIXTURE_CANDIDATE_IMAGE_ID,
  FIXTURE_INITIAL_CONFIG_IMAGE, FIXTURE_CANDIDATE_CONFIG_IMAGE, FIXTURE_NETWORK_ID,
} from '../helpers/web-docker-dispatcher'

const GATES = [
  'PAYMENT_PROOF_CANONICAL_INGEST_ENABLED', 'WHATSAPP_PAYMENT_PROOF_INGEST_ENABLED', 'TELEGRAM_PAYMENT_PROOF_INGEST_ENABLED', 'PAYMENT_PROOF_PROCESSING_ENABLED',
  'PAYMENT_PROOF_SELLER_RECONCILIATION_ENABLED', 'PAYMENT_PROOF_PRIVILEGED_REPLAY_ENABLED', 'PAYMENT_PROOF_CLEANUP_ENABLED', 'PAYMENT_PROOF_RESTORE_ENABLED',
  'NOTIFICATION_OUTBOX_DISPATCH_ENABLED', 'WEB_NOTIFICATION_OUTBOX_DISPATCH_ENABLED', 'WHATSAPP_NOTIFICATION_OUTBOX_DISPATCH_ENABLED', 'TELEGRAM_NOTIFICATION_OUTBOX_DISPATCH_ENABLED',
  'SOFIA_INBOUND_BATCH_PROCESSING_ENABLED', 'SOFIA_INBOUND_BATCH_RUNTIME_ENABLED', 'SOFIA_INBOUND_BATCH_TELEGRAM_ENQUEUE_ENABLED', 'SOFIA_INBOUND_BATCH_EVOLUTION_ENQUEUE_ENABLED', 'SOFIA_CUSTOMER_MEMORY_ENABLED',
]

const dispatcherCjs = transpileModule(
  readFileSync(join(process.cwd(), 'tests/helpers/web-docker-dispatcher.ts'), 'utf8'),
  { compilerOptions: { module: ModuleKind.CommonJS } },
).outputText

interface RolloutSandbox {
  dir: string; opRoot: string; scriptsDir: string; stateRoot: string; commandsLog: string
  runDeploy: (args: string[], env?: Record<string, string>) => ReturnType<typeof spawnSync>
  cleanup: () => void
}

let sb: RolloutSandbox | null = null
afterEach(() => { sb?.cleanup(); sb = null })

function getCommands(logPath: string): { command?: string; args?: string[] }[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function assertBundleUp(cmd: { command?: string; args?: string[] } | undefined, stateRoot: string, opRoot: string, kind: 'candidate' | 'rollback') {
  expect(cmd).toBeDefined()
  expect(cmd!.args?.[0]).toBe('compose')
  expect(cmd!.args?.[1]).toBe('-f')
  expect(cmd!.args?.[2]).toMatch(new RegExp(`^${stateRoot}/bundle-[0-9a-fA-F]+/${kind}-compose\\.json$`))
  expect(cmd!.args?.[3]).toBe('--project-directory')
  expect(cmd!.args?.[4]).toBe(opRoot)
  expect(cmd!.args?.[5]).toBe('--project-name')
  expect(cmd!.args?.[6]).toBe(FIXTURE_PROJECT)
  expect(cmd!.args?.slice(7)).toEqual(['up', '-d', '--no-deps', '--force-recreate', FIXTURE_SERVICE])
}

function createRolloutSandbox(): RolloutSandbox {
  const pb = createDockerProcessBoundary()
  const scriptsDir = join(pb.opRoot, 'scripts'), stateRoot = join(pb.dir, 'deploy-state')
  mkdirSync(scriptsDir, { recursive: true, mode: 0o700 }); mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  writeFileSync(join(pb.opRoot, 'docker-compose.yml'), 'services:\n  web:\n    image: crm-sofia-web:latest\n')
  writeFileSync(join(pb.opRoot, '.env'), 'PORT=3000\n')

  const stateFile = join(pb.dir, 'docker-state.json'), bridgeScript = join(pb.dir, 'docker-bridge.cjs')
  const bridgeCode = `const fs = require('node:fs'), path = require('node:path')
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'))
const commandsLog = ${JSON.stringify(pb.commandsLog)}, opRoot = ${JSON.stringify(pb.opRoot)}
const project = ${JSON.stringify(FIXTURE_PROJECT)}, service = ${JSON.stringify(FIXTURE_SERVICE)}
const containerId = ${JSON.stringify(FIXTURE_CONTAINER_ID)}, netId = ${JSON.stringify(FIXTURE_NETWORK_ID)}
const currentImg = ${JSON.stringify(FIXTURE_INITIAL_IMAGE_ID)}, candImg = ${JSON.stringify(FIXTURE_CANDIDATE_IMAGE_ID)}
const currentCfg = ${JSON.stringify(FIXTURE_INITIAL_CONFIG_IMAGE)}, candCfg = ${JSON.stringify(FIXTURE_CANDIDATE_CONFIG_IMAGE)}
const gates = ${JSON.stringify(GATES)}

fs.appendFileSync(commandsLog, JSON.stringify({ command: 'docker', args: process.argv.slice(2) }) + '\\n')
let args = process.argv.slice(2)
if (args[0] === '--host') {
  if (args[1] !== 'unix:///var/run/docker.sock') { process.stderr.write('deny host: ' + args[1] + '\\n'); process.exit(1) }
  args = args.slice(2)
}
if (args[0] === 'inspect' && args.length === 4 && args[2] === '--format') {
  if ((args[1] === 'crm-sofia-web' || args[1] === 'asados-web') && args[3] === '{{index .Config.Labels "com.docker.compose.project"}}') { process.stdout.write(project + '\\n'); process.exit(0) }
  if ((args[1] === 'crm-sofia-web' || args[1] === containerId) && args[3] === '{{range .Config.Env}}{{println .}}{{end}}') { process.stdout.write(gates.map(g => g + '=true').join('\\n') + '\\n'); process.exit(0) }
  if (args[3] === '{{.Id}}') { process.stdout.write(containerId + '\\n'); process.exit(0) }
  if (args[3] === '{{.Image}}') { process.stdout.write(currentImg + '\\n'); process.exit(0) }
  if (args[3].includes('.State')) { process.stdout.write((process.env.FAKE_UNHEALTHY === '1' ? 'unhealthy' : 'healthy') + '\\n'); process.exit(0) }
}
if (args[0] === 'inspect' && args.length === 2 && (args[1] === containerId || args[1] === 'crm-sofia-web' || args[1] === 'asados-web')) {
  process.stdout.write(JSON.stringify([{
    Id: containerId, Name: '/crm-sofia-web', Image: currentImg,
    Config: {
      Image: currentCfg,
      Labels: {
        'com.docker.compose.project': project, 'com.docker.compose.service': service,
        'com.docker.compose.project.working_dir': opRoot,
        'com.docker.compose.project.config_files': path.join(opRoot, 'docker-compose.yml'),
      },
    },
    HostConfig: { PortBindings: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3020' }] }, Binds: [] },
    NetworkSettings: {
      Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '3020' }] },
      Networks: { [project + '_default']: { NetworkID: netId, Aliases: ['asados-web', 'crm-sofia-web'] } },
    },
    Mounts: [],
  }]) + '\\n')
  process.exit(0)
}
if (args[0] === 'image' && args[1] === 'inspect') {
  const target = args[2]
  if (args.length === 5 && args[3] === '--format' && args[4] === '{{.Id}}') {
    process.stdout.write(((target === candCfg || target === candImg) ? candImg : currentImg) + '\\n'); process.exit(0)
  }
  if (args.length === 3) {
    process.stdout.write(JSON.stringify([{ Id: (target === candCfg || target === candImg) ? candImg : currentImg, Architecture: 'amd64', Os: 'linux' }]) + '\\n'); process.exit(0)
  }
}
if ((args[0] === 'image' && args[1] === 'tag') || args[0] === 'tag') {
  if (process.env.FAKE_DENY_TAG === '1') { process.stderr.write('deny tag\\n'); process.exit(1) }
  process.exit(0)
}
if (args[0] === 'compose' && args.includes('up')) {
  if (process.env.FAKE_COMPOSE_FAIL === '1') { process.stderr.write('deny compose up\\n'); process.exit(1) }
  process.exit(0)
}
${dispatcherCjs}
const dispatcher = exports.createDockerDispatcher({ opRoot, project, service })
dispatcher.setCurrentImageId(state.currentImageId); dispatcher.setCurrentConfigImage(state.currentConfigImage)
const res = dispatcher.runDocker(args)
if (res.status === 0 && args[0] === 'compose' && args.includes('config')) {
  const doc = JSON.parse(res.stdout)
  doc.services[service].ports[0].host_ip = '127.0.0.1'
  res.stdout = JSON.stringify(doc)
}
fs.writeFileSync(${JSON.stringify(stateFile)}, JSON.stringify({
  currentImageId: dispatcher.getCurrentImageId(), currentConfigImage: dispatcher.getCurrentConfigImage(),
}))
if (res.stdout) process.stdout.write(res.stdout); if (res.stderr) process.stderr.write(res.stderr)
process.exit(res.status)
`
  writeFileSync(bridgeScript, bridgeCode)

  for (const s of ['workspace-preflight.sh', 'verify-webhook-ingress-limit.sh']) writeFileSync(join(scriptsDir, s), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(scriptsDir, 'smoke-production-readonly.sh'), '#!/bin/sh\nif [ -n "$FAKE_FAIL_IMAGE_ID" ] && [ "$ASADOS_EXPECTED_IMAGE_ID" = "$FAKE_FAIL_IMAGE_ID" ]; then exit "${FAKE_PROBE_EXIT_CODE:-1}"; fi\nexit 0\n', { mode: 0o755 })

  const repoScripts = join(process.cwd(), 'scripts')
  copyFileSync(join(repoScripts, 'deploy-web.sh'), join(scriptsDir, 'deploy-web.sh'))
  chmodSync(join(scriptsDir, 'deploy-web.sh'), 0o755)
  for (const py of ['web_only_bundle_writer.py', 'web_only_state.py', 'web_only_state_serializer.py', 'web_only_dir.py', 'web_only_bundle_lifecycle.py', 'web_only_bundle_consumer.py', 'web_only_state_publisher.py']) {
    copyFileSync(join(repoScripts, py), join(scriptsDir, py))
  }
  copyFileSync(join(repoScripts, 'web-only-target-preflight.py'), join(scriptsDir, '_real_preflight.py'))
  writeFileSync(join(scriptsDir, 'web-only-target-preflight.py'), `#!/usr/bin/env python3
import os, sys, json, _real_preflight as rpf
fault = os.environ.get("FAKE_PREFLIGHT_FAULT", "")
faults = {"exit2": (2, json.dumps({"status": "error", "error": "invalid command arguments"})), "exit1": (1, json.dumps({"status": "error", "error": "operational preflight failed"}))}
if fault in faults:
    sys.stdout.write(faults[fault][1] + "\\n"); sys.exit(faults[fault][0])
sys.exit(rpf.main())
`, { mode: 0o755 })

  const runDeploy = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(join(pb.binDir, 'bash'), [join(scriptsDir, 'deploy-web.sh'), ...args], {
      cwd: pb.opRoot,
      env: {
        PATH: pb.binDir, HOME: pb.dir, TMPDIR: pb.dir,
        ASADOS_DEPLOY_STATE_ROOT: stateRoot, ASADOS_COMPOSE_PROJECT: FIXTURE_PROJECT,
        ASADOS_WEB_HEALTH_TIMEOUT_SECONDS: '1', ASADOS_SOFIA_SCHEDULER_HEALTH_TIMEOUT_SECONDS: '1',
        PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: scriptsDir,
        ...env,
      },
      encoding: 'utf8', timeout: 15000,
    })
  return { dir: pb.dir, opRoot: pb.opRoot, scriptsDir, stateRoot, commandsLog: pb.commandsLog, runDeploy, cleanup: () => pb.cleanup() }
}

describe('web-only-bundle-rollout B1b rollout and rollback contracts', () => {
  it('success path: candidate bundle compose runs with exact project binding, tag order preserved, no bundle residue', () => {
    sb = createRolloutSandbox()
    const res = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE])
    expect(res.status, `status=${res.status} stderr=${res.stderr} stdout=${res.stdout}`).toBe(0)

    const cmds = getCommands(sb.commandsLog)
    const upCmds = cmds.filter((c) => c.command === 'docker' && c.args?.[0] === 'compose' && c.args?.includes('up'))
    expect(upCmds).toHaveLength(1)
    assertBundleUp(upCmds[0], sb.stateRoot, sb.opRoot, 'candidate')
    expect(cmds.some((c) => c.args?.[2]?.includes('rollback-compose.json'))).toBe(false)

    const tag1 = cmds.findIndex((c) => c.args?.[0] === 'image' && c.args?.[1] === 'tag' && c.args?.[3]?.startsWith('asados-web:rollback-'))
    const tag2 = cmds.findIndex((c) => c.args?.[0] === 'image' && c.args?.[1] === 'tag' && c.args?.[3]?.startsWith('crm-sofia-web:rollback-'))
    const upIdx = cmds.findIndex((c) => c.args?.[0] === 'compose' && c.args?.includes('up'))
    expect(tag1).toBeGreaterThanOrEqual(0)
    expect(tag2).toBeGreaterThan(tag1)
    expect(upIdx).toBeGreaterThan(tag2)

    expect(readdirSync(sb.stateRoot).some((f) => f.startsWith('bundle-'))).toBe(true)
    expect(existsSync(join(sb.stateRoot, 'release.env'))).toBe(true)
  })

  it('promotion failure: rollback bundle compose runs with rollback path and same project binding, deploy exits non-zero, no bundle residue', () => {
    sb = createRolloutSandbox()
    const res = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE], {
      FAKE_FAIL_IMAGE_ID: FIXTURE_CANDIDATE_IMAGE_ID,
      FAKE_PROBE_EXIT_CODE: '1',
    })
    expect(res.status).not.toBe(0)

    const cmds = getCommands(sb.commandsLog)
    const candUp = cmds.find(
      (c) => c.command === 'docker' && c.args?.[0] === 'compose' && c.args?.includes('up') && c.args?.[2]?.includes('candidate-compose.json'),
    )
    const rollUp = cmds.find(
      (c) => c.command === 'docker' && c.args?.[0] === 'compose' && c.args?.includes('up') && c.args?.[2]?.includes('rollback-compose.json'),
    )
    expect(candUp).toBeDefined()
    assertBundleUp(rollUp, sb.stateRoot, sb.opRoot, 'rollback')
    expect(cmds.indexOf(rollUp!)).toBeGreaterThan(cmds.indexOf(candUp!))

    expect(readdirSync(sb.stateRoot).some((f) => f.startsWith('bundle-'))).toBe(false)
  })

  it('post-promotion failure with a child exit code 2: rollback is still triggered and deploy exits non-zero', () => {
    sb = createRolloutSandbox()
    const res = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE], {
      FAKE_FAIL_IMAGE_ID: FIXTURE_CANDIDATE_IMAGE_ID,
      FAKE_PROBE_EXIT_CODE: '2',
    })
    expect(res.status).not.toBe(0)

    const cmds = getCommands(sb.commandsLog)
    const rollUp = cmds.find(
      (c) => c.command === 'docker' && c.args?.[0] === 'compose' && c.args?.includes('up') && c.args?.[2]?.includes('rollback-compose.json'),
    )
    assertBundleUp(rollUp, sb.stateRoot, sb.opRoot, 'rollback')
    expect(readdirSync(sb.stateRoot).some((f) => f.startsWith('bundle-'))).toBe(false)
  })

  it('pre-mutation failure: preflight generation fault exits non-zero and neither candidate nor rollback compose runs', () => {
    sb = createRolloutSandbox()
    const res = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE], {
      FAKE_PREFLIGHT_FAULT: 'exit1',
    })
    expect(res.status).not.toBe(0)

    const cmds = getCommands(sb.commandsLog)
    expect(cmds.some((c) => c.args?.[0] === 'compose' && c.args?.includes('up'))).toBe(false)
    expect(cmds.some((c) => c.args?.[2]?.includes('candidate-compose'))).toBe(false)
    expect(cmds.some((c) => c.args?.[2]?.includes('rollback-compose'))).toBe(false)
    expect(readdirSync(sb.stateRoot).some((f) => f.startsWith('bundle-'))).toBe(false)
    expect(existsSync(join(sb.stateRoot, 'release.env'))).toBe(false)
  })

  it('denied tag: deploy exits non-zero, no compose up at all, no bundle residue', () => {
    sb = createRolloutSandbox()
    const res = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE], {
      FAKE_DENY_TAG: '1',
    })
    expect(res.status).not.toBe(0)

    const cmds = getCommands(sb.commandsLog)
    const tagCmd = cmds.find((c) => (c.args?.[0] === 'image' && c.args?.[1] === 'tag') || c.args?.[0] === 'tag')
    expect(tagCmd).toBeDefined()
    expect(cmds.some((c) => c.args?.[0] === 'compose' && c.args?.includes('up'))).toBe(false)
    expect(readdirSync(sb.stateRoot).some((f) => f.startsWith('bundle-'))).toBe(false)
    expect(existsSync(join(sb.stateRoot, 'release.env'))).toBe(false)
  })
})
