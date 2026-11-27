#!/usr/bin/env bash
# BUD-1139 / BUD-1142: Live cutover script for Paperclip fork bump to v2026.1117.0.
#
# Usage:
#   bash scripts/ops/BUD-1139-bump.sh --dry-run
#   bash scripts/ops/BUD-1139-bump.sh --apply
#   bash scripts/ops/BUD-1139-bump.sh --rollback <BACKUP_DIR>
#   bash scripts/ops/BUD-1139-bump.sh --rollback-db-only <BACKUP_DIR>
#
# Environment overrides:
#   DATABASE_URL   Postgres connection string (default: embedded Postgres on 127.0.0.1:54329)
#   BACKUP_ROOT    Directory for timestamped backups (default: ~/.paperclip/cli/bu-bump-backups)
#   HEALTH_URL     Health endpoint URL (default: http://127.0.0.1:3100/api/health)
#   PG_DOCKER_IMG  Fallback Docker image when pg_dump/pg_restore/psql are not on PATH (default: postgres:18)
set -euo pipefail
umask 077

TARGET_VERSION="2026.1117.0"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BACKUP_ROOT="${BACKUP_ROOT:-$HOME/.paperclip/cli/bu-bump-backups}"
HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3100/api/health}"
DB_URL="${DATABASE_URL:-postgres://paperclip:paperclip@127.0.0.1:54329/paperclip}"
PG_DOCKER_IMG="${PG_DOCKER_IMG:-postgres:18}"
SERVICE_NAME="${PAPERCLIP_SYSTEMD_SERVICE:-paperclipai.service}"
export PATH="$HOME/.local/bin:/home/linuxbrew/.linuxbrew/bin:$PATH"

usage() {
  echo "Usage: $0 --dry-run | --apply | --rollback BACKUP_DIR | --rollback-db-only BACKUP_DIR" >&2
  exit 2
}

step() {
  echo ""
  echo "==> $1"
}

check_lockfile_sync() {
  local mode="${1:-strict}"
  if ! command -v pnpm >/dev/null 2>&1; then
    echo "ERROR: pnpm is not installed on PATH." >&2
    return 1
  fi
  if (cd "$REPO" && pnpm install --frozen-lockfile --lockfile-only --ignore-scripts >/dev/null 2>&1); then
    echo "OK: pnpm-lock.yaml is in sync with workspace package.json files."
    return 0
  fi
  if [ "$mode" = "dry-run" ]; then
    echo "WARNING: pnpm-lock.yaml is OUT OF SYNC with workspace package.json files."
    echo "         --apply will abort until pnpm-lock.yaml is refreshed (e.g. merge lockfile refresh PR first)."
    return 0
  fi
  echo "ERROR: pnpm-lock.yaml is out of sync with workspace package.json files." >&2
  echo "       Refresh pnpm-lock.yaml (merge the lockfile refresh PR) before running --apply." >&2
  return 1
}

pg_tool_mode() {
  if command -v pg_dump >/dev/null 2>&1 && command -v pg_restore >/dev/null 2>&1 && command -v psql >/dev/null 2>&1; then
    echo "native"
  elif command -v docker >/dev/null 2>&1; then
    echo "docker:$PG_DOCKER_IMG"
  else
    echo "missing"
  fi
}

parse_db_url() {
  local field="$1"
  node -e '
    const u = new URL(process.argv[1]);
    const field = process.argv[2];
    const dbName = decodeURIComponent(u.pathname.replace(/^\/+/, "")) || "paperclip";
    const dbOwner = decodeURIComponent(u.username || "") || "paperclip";
    if (field === "name") {
      process.stdout.write(dbName);
    } else if (field === "owner") {
      process.stdout.write(dbOwner);
    } else if (field === "port") {
      process.stdout.write(u.port || "5432");
    } else if (field === "admin_url") {
      u.pathname = "/postgres";
      process.stdout.write(u.toString());
    } else {
      process.exit(1);
    }
  ' "$DB_URL" "$field"
}

run_psql() {
  local conn_url="$1"
  shift
  if command -v psql >/dev/null 2>&1; then
    psql "$conn_url" -v ON_ERROR_STOP=1 "$@"
  else
    docker run --rm --network host "$PG_DOCKER_IMG" \
      psql "$conn_url" -v ON_ERROR_STOP=1 "$@"
  fi
}

run_pg_dump() {
  local out_file="$1"
  local out_dir out_base
  out_dir="$(dirname "$out_file")"
  out_base="$(basename "$out_file")"
  if command -v pg_dump >/dev/null 2>&1; then
    pg_dump --dbname "$DB_URL" --format=custom --file "$out_file"
  else
    docker run --rm --network host --user "$(id -u):$(id -g)" \
      -v "$out_dir:/backup" "$PG_DOCKER_IMG" \
      pg_dump --dbname "$DB_URL" --format=custom --file "/backup/$out_base"
  fi
}

run_pg_restore_list() {
  local dump_file="$1"
  local dump_dir dump_base
  dump_dir="$(dirname "$dump_file")"
  dump_base="$(basename "$dump_file")"
  if command -v pg_restore >/dev/null 2>&1; then
    pg_restore --list "$dump_file" >/dev/null
  else
    docker run --rm -v "$dump_dir:/backup:ro" "$PG_DOCKER_IMG" \
      pg_restore --list "/backup/$dump_base" >/dev/null
  fi
}

run_pg_restore() {
  local dump_file="$1"
  local dump_dir dump_base admin_url db_name db_owner
  dump_dir="$(dirname "$dump_file")"
  dump_base="$(basename "$dump_file")"
  admin_url="$(parse_db_url admin_url)"
  db_name="$(parse_db_url name)"
  db_owner="$(parse_db_url owner)"

  if [[ ! "$db_name" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || [[ ! "$db_owner" =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]]; then
    echo "ERROR: Unsafe database name ('$db_name') or owner ('$db_owner') parsed from DATABASE_URL." >&2
    return 1
  fi
  if [ "$db_name" = "postgres" ] || [ "$db_name" = "template0" ] || [ "$db_name" = "template1" ]; then
    echo "ERROR: Refusing to drop system database '$db_name'." >&2
    return 1
  fi

  echo "Recreating empty database \"$db_name\" (owner \"$db_owner\") via admin DB 'postgres'..."
  run_psql "$admin_url" -c "DROP DATABASE IF EXISTS \"$db_name\" WITH (FORCE);"
  run_psql "$admin_url" -c "CREATE DATABASE \"$db_name\" OWNER \"$db_owner\";"

  echo "Restoring archive into empty database \"$db_name\"..."
  if command -v pg_restore >/dev/null 2>&1; then
    pg_restore --exit-on-error --no-owner --no-privileges --dbname "$DB_URL" "$dump_file"
  else
    docker run --rm --network host -v "$dump_dir:/backup:ro" "$PG_DOCKER_IMG" \
      pg_restore --exit-on-error --no-owner --no-privileges --dbname "$DB_URL" "/backup/$dump_base"
  fi
}

# Embedded Postgres runs inside the Paperclip service, so it is down whenever the
# service is stopped. Rollback restores the DB with the service stopped, so it
# starts the cluster on its own with the active payload's pg_ctl, then stops it.
PG_DATA_DIR="${PAPERCLIP_PG_DATA_DIR:-$HOME/.paperclip/instances/default/db}"
standalone_pg=0

pg_ctl_bin() {
  echo "$HOME/.paperclip/cli/current/node_modules/@embedded-postgres/linux-x64/native/bin/pg_ctl"
}

start_standalone_pg() {
  if [ -n "${DATABASE_URL:-}" ]; then
    echo "DATABASE_URL is set; assuming an external Postgres that is already running."
    return 0
  fi
  local pg_ctl port
  pg_ctl="$(pg_ctl_bin)"
  [ -x "$pg_ctl" ] || { echo "ERROR: embedded pg_ctl not found at $pg_ctl" >&2; return 1; }
  if "$pg_ctl" -D "$PG_DATA_DIR" status >/dev/null 2>&1; then
    echo "Embedded Postgres is already running."
    return 0
  fi
  port="$(parse_db_url port)"
  echo "Starting embedded Postgres on its own (port $port) for the restore..."
  "$pg_ctl" -D "$PG_DATA_DIR" -o "-p $port -c listen_addresses=127.0.0.1" -l "$PG_DATA_DIR/../bu-bump-standalone-pg.log" -w start
  standalone_pg=1
}

stop_standalone_pg() {
  [ "$standalone_pg" = 1 ] || return 0
  echo "Stopping the standalone embedded Postgres..."
  "$(pg_ctl_bin)" -D "$PG_DATA_DIR" -m fast -w stop
  standalone_pg=0
}

check_health() {
  local response
  for _ in $(seq 1 40); do
    response="$(curl --silent --show-error --max-time 5 "$HEALTH_URL" || true)"
    if node -e 'const d = JSON.parse(process.argv[1]); process.exit(d && d.status === "ok" ? 0 : 1);' "$response" 2>/dev/null; then
      echo "Health OK: $response"
      return 0
    fi
    sleep 3
  done
  echo "ERROR: Health check did not become ready at $HEALTH_URL" >&2
  return 1
}

case "${1:-}" in
  --dry-run)
    pg_mode="$(pg_tool_mode)"
    echo "=== BUD-1139 Paperclip Fork Bump (--dry-run) ==="
    echo "Target version : $TARGET_VERSION"
    echo "Repository     : $REPO"
    echo "Git HEAD       : $(git -C "$REPO" rev-parse --short HEAD) ($(git -C "$REPO" branch --show-current || echo detached))"
    echo "Backup root    : $BACKUP_ROOT/<timestamp>"
    echo "Health URL     : $HEALTH_URL"
    echo "pg_dump mode   : $pg_mode"

    step "Step 1/5: Preflight lockfile sync check"
    check_lockfile_sync dry-run

    step "Step 2/5: Pre-update database backup"
    echo "[dry-run] Would back up database via $pg_mode pg_dump (custom format) to:"
    echo "          $BACKUP_ROOT/<timestamp>/database.dump"
    echo "[dry-run] Would verify archive integrity with pg_restore --list"

    step "Step 3/5: Stop $SERVICE_NAME, then switch the managed install to $TARGET_VERSION"
    echo "[dry-run] Would run: systemctl --user stop $SERVICE_NAME"
    echo "[dry-run] Would run: paperclipai update --version $TARGET_VERSION --yes --no-backup"
    echo "          (the service stays stopped, so stock $TARGET_VERSION never boots or migrates the DB)"

    step "Step 4/5: Build & apply Bu fork overlay, then start the service"
    echo "[dry-run] Would run: bash $REPO/scripts/bu/overlay-deploy.sh"
    echo "          (the first boot is the fork server, which applies the fork's migrations)"

    step "Step 5/5: Verify /api/health and active CLI version"
    echo "[dry-run] Would poll $HEALTH_URL for status == \"ok\""
    echo "[dry-run] Would verify: paperclipai --version contains $TARGET_VERSION"

    step "Rollback plan"
    echo "[dry-run] Rollback command:"
    echo "          bash $REPO/scripts/ops/BUD-1139-bump.sh --rollback $BACKUP_ROOT/<timestamp>"
    echo "          (stops $SERVICE_NAME, flips managed install back via paperclipai update --rollback, starts embedded Postgres on its own, drops/recreates DB and runs pg_restore --exit-on-error --no-owner --no-privileges, restarts service, checks $HEALTH_URL)"
    ;;

  --apply)
    step "Step 1/5: Preflight checks (tools + lockfile sync)"
    for cmd in paperclipai curl node systemctl; do
      command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: required command '$cmd' not found on PATH." >&2; exit 1; }
    done
    pg_mode="$(pg_tool_mode)"
    if [ "$pg_mode" = "missing" ]; then
      echo "ERROR: neither pg_dump/pg_restore nor docker is available on PATH." >&2
      exit 1
    fi
    echo "Using pg_dump/pg_restore mode: $pg_mode"
    check_lockfile_sync strict

    step "Step 2/5: Pre-update database backup"
    stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
    backup="$BACKUP_ROOT/$stamp"
    mkdir -p "$backup"
    echo "Writing custom-format pg_dump to $backup/database.dump"
    run_pg_dump "$backup/database.dump"
    run_pg_restore_list "$backup/database.dump"
    printf '%s\n' "$TARGET_VERSION" > "$backup/target-version.txt"
    printf '%s\n' "$(paperclipai --version 2>/dev/null || echo unknown)" > "$backup/previous-version.txt"
    printf '%s\n' "$(git -C "$REPO" rev-parse HEAD)" > "$backup/fork-commit.txt"
    echo "Backup verified at $backup"
    echo "If any later step fails, roll back with:"
    echo "  bash $REPO/scripts/ops/BUD-1139-bump.sh --rollback $backup"

    # Stop first. 'paperclipai update' restarts an active service, which would boot
    # stock $TARGET_VERSION and run its migrations before the fork overlay is in place
    # (stock 0324 drops 'whatsapp' from chat_endpoints_provider_check and fails on our
    # rows). With the service stopped it only switches the payload.
    step "Step 3/5: Stop $SERVICE_NAME and switch the managed install to $TARGET_VERSION"
    systemctl --user stop "$SERVICE_NAME"
    paperclipai update --version "$TARGET_VERSION" --yes --no-backup
    if systemctl --user is-active --quiet "$SERVICE_NAME"; then
      echo "ERROR: $SERVICE_NAME is running stock $TARGET_VERSION; it must stay stopped until the overlay is applied." >&2
      echo "Rollback with: bash $REPO/scripts/ops/BUD-1139-bump.sh --rollback $backup" >&2
      exit 1
    fi
    if [[ "$(paperclipai --version 2>/dev/null || true)" != *"$TARGET_VERSION"* ]]; then
      echo "ERROR: managed install did not switch to $TARGET_VERSION." >&2
      echo "Rollback with: bash $REPO/scripts/ops/BUD-1139-bump.sh --rollback $backup" >&2
      exit 1
    fi

    step "Step 4/5: Apply Bu fork overlay and start $SERVICE_NAME"
    if ! bash "$REPO/scripts/bu/overlay-deploy.sh"; then
      echo "ERROR: overlay deploy failed." >&2
      echo "Rollback with: bash $REPO/scripts/ops/BUD-1139-bump.sh --rollback $backup" >&2
      exit 1
    fi

    step "Step 5/5: Verify /api/health and active CLI version"
    check_health
    active_version="$(paperclipai --version)"
    echo "Active CLI version: $active_version"
    if [[ "$active_version" != *"$TARGET_VERSION"* ]]; then
      echo "ERROR: Active CLI version '$active_version' does not contain '$TARGET_VERSION'." >&2
      echo "Rollback with: bash $REPO/scripts/ops/BUD-1139-bump.sh --rollback $backup" >&2
      exit 1
    fi
    echo ""
    echo "Cutover succeeded ($TARGET_VERSION). Keep backup until verified: $backup"
    ;;

  --rollback)
    backup="${2:-}"
    [ -n "$backup" ] && [ -f "$backup/database.dump" ] && [ -f "$backup/target-version.txt" ] || usage
    [ ! -e "$backup/rolled-back" ] || { echo "ERROR: Backup $backup was already restored." >&2; exit 1; }

    step "Rollback 1/5: Preflight checks and backup verification"
    for cmd in paperclipai systemctl curl node; do
      command -v "$cmd" >/dev/null 2>&1 || { echo "ERROR: required command '$cmd' not found on PATH." >&2; exit 1; }
    done
    pg_mode="$(pg_tool_mode)"
    if [ "$pg_mode" = "missing" ]; then
      echo "ERROR: neither pg_restore nor docker is available on PATH." >&2
      exit 1
    fi
    run_pg_restore_list "$backup/database.dump"
    echo "Backup archive verified ($pg_mode)."

    step "Rollback 2/5: Stopping $SERVICE_NAME"
    systemctl --user stop "$SERVICE_NAME"

    step "Rollback 3/5: Restoring previous managed install / overlay files"
    if [ -L "$HOME/.paperclip/cli/overlay-backups/current" ]; then
      echo "Overlay backup detected; no separate overlay restore is needed because 'paperclipai update --rollback' flips back to the previous managed payload, which still has its original overlay."
    fi
    if [[ "$(paperclipai --version 2>/dev/null || true)" == *"$TARGET_VERSION"* ]]; then
      echo "Flipping managed install back with: paperclipai update --rollback"
      paperclipai update --rollback
    else
      echo "Active CLI is already outside $TARGET_VERSION; skipping paperclipai update --rollback."
    fi

    step "Rollback 4/5: Restoring pre-update database from $backup/database.dump"
    trap stop_standalone_pg EXIT
    start_standalone_pg
    run_pg_restore "$backup/database.dump"
    stop_standalone_pg
    trap - EXIT

    step "Rollback 5/5: Starting $SERVICE_NAME and verifying health"
    systemctl --user start "$SERVICE_NAME"
    check_health
    touch "$backup/rolled-back"
    echo ""
    echo "Rollback succeeded. Restored from: $backup"
    ;;

  --rollback-db-only)
    backup="${2:-}"
    [ -n "$backup" ] && [ -f "$backup/database.dump" ] || usage

    step "Rollback DB-only 1/2: Preflight checks and backup verification (skipping systemctl & paperclipai)"
    command -v node >/dev/null 2>&1 || { echo "ERROR: required command 'node' not found on PATH." >&2; exit 1; }
    pg_mode="$(pg_tool_mode)"
    if [ "$pg_mode" = "missing" ]; then
      echo "ERROR: neither pg_restore/psql nor docker is available on PATH." >&2
      exit 1
    fi
    run_pg_restore_list "$backup/database.dump"
    echo "Backup archive verified ($pg_mode)."

    step "Rollback DB-only 2/2: Recreating database and restoring from $backup/database.dump"
    run_pg_restore "$backup/database.dump"
    echo ""
    echo "DB-only rollback succeeded. Restored from: $backup"
    ;;

  *)
    usage
    ;;
esac
