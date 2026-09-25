#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

usage() {
  cat <<'USAGE'
Usage:
  PORTFOLIOAI_RESTORE_DATABASE_URL='postgresql://...' \
  PORTFOLIOAI_AGE_RECIPIENT='age1...' \
  ./scripts/restore-portfolioai-backup.sh \
    --archive /path/to/portfolioai-db-....tar.age \
    --identity /path/to/portfolioai-backup-key.txt \
    --source-project-ref SOURCE_REF \
    --target-project-ref TARGET_REF \
    --disposable-test \
    --confirm 'RESTORE PORTFOLIOAI DATABASE'

Production restore is intentionally unavailable until a disposable-project
restore is certified. See docs/database-backup-and-recovery.md.
USAGE
}

archive=""
identity=""
source_ref=""
target_ref=""
confirmation=""
disposable_test=false
certification_file=""

while (($#)); do
  case "$1" in
    --archive) archive="${2:-}"; shift 2 ;;
    --identity) identity="${2:-}"; shift 2 ;;
    --source-project-ref) source_ref="${2:-}"; shift 2 ;;
    --target-project-ref) target_ref="${2:-}"; shift 2 ;;
    --confirm) confirmation="${2:-}"; shift 2 ;;
    --disposable-test) disposable_test=true; shift ;;
    --certification-file) certification_file="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$archive" && -f "$archive" ]] || { echo "Encrypted archive not found." >&2; exit 2; }
[[ -n "$identity" && -f "$identity" ]] || { echo "Offline age identity not found." >&2; exit 2; }
[[ -n "$source_ref" && -n "$target_ref" ]] || { echo "Source and target project refs are required." >&2; exit 2; }
[[ "$confirmation" == "RESTORE PORTFOLIOAI DATABASE" ]] || { echo "Exact confirmation phrase required." >&2; exit 2; }
[[ -n "${PORTFOLIOAI_RESTORE_DATABASE_URL:-}" ]] || { echo "PORTFOLIOAI_RESTORE_DATABASE_URL is required." >&2; exit 2; }
[[ "${PORTFOLIOAI_AGE_RECIPIENT:-}" == age1* ]] || { echo "PORTFOLIOAI_AGE_RECIPIENT is required for the target safety backup." >&2; exit 2; }

if [[ "$disposable_test" != true ]]; then
  [[ -n "$certification_file" && -f "$certification_file" ]] || {
    echo "Production restore is disabled until a disposable restore is certified." >&2
    exit 2
  }
  grep -Fxq 'PORTFOLIOAI_RESTORE_CERTIFIED=true' "$certification_file" || {
    echo "Certification file does not authorize production restore." >&2
    exit 2
  }
fi

for command in age jq pg_restore psql tar sha256sum; do
  command -v "$command" >/dev/null || { echo "Required command missing: $command" >&2; exit 2; }
done

workdir="$(mktemp -d)"
cleanup() {
  unset PORTFOLIOAI_RESTORE_DATABASE_URL PORTFOLIOAI_AGE_RECIPIENT PGCONNECT_TIMEOUT
  rm -rf "$workdir"
}
trap cleanup EXIT INT TERM

age --decrypt --identity "$identity" --output "$workdir/backup.tar" "$archive"
tar -tf "$workdir/backup.tar" | awk '
  /^\// || /(^|\/)\.\.($|\/)/ { bad=1 }
  END { exit bad ? 1 : 0 }
' || { echo "Unsafe archive path detected." >&2; exit 1; }
tar -xf "$workdir/backup.tar" -C "$workdir"

manifest="$workdir/manifest.json"
[[ -f "$manifest" && -f "$workdir/database.dump" && -f "$workdir/auth-data.dump" ]] || {
  echo "Archive is missing required files." >&2
  exit 1
}

jq -e --arg ref "$source_ref" '.source_project_ref == $ref' "$manifest" >/dev/null || {
  echo "Source project reference does not match the manifest." >&2
  exit 1
}

while IFS=$'\t' read -r file expected; do
  [[ -f "$workdir/$file" ]] || { echo "Manifest file missing: $file" >&2; exit 1; }
  actual="$(sha256sum "$workdir/$file" | cut -d' ' -f1)"
  [[ "$actual" == "$expected" ]] || { echo "Checksum mismatch: $file" >&2; exit 1; }
done < <(jq -r '.files | to_entries[] | [.key, .value.sha256] | @tsv' "$manifest")

server_major="$(psql "$PORTFOLIOAI_RESTORE_DATABASE_URL" -XAtqc "select current_setting('server_version_num')::int / 10000")"
backup_major="$(jq -r '.postgres_server_major' "$manifest")"
[[ "$server_major" == "$backup_major" ]] || {
  echo "PostgreSQL major version mismatch: backup=$backup_major target=$server_major" >&2
  exit 1
}

# The target must be a Supavisor session-mode connection (port 5432), not transaction mode.
python3 - "$PORTFOLIOAI_RESTORE_DATABASE_URL" "$target_ref" <<'PY'
import sys
from urllib.parse import urlparse
url, ref = sys.argv[1:]
p = urlparse(url)
if p.port != 5432 or not (p.hostname or '').endswith('.pooler.supabase.com'):
    raise SystemExit('Restore URL must use the Supavisor session pooler on port 5432.')
if p.username != f'postgres.{ref}':
    raise SystemExit('Restore URL username does not match the target project ref.')
PY

# Required extensions must already exist. Extension DDL is never replayed.
missing_extensions="$(jq -r '.extensions[]?.name' "$manifest" | while read -r ext; do
  psql "$PORTFOLIOAI_RESTORE_DATABASE_URL" -XAtqc "select 1 from pg_catalog.pg_extension where extname = :'ext'" --set="ext=$ext" | grep -q 1 || printf '%s\n' "$ext"
done)"
[[ -z "$missing_extensions" ]] || {
  echo "Target is missing required extensions; restore stopped:" >&2
  printf '%s\n' "$missing_extensions" >&2
  exit 1
}

# Ensure managed Auth columns match before any write. Auth schema DDL is never restored.
while IFS=$'\t' read -r table expected; do
  actual="$(psql "$PORTFOLIOAI_RESTORE_DATABASE_URL" -XAtq --set="table_name=$table" -c "select coalesce(jsonb_agg(column_name order by ordinal_position)::text, '[]') from information_schema.columns where table_schema = 'auth' and table_name = :'table_name'")"
  [[ "$actual" == "$expected" ]] || { echo "Auth schema mismatch for auth.$table; restore stopped." >&2; exit 1; }
done < <(jq -r '.auth_tables | to_entries[] | [.key, (.value.columns | tojson)] | @tsv' "$manifest")

# Build a filtered table of contents: extensions and their comments are owned by Supabase.
pg_restore --list "$workdir/database.dump" > "$workdir/database.toc"
awk '!/ EXTENSION / && !/ COMMENT - EXTENSION /' "$workdir/database.toc" > "$workdir/database.filtered.toc"

cat <<'WARNING'
Preflight passed. This operation replaces application objects/data in the target.
The script will not drop or recreate managed Auth or extension schemas.
WARNING

# Create an encrypted target safety backup before any destructive statement.
safety_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
safety_directory="${PORTFOLIOAI_SAFETY_BACKUP_DIR:-$PWD}"
mkdir -p "$safety_directory"
pg_dump "$PORTFOLIOAI_RESTORE_DATABASE_URL" \
  --format=custom --compress=9 --schema=public --no-owner \
  --file="$workdir/target-before-restore.dump"
pg_dump "$PORTFOLIOAI_RESTORE_DATABASE_URL" \
  --format=custom --compress=9 --data-only --schema=auth \
  --no-owner --no-privileges \
  --file="$workdir/target-auth-before-restore.dump"
tar -C "$workdir" -cf "$workdir/target-before-restore.tar" \
  target-before-restore.dump target-auth-before-restore.dump
age --encrypt --recipient "$PORTFOLIOAI_AGE_RECIPIENT" \
  --output "$safety_directory/portfolioai-target-before-restore-${safety_timestamp}.tar.age" \
  "$workdir/target-before-restore.tar"
echo "Encrypted target safety backup: $safety_directory/portfolioai-target-before-restore-${safety_timestamp}.tar.age"

# Recreate empty application objects first. Data and post-data constraints follow Auth restoration.
pg_restore \
  --dbname "$PORTFOLIOAI_RESTORE_DATABASE_URL" \
  --use-list "$workdir/database.filtered.toc" --section=pre-data \
  --clean --if-exists --exit-on-error --single-transaction \
  --no-owner "$workdir/database.dump"

# Auth data is restored only to the allowlisted, schema-compatible tables captured by the backup.
# Existing target rows are cleared only in the disposable/certified target after all preflights pass.
mapfile -t auth_tables < <(jq -r '.auth_tables | keys[]' "$manifest")
if ((${#auth_tables[@]})); then
  truncate_sql="TRUNCATE TABLE "
  separator=""
  for table in "${auth_tables[@]}"; do
    [[ "$table" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "Unsafe Auth table name." >&2; exit 1; }
    truncate_sql+="${separator}auth.\"${table}\""
    separator=", "
  done
  truncate_sql+=";"
  pg_restore --data-only --no-owner --no-privileges \
    --file="$workdir/auth-data.sql" "$workdir/auth-data.dump"
  {
    echo 'BEGIN;'
    echo 'SET CONSTRAINTS ALL DEFERRED;'
    echo "$truncate_sql"
    cat "$workdir/auth-data.sql"
    echo 'COMMIT;'
  } > "$workdir/auth-restore.sql"
  psql "$PORTFOLIOAI_RESTORE_DATABASE_URL" -X --set=ON_ERROR_STOP=1 \
    --file="$workdir/auth-restore.sql"
fi

# Restore application data, then constraints/policies, after Auth so RESTRICT references remain intact.
pg_restore \
  --dbname "$PORTFOLIOAI_RESTORE_DATABASE_URL" \
  --use-list "$workdir/database.filtered.toc" --section=data \
  --exit-on-error --single-transaction --no-owner "$workdir/database.dump"
pg_restore \
  --dbname "$PORTFOLIOAI_RESTORE_DATABASE_URL" \
  --use-list "$workdir/database.filtered.toc" --section=post-data \
  --exit-on-error --single-transaction \
  --no-owner "$workdir/database.dump"

psql "$PORTFOLIOAI_RESTORE_DATABASE_URL" -XAtqc "select count(*) from public.profiles" >/dev/null
psql "$PORTFOLIOAI_RESTORE_DATABASE_URL" -XAtqc "select count(*) from auth.users" >/dev/null

echo "Restore completed. Run the documented application login and Storage reconciliation checks before certification."
