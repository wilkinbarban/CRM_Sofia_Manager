const baseUrl = process.env.EVOLUTION_API_URL?.replace(/\/+$/, '')
const apiKey = process.env.EVOLUTION_API_KEY

if (!baseUrl) {
  console.error('EVOLUTION_API_URL is required.')
  process.exit(2)
}

const headers = {
  Accept: 'application/json',
  Origin: process.env.NEXT_PUBLIC_APP_URL || 'https://crmsofiamanager.duckdns.org',
}

if (apiKey) headers.apikey = apiKey

const candidates = ['/docs-json', '/swagger-json', '/openapi.json', '/api-json']
let document
let source

for (const path of candidates) {
  const response = await fetch(`${baseUrl}${path}`, { headers })
  if (!response.ok) continue

  const body = await response.json().catch(() => null)
  if (body?.paths) {
    document = body
    source = path
    break
  }
}

if (!document) {
  console.error(`No OpenAPI document found at ${candidates.join(', ')}.`)
  process.exit(1)
}

const requiredSuffixes = [
  '/message/sendCarousel/{instance}',
  '/message/sendButtons/{instance}',
  '/message/sendList/{instance}',
  '/message/sendText/{instance}',
]
const paths = Object.keys(document.paths)
const missing = requiredSuffixes.filter(
  (suffix) => !paths.some((path) => path.endsWith(suffix) && document.paths[path]?.post),
)

if (missing.length > 0) {
  console.error(`OpenAPI ${source} is missing required POST endpoints: ${missing.join(', ')}`)
  process.exit(1)
}

console.log(`Evolution interactive contract verified from ${source}; no messages were sent.`)
