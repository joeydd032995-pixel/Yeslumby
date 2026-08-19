#!/usr/bin/env bash
# Local Postgres + pgvector cluster for development and integration tests.
#
# Postgres refuses to run as root, so every server command is executed as the
# `postgres` system user. The cluster lives inside the repo (gitignored) so a
# fresh checkout can stand one up without touching system state.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGDATA="${PGDATA:-$REPO_ROOT/.pgdata}"
PGPORT="${PGPORT:-5433}"
PGSOCKET="${PGSOCKET:-/tmp/meta-ecosystem-pg}"
DB_NAME="${DB_NAME:-meta_ecosystem}"
TEST_DB_NAME="${TEST_DB_NAME:-meta_ecosystem_test}"
LOGFILE="$PGDATA/server.log"

as_postgres() {
  # `runuser` keeps us off a login shell and avoids PAM noise in containers.
  runuser -u postgres -- "$@"
}

ensure_dirs() {
  mkdir -p "$PGSOCKET"
  chown postgres:postgres "$PGSOCKET"
  # The data dir's parent must be traversable by the postgres user.
  chmod o+x "$REPO_ROOT"
}

is_running() {
  as_postgres "$PGBIN/pg_ctl" -D "$PGDATA" status >/dev/null 2>&1
}

init() {
  if [ -s "$PGDATA/PG_VERSION" ]; then
    echo "cluster already initialized at $PGDATA"
    return
  fi
  echo "initializing cluster at $PGDATA"
  mkdir -p "$PGDATA"
  chown postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  as_postgres "$PGBIN/initdb" -D "$PGDATA" -U postgres --auth=trust --encoding=UTF8 >/dev/null
}

start() {
  ensure_dirs
  init
  if is_running; then
    echo "postgres already running on port $PGPORT"
    return
  fi
  echo "starting postgres on port $PGPORT"
  as_postgres "$PGBIN/pg_ctl" -D "$PGDATA" -l "$LOGFILE" \
    -o "-p $PGPORT -k $PGSOCKET -c listen_addresses=127.0.0.1" \
    -w -t 60 start
}

stop() {
  if is_running; then
    as_postgres "$PGBIN/pg_ctl" -D "$PGDATA" -m fast -w stop
    echo "postgres stopped"
  else
    echo "postgres not running"
  fi
}

create_db() {
  local name="$1"
  if as_postgres psql -h "$PGSOCKET" -p "$PGPORT" -U postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='$name'" | grep -q 1; then
    echo "database $name exists"
  else
    as_postgres createdb -h "$PGSOCKET" -p "$PGPORT" -U postgres "$name"
    echo "created database $name"
  fi
  as_postgres psql -h "$PGSOCKET" -p "$PGPORT" -U postgres -d "$name" \
    -c "CREATE EXTENSION IF NOT EXISTS vector;" >/dev/null
  echo "pgvector ready on $name"
}

case "${1:-up}" in
  up)
    start
    create_db "$DB_NAME"
    create_db "$TEST_DB_NAME"
    echo
    echo "DATABASE_URL=postgresql://postgres@127.0.0.1:$PGPORT/$DB_NAME"
    echo "TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:$PGPORT/$TEST_DB_NAME"
    ;;
  start) start ;;
  stop) stop ;;
  status)
    if is_running; then
      as_postgres "$PGBIN/pg_ctl" -D "$PGDATA" status
    else
      echo "not running"; exit 1
    fi
    ;;
  reset)
    stop || true
    rm -rf "$PGDATA"
    echo "cluster removed"
    "$0" up
    ;;
  psql)
    shift
    as_postgres psql -h "$PGSOCKET" -p "$PGPORT" -U postgres -d "${DB_NAME}" "$@"
    ;;
  *)
    echo "usage: $0 {up|start|stop|status|reset|psql}" >&2
    exit 1
    ;;
esac
