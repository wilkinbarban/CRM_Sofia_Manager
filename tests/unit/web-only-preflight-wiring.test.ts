/**
 * Dedicated unit test suite for web-only preflight wiring (B1a).
 * Verifies preflight generation and real bundle consumer validation
 * before any mutating docker image tag / compose up operations.
 *
 * Stage 1 Fixture Actual Capacity Gaps:
 * 1. Dispatcher does not handle '--host' prefix from preflight subprocesses.
 * 2. Dispatcher rejects deploy prerequisite inspect formats (compose project label, gates env).
 * 3. Dispatcher inspects candidate image only by ID, not config ref tag, and lacks '--format {{.Id}}'.
 * 4. Dispatcher inspect output omits PortBindings, Networks, working_dir, config_files.
 * 5. Process boundary logs only host-side runDocker; child calls require wrapper NDJSON logging.
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

interface PreflightWiringSandbox {
  dir: string; scriptsDir: string
  stateRoot: string
  commandsLog: string
  preflightLog: string
  eventsLog: string
  runDeploy: (args: string[], env?: Record<string, string>) => ReturnType<typeof spawnSync>
  cleanup: () => void
}

let sb: PreflightWiringSandbox | null = null
afterEach(() => {
  sb?.cleanup()
  sb = null
})

function getCommands(logPath: string): { command?: string; type?: string; args?: string[]; [k: string]: unknown }[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

function createPreflightSandbox(): PreflightWiringSandbox {
  const pb = createDockerProcessBoundary()
  const scriptsDir = join(pb.opRoot, 'scripts'), stateRoot = join(pb.dir, 'deploy-state')
  const preflightLog = join(pb.dir, 'preflight.log'), eventsLog = join(pb.dir, 'events.ndjson')
  mkdirSync(scriptsDir, { recursive: true, mode: 0o700 }); mkdirSync(stateRoot, { recursive: true, mode: 0o700 })
  writeFileSync(preflightLog, ''); writeFileSync(eventsLog, '')
  writeFileSync(join(pb.opRoot, 'docker-compose.yml'), 'services:\n  web:\n    image: crm-sofia-web:latest\n')
  writeFileSync(join(pb.opRoot, '.env'), 'PORT=3000\n')

  const stateFile = join(pb.dir, 'docker-state.json'), bridgeScript = join(pb.dir, 'docker-bridge.cjs')
  const bridgeCode = `${dispatcherCjs}
const fs = require('node:fs'), path = require('node:path')
const state = JSON.parse(fs.readFileSync(${JSON.stringify(stateFile)}, 'utf8'))
const commandsLog = ${JSON.stringify(pb.commandsLog)}, eventsLog = ${JSON.stringify(eventsLog)}, opRoot = ${JSON.stringify(pb.opRoot)}
const project = ${JSON.stringify(FIXTURE_PROJECT)}, service = ${JSON.stringify(FIXTURE_SERVICE)}
const containerId = ${JSON.stringify(FIXTURE_CONTAINER_ID)}, netId = ${JSON.stringify(FIXTURE_NETWORK_ID)}
const currentImg = ${JSON.stringify(FIXTURE_INITIAL_IMAGE_ID)}, candImg = ${JSON.stringify(FIXTURE_CANDIDATE_IMAGE_ID)}
const currentCfg = ${JSON.stringify(FIXTURE_INITIAL_CONFIG_IMAGE)}, candCfg = ${JSON.stringify(FIXTURE_CANDIDATE_CONFIG_IMAGE)}
const gates = ${JSON.stringify(GATES)}

fs.appendFileSync(commandsLog, JSON.stringify({ command: 'docker', args: process.argv.slice(2) }) + '\\n')
fs.appendFileSync(eventsLog, JSON.stringify({ type: 'docker', args: process.argv.slice(2) }) + '\\n')
let args = process.argv.slice(2)
if (args[0] === '--host') {
  if (args[1] !== 'unix:///var/run/docker.sock') {
    process.stderr.write('deny host: ' + args[1] + '\\n'); process.exit(1)
  }
  args = args.slice(2)
}
if (args[0] === 'inspect' && args.length === 4 && args[2] === '--format') {
  if ((args[1] === 'crm-sofia-web' || args[1] === 'asados-web') && args[3] === '{{index .Config.Labels "com.docker.compose.project"}}') {
    process.stdout.write(project + '\\n'); process.exit(0)
  }
  if ((args[1] === 'crm-sofia-web' || args[1] === containerId) && args[3] === '{{range .Config.Env}}{{println .}}{{end}}') {
    process.stdout.write(gates.map(g => g + '=true').join('\\n') + '\\n'); process.exit(0)
  }
  if (args[3] === '{{.Id}}') {
    process.stdout.write((process.env.FAKE_LIVE_CONTAINER_ID || containerId) + '\\n')
    process.exit(0)
  }
}
if (args[0] === 'inspect' && args.length === 2 && (args[1] === containerId || args[1] === 'crm-sofia-web')) {
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
if (args[0] === 'image' && args[1] === 'inspect' && (args[2] === candCfg || args[2] === candImg)) {
  if (args.length === 5 && args[3] === '--format' && args[4] === '{{.Id}}') {
    process.stdout.write(candImg + '\\n'); process.exit(0)
  }
  if (args.length === 3) {
    process.stdout.write(JSON.stringify([{ Id: candImg, Architecture: 'amd64', Os: 'linux' }]) + '\\n'); process.exit(0)
  }
}
const dispatcher = exports.createDockerDispatcher({ opRoot, project, service })
dispatcher.setCurrentImageId(state.currentImageId)
dispatcher.setCurrentConfigImage(state.currentConfigImage)
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
  for (const s of ['workspace-preflight.sh', 'verify-webhook-ingress-limit.sh', 'smoke-production-readonly.sh']) {
    writeFileSync(join(scriptsDir, s), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  }
  const repoScripts = join(process.cwd(), 'scripts')
  copyFileSync(join(repoScripts, 'deploy-web.sh'), join(scriptsDir, 'deploy-web.sh'))
  chmodSync(join(scriptsDir, 'deploy-web.sh'), 0o755)
  for (const py of ['web_only_bundle_writer.py', 'web_only_state.py', 'web_only_state_serializer.py', 'web_only_dir.py', 'web_only_bundle_lifecycle.py']) copyFileSync(join(repoScripts, py), join(scriptsDir, py))
  copyFileSync(join(repoScripts, 'web_only_bundle_consumer.py'), join(scriptsDir, '_real_bundle_consumer.py'))
  copyFileSync(join(repoScripts, 'web-only-target-preflight.py'), join(scriptsDir, '_real_preflight.py'))

  // Private instrumentation wraps real consumer to log verified success event strictly after real validation
  writeFileSync(join(scriptsDir, 'web_only_bundle_consumer.py'), `#!/usr/bin/env python3
import os, json, _real_bundle_consumer as rbc
from _real_bundle_consumer import *
_real_val = rbc.validate_effective_bundle

def validate_effective_bundle(*args, **kwargs):
    ev_log = os.environ.get("EVENTS_LOG", "")
    try:
        res = _real_val(*args, **kwargs)
        if ev_log:
            with open(ev_log, "a") as f:
                f.write(json.dumps({"type": "consumer_success", "manifest_sha256": res.get("manifest_sha256")}) + "\\n")
        return res
    except Exception as err:
        if ev_log:
            with open(ev_log, "a") as f:
                f.write(json.dumps({"type": "consumer_error", "error": str(err)}) + "\\n")
        raise
`, { mode: 0o755 })
  writeFileSync(join(scriptsDir, 'web-only-target-preflight.py'), `#!/usr/bin/env python3
import os, sys, json
log = os.environ.get("PREFLIGHT_CALL_LOG", "")
if log:
    with open(log, "a") as f:
        f.write("preflight argv: " + " ".join(sys.argv[1:]) + "\\n")
fault = os.environ.get("FAKE_PREFLIGHT_FAULT", "")
faults = {
    "exit2": (2, json.dumps({"status": "error", "error": "invalid command arguments"})),
    "exit1": (1, json.dumps({"status": "error", "error": "operational preflight failed"})),
    "malformed_json": (0, "{malformed json"),
    "missing_keys": (0, json.dumps({"status": "ok", "action": "generate-effective"})),
    "mismatched_ids": (0, json.dumps({"status": "ok", "action": "generate-effective", "bundle_dir": "/dummy", "manifest_sha256": "0" * 64, "candidate_image_id": "sha256:" + "9" * 64, "current_image_id": "sha256:" + "1" * 64, "container_id": "c" * 64})),
}
if fault in faults:
    sys.stdout.write(faults[fault][1] + "\\n"); sys.exit(faults[fault][0])
import _real_preflight as rpf
if fault == "tamper_bundle":
    bdir = next((sys.argv[i + 1] for i, a in enumerate(sys.argv) if a == "--bundle-dir" and i + 1 < len(sys.argv)), "")
    try:
        rpf.main()
    except SystemExit as e:
        if e.code == 0 and bdir:
            mpath = os.path.join(bdir, "manifest.json")
            if os.path.isfile(mpath):
                with open(mpath, "a") as mf: mf.write("tampered\\n")
                ev_log = os.environ.get("EVENTS_LOG", "")
                if ev_log:
                    with open(ev_log, "a") as ef: ef.write(json.dumps({"type": "bundle_tampered"}) + "\\n")
        sys.exit(e.code)
sys.exit(rpf.main())
`, { mode: 0o755 })

  const runDeploy = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(join(pb.binDir, 'bash'), [join(scriptsDir, 'deploy-web.sh'), ...args], {
      cwd: pb.opRoot,
      env: {
        PATH: pb.binDir, HOME: pb.dir, TMPDIR: pb.dir,
        ASADOS_DEPLOY_STATE_ROOT: stateRoot, ASADOS_COMPOSE_PROJECT: FIXTURE_PROJECT,
        PREFLIGHT_CALL_LOG: preflightLog, EVENTS_LOG: eventsLog,
        PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: scriptsDir,
        ...env,
      },
      encoding: 'utf8', timeout: 15000,
    })
  return { dir: pb.dir, scriptsDir, stateRoot, commandsLog: pb.commandsLog, preflightLog, eventsLog, runDeploy, cleanup: () => pb.cleanup() }
}

describe('web-only-preflight-wiring B1a preflight generation and consumer contracts', () => {
  it('aborts before any docker tag/up and preserves state when preflight exits nonzero (incl code 2)', () => {
    sb = createPreflightSandbox()
    for (const fault of ['exit2', 'exit1']) {
      const res = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE], { FAKE_PREFLIGHT_FAULT: fault })
      expect(res.status).not.toBe(0)
      const cmds = getCommands(sb.commandsLog)
      expect(cmds.some((c) => c.args?.includes('tag'))).toBe(false)
      expect(cmds.some((c) => c.args?.includes('up'))).toBe(false)
      expect(existsSync(join(sb.stateRoot, 'release.env'))).toBe(false)
    }
  })

  it('aborts before any tag/up and preserves state on malformed preflight JSON, missing keys, or ID mismatch', () => {
    sb = createPreflightSandbox()
    for (const fault of ['malformed_json', 'missing_keys', 'mismatched_ids']) {
      const res = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE], { FAKE_PREFLIGHT_FAULT: fault })
      expect(res.status).not.toBe(0)
      const cmds = getCommands(sb.commandsLog)
      expect(cmds.some((c) => c.args?.includes('tag'))).toBe(false)
      expect(cmds.some((c) => c.args?.includes('up'))).toBe(false)
      expect(existsSync(join(sb.stateRoot, 'release.env'))).toBe(false)
    }
  })

  it('rejects tampered generated bundle via REAL consumer before any tag/up and preserves state', () => {
    sb = createPreflightSandbox()
    // Test provisioning: verify REAL consumer validates untampered bundle and rejects tampered bundle with checksum error
    const pyCheck = spawnSync('/usr/bin/python3', ['-B', '-c', `
import sys, os, json
from web_only_bundle_writer import write_effective_bundle
from web_only_bundle_consumer import validate_effective_bundle
bdir = sys.argv[1]
ports, nets = [{"target": 3000, "published": 3020, "host_ip": "127.0.0.1", "protocol": "tcp"}], {"crm_default": {}}
c_doc = {"services": {"web": {"image": "${FIXTURE_CANDIDATE_IMAGE_ID}", "ports": ports, "networks": nets}}, "networks": {"crm_default": {"name": "crm_default", "external": True}}}
r_doc = {"services": {"web": {"image": "${FIXTURE_INITIAL_IMAGE_ID}", "ports": ports, "networks": nets}}, "networks": {"crm_default": {"name": "crm_default", "external": True}}}
meta = {"project": "${FIXTURE_PROJECT}", "service": "${FIXTURE_SERVICE}", "candidate_image_id": "${FIXTURE_CANDIDATE_IMAGE_ID}", "current_image_id": "${FIXTURE_INITIAL_IMAGE_ID}", "container_id": "${FIXTURE_CONTAINER_ID}", "container_name": "crm-sofia-web", "ports": ports[0], "networks": ["crm_default"]}
res = write_effective_bundle(bdir, (json.dumps(c_doc) + "\\n").encode(), (json.dumps(r_doc) + "\\n").encode(), manifest_metadata=meta)
assert validate_effective_bundle(bdir, res["manifest_sha256"], "${FIXTURE_PROJECT}", "${FIXTURE_CANDIDATE_IMAGE_ID}", "${FIXTURE_INITIAL_IMAGE_ID}", ["crm_default"])["status"] == "ok"
with open(os.path.join(bdir, "manifest.json"), "a") as f: f.write("corrupted\\n")
try:
    validate_effective_bundle(bdir, res["manifest_sha256"], "${FIXTURE_PROJECT}", "${FIXTURE_CANDIDATE_IMAGE_ID}", "${FIXTURE_INITIAL_IMAGE_ID}", ["crm_default"])
    sys.exit(99)
except ValueError as e:
    sys.exit(0 if "manifest sha mismatch" in str(e) else 98)
`, join(sb.dir, 'direct-bundle')], {
      cwd: sb.scriptsDir,
      env: { PYTHONDONTWRITEBYTECODE: '1', PYTHONPATH: sb.scriptsDir },
      encoding: 'utf8',
    })
    expect(pyCheck.status).toBe(0)
    // Deploy invocation: verify deploy wiring halts before any tag/up and logs no consumer success on tampered bundle
    const res = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE], { FAKE_PREFLIGHT_FAULT: 'tamper_bundle' })
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('manifest sha mismatch')
    const events = getCommands(sb.eventsLog)
    expect(events.some((e) => e.type === 'bundle_tampered')).toBe(true)
    const errEvent = events.find((e) => e.type === 'consumer_error')
    expect(errEvent).toBeDefined()
    expect(String(errEvent?.error)).toContain('manifest sha mismatch')
    expect(events.some((e) => e.type === 'consumer_success')).toBe(false)
    const cmds = getCommands(sb.commandsLog)
    expect(cmds.some((c) => c.args?.includes('tag'))).toBe(false)
    expect(cmds.some((c) => c.args?.includes('up'))).toBe(false)
    expect(existsSync(join(sb.stateRoot, 'release.env'))).toBe(false)
    expect(readdirSync(sb.stateRoot).some((f) => f.startsWith('bundle-'))).toBe(false)
  })

  it('successful generation and real validation reaches intentionally DENIED tag in order, without up or state change', () => {
    sb = createPreflightSandbox()
    const res = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE])
    expect(res.status).not.toBe(0)
    expect(readFileSync(sb.preflightLog, 'utf8')).toContain('generate-effective')
    // Independent event evidence proving real consumer succeeded strictly before tag invocation
    const events = getCommands(sb.eventsLog)
    const consumerIdx = events.findIndex((e) => e.type === 'consumer_success')
    const tagIdx = events.findIndex((e) => e.type === 'docker' && e.args?.includes('tag'))
    expect(consumerIdx).toBeGreaterThanOrEqual(0)
    expect(tagIdx).toBeGreaterThan(consumerIdx)
    const cmds = getCommands(sb.commandsLog)
    expect(cmds.some((c) => c.args?.includes('up'))).toBe(false)
    expect(existsSync(join(sb.stateRoot, 'release.env'))).toBe(false)
    expect(readdirSync(sb.stateRoot).some((f) => f.startsWith('bundle-'))).toBe(false)
  })

  it('rejects container-id parity mismatch before tag and leaves no bundle residue', () => {
    sb = createPreflightSandbox()
    const res = sb.runDeploy(['deploy', '--web-only', FIXTURE_CANDIDATE_CONFIG_IMAGE], { FAKE_LIVE_CONTAINER_ID: 'f'.repeat(64) })
    expect(res.status).not.toBe(0)
    expect(res.stderr).toContain('container_id parity mismatch')
    const cmds = getCommands(sb.commandsLog)
    expect(cmds.some((c) => c.args?.includes('tag'))).toBe(false)
    expect(readdirSync(sb.stateRoot).some((f) => f.startsWith('bundle-'))).toBe(false)
  })
})
