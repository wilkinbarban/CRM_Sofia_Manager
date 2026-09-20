/**
 * Evolution's strict CORS callback rejects requests without an allowed Origin.
 */
export function evolutionHeaders(apikey: string): Record<string, string> {
  return {
    apikey,
    'Content-Type': 'application/json',
    Origin: process.env.NEXT_PUBLIC_APP_URL || 'https://crmsofiamanager.duckdns.org',
  }
}
