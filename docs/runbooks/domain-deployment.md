# Domain deployment

The host has one shared ingress: `portfolio-nginx` in `/home/wilkin/proyectos/Portafolio`. Do not start a second listener on ports 80 or 443.

## Routing

The ingress joins `asados-app-private` and `asados-supabase-private`. It proxies the application to `asados-web:3000` and only the public Supabase data-plane routes to `api-gw:8000`. Studio, Meta, databases, Redis, and Evolution remain private.

Container addresses are ephemeral. The Asados HTTPS server must keep Docker's embedded resolver and variable-based upstreams:

```nginx
resolver 127.0.0.11 valid=10s ipv6=off;
resolver_timeout 5s;

set $asados_api_upstream http://api-gw:8000;
set $asados_web_upstream http://asados-web:3000;
```

Both Asados `proxy_pass` directives must use these variables. A static hostname in `proxy_pass` is resolved when Nginx loads its configuration and can leave the ingress pointing to a stale IP after an upstream container is recreated.

## Certificate

Certificates and ACME challenges use the `portafolio_letsencrypt` and `portafolio_certbot-www` volumes. The certificate is renewed by the existing daily job:

```text
17 3 * * * /home/wilkin/proyectos/Trindade/scripts/renew-certbot.sh
```

Validate renewal without changing the live certificate:

```bash
cd /home/wilkin/proyectos/Portafolio
docker compose --profile ssl run --rm certbot renew \
  --cert-name crmsofiamanager.duckdns.org --dry-run
```

## DuckDNS record lifetime

DuckDNS deletes a record that receives no update for 30 days, and nothing on this host keeps
`crmsofiamanager.duckdns.org` alive: the crontab contains only the certificate renewal job and
there is no DuckDNS systemd timer. That is how the previous record disappeared, and with it the
name the live certificate had been issued for.

Before a promotion, confirm the record still resolves to this host's public IP:

```bash
resolved="$(getent ahostsv4 crmsofiamanager.duckdns.org | awk 'NR == 1 { print $1 }')"
public="$(curl --fail --silent --show-error https://api.ipify.org)"
printf 'record=%s public=%s\n' "$resolved" "$public"
test -n "$resolved" && test "$resolved" = "$public"
```

Both values must agree before the ingress or the certificate is changed. An update must be sent to
DuckDNS at least once every 30 days to keep the record registered.

## Verification

Check the exact certificate SAN, HTTP redirect, HTTPS response and headers, `/api/health/live`, `/api/health/ready`, Realtime WebSocket upgrade, administrative-route denial, loopback-only listeners, and Nginx/application logs after each ingress change.

### Verify upstream recreation without restarting the ingress

Record the ingress start timestamp, recreate the Web upstream, and wait for Docker DNS re-resolution:

```bash
cd /home/wilkin/proyectos/Portafolio
ingress_started_at="$(docker inspect portfolio-nginx --format '{{.State.StartedAt}}')"

cd /home/wilkin/proyectos/Asados
docker compose up -d --force-recreate web
sleep 12

curl --fail --silent --show-error --output /dev/null \
  https://crmsofiamanager.duckdns.org/
curl --fail --silent --show-error \
  https://crmsofiamanager.duckdns.org/api/health/live
curl --fail --silent --show-error \
  https://crmsofiamanager.duckdns.org/api/health/ready

test "$ingress_started_at" = \
  "$(docker inspect portfolio-nginx --format '{{.State.StartedAt}}')"
```

The three requests must succeed, and the final comparison must return zero. Do not restart or recreate `portfolio-nginx` during this test: that would hide stale-DNS regressions instead of proving dynamic resolution.
