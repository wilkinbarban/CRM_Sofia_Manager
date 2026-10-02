#!/bin/sh
set -eu

restore_globals=false
if [ "$#" -eq 3 ] && [ "$1" = "--confirm" ] && [ "$2" = "--restore-globals" ]; then
  restore_globals=true
  backup_argument=$3
elif [ "$#" -eq 2 ] && [ "$1" = "--confirm" ]; then
  backup_argument=$2
else
  echo "Usage: $0 --confirm [--restore-globals] <backup-directory>" >&2
  exit 2
fi

here="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
backup="$(CDPATH= cd -- "$backup_argument" && pwd)"

(cd "$backup" && sha256sum -c SHA256SUMS)
cd "$here"

clients="api-gw auth rest realtime storage functions"
restart_clients() {
  docker compose up -d $clients >/dev/null
}
trap restart_clients EXIT

docker compose stop $clients >/dev/null

if [ "$restore_globals" = true ]; then
  docker compose exec -T db psql -U supabase_admin --dbname=postgres \
    --set=ON_ERROR_STOP=1 < "$backup/globals.sql"
fi

docker compose exec -T db pg_restore -U supabase_admin --dbname=postgres --clean --if-exists --exit-on-error < "$backup/database.dump"

docker run --rm \
  -v "$here/volumes:/volumes" \
  -v "$backup:/backup:ro" \
  alpine:3.22 sh -c 'rm -rf /volumes/storage && tar -C /volumes -xzf /backup/storage.tar.gz'

restart_clients
trap - EXIT HUP INT TERM
echo "Restore completed from $backup"
