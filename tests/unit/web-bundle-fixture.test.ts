import { describe, expect, it, afterEach } from 'vitest'
import {
  existsSync, renameSync, symlinkSync, rmSync, mkdtempSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createPrivateSandbox, type PrivateSandbox } from '../helpers/web-private-sandbox'
import {
  createBundleFixture,
  FIXTURE_CANDIDATE_IMAGE_ID,
  FIXTURE_CURRENT_IMAGE_ID,
  FIXTURE_PROJECT,
} from '../helpers/web-bundle-fixture'

let sb: PrivateSandbox | null = null

afterEach(() => {
  if (sb) {
    sb.cleanup()
    sb = null
  }
})

describe('web-bundle-fixture U2.3a-ii.2 fixture and serialization test harness', () => {
  it('creates valid bundle and state verified by committed writer, consumer, and state contracts', () => {
    sb = createPrivateSandbox()
    const fixture = createBundleFixture(sb)

    expect(existsSync(fixture.bundleDir)).toBe(true)
    expect(fixture.manifestSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(fixture.state.STATE_VERSION).toBe('2')
    expect(fixture.state.DEPLOY_MODE).toBe('web-only')
    expect(fixture.state.DEPLOYED_ID).toBe(FIXTURE_CANDIDATE_IMAGE_ID)
    expect(fixture.state.PREVIOUS_ID).toBe(FIXTURE_CURRENT_IMAGE_ID)
    expect(fixture.state.COMPOSE_PROJECT).toBe(FIXTURE_PROJECT)
    expect(fixture.serializedState).toContain("STATE_VERSION='2'")

    const verifyScript = `
import sys, json
import scripts.web_only_state as ws
import scripts.web_only_bundle_consumer as c

data = json.loads(sys.argv[1])
state = data["state"]
args = data["args"]

validated = ws.validate_v2_bundle_state(state, **args)
assert validated["candidate_image_id"] == state["DEPLOYED_ID"]
assert validated["current_image_id"] == state["PREVIOUS_ID"]

consumer_val = c.validate_effective_bundle(
    state["BUNDLE_DIR"], state["MANIFEST_SHA256"], args["expected_project"],
    state["DEPLOYED_ID"], state["PREVIOUS_ID"], args["expected_networks"],
)
assert consumer_val["candidate_image_id"] == state["DEPLOYED_ID"]
sys.stdout.write("CONTRACTS_VERIFIED")
`
    const payload = JSON.stringify({ state: fixture.state, args: fixture.expectedArgs })
    const res = sb.runPython(verifyScript, { args: [payload] })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('CONTRACTS_VERIFIED')
  })

  it('roundtrips serialized state through parse_v2_release_env and enforces forbidden char rejection', () => {
    sb = createPrivateSandbox()
    const fixture = createBundleFixture(sb)

    const roundtripScript = `
import sys, json
import scripts.web_only_state as ws
import scripts.web_only_state_serializer as wss

data = json.loads(sys.argv[1])
raw = data["serialized"]
expected_state = data["state"]

parsed = ws.parse_v2_release_env(raw)
assert parsed == expected_state

reserialized = wss.serialize_v2_release_env(parsed)
assert reserialized == raw

for bad in ["$var", "\`cmd\`", "es\\\\cape", "quote'"]:
    bad_st = dict(expected_state, RECORDED_AT=bad)
    try:
        wss.serialize_v2_release_env(bad_st)
        sys.exit(2)
    except ValueError:
        pass

sys.stdout.write("ROUNDTRIP_AND_REJECTIONS_OK")
`
    const payload = JSON.stringify({ serialized: fixture.serializedState, state: fixture.state })
    const res = sb.runPython(roundtripScript, { args: [payload] })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('ROUNDTRIP_AND_REJECTIONS_OK')
  })

  it('handles subdirs with spaces safely via argv without shell expansion', () => {
    sb = createPrivateSandbox()
    const fixture = createBundleFixture(sb, { subdir: 'space dir/nested target' })

    expect(existsSync(fixture.bundleDir)).toBe(true)
    expect(fixture.bundleDir).toContain('space dir/nested target')
    expect(fixture.state.OPERATIONAL_ROOT).toBe(sb.dir)

    const checkScript = `
import sys, os
bdir = sys.argv[1]
assert os.path.isdir(bdir)
assert os.path.isfile(os.path.join(bdir, "manifest.json"))
sys.stdout.write("SPACES_OK")
`
    const res = sb.runPython(checkScript, { args: [fixture.bundleDir] })
    expect(res.status).toBe(0)
    expect(res.stdout).toBe('SPACES_OK')
  })

  it('rejects path traversal, absolute paths, and external escapes in subdir', () => {
    sb = createPrivateSandbox()
    expect(() => createBundleFixture(sb!, { subdir: '../escape' })).toThrow(/inside sandbox/i)
    expect(() => createBundleFixture(sb!, { subdir: '/absolute/path' })).toThrow(/relative/i)
    expect(() => createBundleFixture(sb!, { subdir: 'a/../../escape' })).toThrow(/inside sandbox/i)
    expect(() => createBundleFixture(null as unknown as PrivateSandbox)).toThrow(/Valid PrivateSandbox/i)
  })

  it('rejects sandbox root replacement and symlinked root before writes', () => {
    sb = createPrivateSandbox()
    const orig = sb.dir
    const backup = orig + '-bak'
    renameSync(orig, backup)
    symlinkSync(backup, orig)
    try {
      expect(() => createBundleFixture(sb!)).toThrow(/symlink/i)
    } finally {
      rmSync(orig, { force: true })
      renameSync(backup, orig)
      sb.cleanup()
      sb = null
    }

    sb = createPrivateSandbox()
    const origRoot = sb.dir
    const rootBackup = origRoot + '-devino-bak'
    const foreignRoot = mkdtempSync(join(tmpdir(), 'foreign-sb-'))
    const foreignSentinel = join(foreignRoot, 'foreign-sentinel.txt')
    writeFileSync(foreignSentinel, 'foreign-sentinel-data')

    renameSync(origRoot, rootBackup)
    renameSync(foreignRoot, origRoot)
    try {
      expect(() => createBundleFixture(sb!)).toThrow(/identity changed|dev\/ino/i)
      expect(existsSync(join(origRoot, 'bundle'))).toBe(false)
      expect(existsSync(join(origRoot, 'manifest.json'))).toBe(false)

      expect(() => sb!.cleanup()).toThrow(/replaced root/i)
      expect(existsSync(join(origRoot, 'foreign-sentinel.txt'))).toBe(true)
    } finally {
      renameSync(origRoot, foreignRoot)
      renameSync(rootBackup, origRoot)
      rmSync(foreignRoot, { recursive: true, force: true })
      sb.cleanup()
      sb = null
    }
  })

  it('rejects internal component symlinks in fixture subdir and writes nothing externally', () => {
    sb = createPrivateSandbox()
    const ownedSibling = sb.mkdir('owned-sibling')
    const symlinkPath = join(sb.dir, 'component-symlink')
    symlinkSync(ownedSibling, symlinkPath)

    try {
      expect(() => createBundleFixture(sb!, { subdir: 'component-symlink/child' })).toThrow(/symlink/i)
      expect(() => createBundleFixture(sb!, { subdir: 'component-symlink' })).toThrow(/symlink/i)
      expect(existsSync(join(ownedSibling, 'bundle'))).toBe(false)
      expect(existsSync(join(ownedSibling, 'child'))).toBe(false)
    } finally {
      rmSync(symlinkPath, { force: true })
    }
  })

  it('isolates ambient credential marker hermetically and restores environment without leak', () => {
    sb = createPrivateSandbox()
    const definedKey = 'AMBIENT_DEFINED_MARKER_' + Date.now()
    const undefinedKey = 'AMBIENT_UNDEFINED_MARKER_' + Date.now()

    process.env[definedKey] = 'fake-preexisting-value'
    delete process.env[undefinedKey]

    const originalDefined = process.env[definedKey]
    const originalUndefined = process.env[undefinedKey]

    try {
      process.env[definedKey] = 'fake-temp-defined-marker'
      process.env[undefinedKey] = 'fake-temp-undefined-marker'

      expect(process.env[definedKey]).toBe('fake-temp-defined-marker')
      expect(process.env[undefinedKey]).toBe('fake-temp-undefined-marker')

      const probeScript = `
import sys, os
val_def = os.environ.get(sys.argv[1])
val_undef = os.environ.get(sys.argv[2])
if not val_def and not val_undef:
    sys.stdout.write("ABSENT_BOTH")
`
      const res = sb.runPython(probeScript, { args: [definedKey, undefinedKey] })
      expect(res.status).toBe(0)
      expect(res.stdout).toBe('ABSENT_BOTH')
    } finally {
      if (originalDefined === undefined) {
        delete process.env[definedKey]
      } else {
        process.env[definedKey] = originalDefined
      }

      if (originalUndefined === undefined) {
        delete process.env[undefinedKey]
      } else {
        process.env[undefinedKey] = originalUndefined
      }
    }

    expect(process.env[definedKey]).toBe('fake-preexisting-value')
    expect(process.env[undefinedKey]).toBeUndefined()
    delete process.env[definedKey]
  })
})
