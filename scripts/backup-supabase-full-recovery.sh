#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

for name in PORTFOLIOAI_DATABASE_URL PORTFOLIOAI_SUPABASE_PROJECT_REF \
  PORTFOLIOAI_BACKUP_BUCKET PORTFOLIOAI_STORAGE_REGION PORTFOLIOAI_AGE_RECIPIENT \
  SUPABASE_ACCESS_TOKEN AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  [[ -n "${!name:-}" ]] || { echo "Missing required configuration: $name" >&2; exit 1; }
done

for command in age aws jq pg_dump pg_restore psql sha256sum supabase tar; do
  command -v "$command" >/dev/null || { echo "Required command missing: $command" >&2; exit 1; }
done

workdir="$(mktemp -d)"
cleanup() { rm -rf "$workdir"; }
trap cleanup EXIT INT TERM

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
bundle_name="portfolioai-supabase-full-${timestamp}"
object_key="full-recovery/portfolioai/${bundle_name}.tar.age"
endpoint="https://${PORTFOLIOAI_SUPABASE_PROJECT_REF}.storage.supabase.co/storage/v1/s3"
mkdir -p "$workdir/bundle/database" "$workdir/bundle/storage/files" \
  "$workdir/bundle/edge-functions" "$workdir/bundle/inventory"

# 1) Forensic full logical database snapshot. This captures every database
# object/data row the source postgres connection is allowed to read. It is an
# archive source, not a promise that managed Supabase schemas can be replayed
# blindly into another project.
pg_dump "$PORTFOLIOAI_DATABASE_URL" \
  --format=custom --compress=9 --no-owner --no-privileges \
  --file="$workdir/bundle/database/database-full.dump"
pg_restore --list "$workdir/bundle/database/database-full.dump" \
  > "$workdir/bundle/inventory/database-full.toc"

# 2) Recovery-friendly application dump.
pg_dump "$PORTFOLIOAI_DATABASE_URL" \
  --format=custom --compress=9 --schema=public --no-owner --no-privileges \
  --file="$workdir/bundle/database/public.dump"
pg_restore --list "$workdir/bundle/database/public.dump" \
  > "$workdir/bundle/inventory/public.toc"

# 3) Controlled Auth data snapshot. Managed Auth DDL is deliberately not
# treated as portable. Secrets are not exported.
mapfile -t auth_table_names < <(
  psql "$PORTFOLIOAI_DATABASE_URL" -XAtq -c \
    "select table_name
       from information_schema.tables
      where table_schema='auth'
        and table_type='BASE TABLE'
        and table_name not in ('schema_migrations','flow_state')
      order by table_name"
)
auth_tables=()
for table in "${auth_table_names[@]}"; do
  [[ "$table" =~ ^[a-z_][a-z0-9_]*$ ]] || { echo "Unsafe Auth table name." >&2; exit 1; }
  auth_tables+=("--table=auth.$table")
done
if (("${#auth_tables[@]}" > 0)); then
  pg_dump "$PORTFOLIOAI_DATABASE_URL" \
    --format=custom --compress=9 --data-only --schema=auth \
    --no-owner --no-privileges "${auth_tables[@]}" \
    --file="$workdir/bundle/database/auth-data.dump"
  pg_restore --list "$workdir/bundle/database/auth-data.dump" \
    > "$workdir/bundle/inventory/auth-data.toc"
fi

# 4) Database inventories used to understand/validate a future recovery.
psql "$PORTFOLIOAI_DATABASE_URL" -X --csv \
  -c "select nspname as schema_name from pg_namespace order by nspname" \
  > "$workdir/bundle/inventory/schemas.csv"
psql "$PORTFOLIOAI_DATABASE_URL" -X --csv \
  -c "select extname, extversion from pg_extension order by extname" \
  > "$workdir/bundle/inventory/extensions.csv"
psql "$PORTFOLIOAI_DATABASE_URL" -X --csv \
  -c "select t.schemaname, t.tablename, c.relrowsecurity as rowsecurity
        from pg_tables t
        join pg_namespace n on n.nspname=t.schemaname
        join pg_class c on c.relnamespace=n.oid and c.relname=t.tablename
       where t.schemaname not in ('pg_catalog','information_schema')
       order by t.schemaname, t.tablename" \
  > "$workdir/bundle/inventory/tables.csv" || true
psql "$PORTFOLIOAI_DATABASE_URL" -X --csv \
  -c "select schemaname, viewname from pg_views where schemaname not in ('pg_catalog','information_schema') order by schemaname, viewname" \
  > "$workdir/bundle/inventory/views.csv"
psql "$PORTFOLIOAI_DATABASE_URL" -X --csv \
  -c "select n.nspname as schema_name, p.proname as function_name, pg_get_function_identity_arguments(p.oid) as arguments from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname not in ('pg_catalog','information_schema') order by n.nspname,p.proname" \
  > "$workdir/bundle/inventory/functions.csv"

# 5) Storage metadata and physical object files.
psql "$PORTFOLIOAI_DATABASE_URL" -X --csv \
  -c "select id, name, public, file_size_limit, allowed_mime_types from storage.buckets order by id" \
  > "$workdir/bundle/inventory/storage-buckets.csv" || true
psql "$PORTFOLIOAI_DATABASE_URL" -X --csv \
  -c "select bucket_id, name, owner_id, created_at, updated_at, last_accessed_at, metadata from storage.objects order by bucket_id, name" \
  > "$workdir/bundle/inventory/storage-objects.csv" || true

mapfile -t storage_buckets < <(
  aws s3api list-buckets --endpoint-url "$endpoint" \
    --query 'Buckets[].Name' --output text | tr '\t' '\n' | sed '/^$/d'
)
printf '%s\n' "${storage_buckets[@]}" > "$workdir/bundle/inventory/storage-bucket-names.txt"
for bucket in "${storage_buckets[@]}"; do
  [[ "$bucket" == "$PORTFOLIOAI_BACKUP_BUCKET" ]] && continue
  mkdir -p "$workdir/bundle/storage/files/$bucket"
  aws s3 sync "s3://$bucket/" "$workdir/bundle/storage/files/$bucket/" \
    --endpoint-url "$endpoint" --only-show-errors
  aws s3api list-objects-v2 --bucket "$bucket" --endpoint-url "$endpoint" \
    --output json > "$workdir/bundle/inventory/storage-${bucket}-objects.json"
done

# 6) Download deployed Edge Function source and capture deployed function list.
# Supabase CLI does not export Edge Function secret values; those are deliberately omitted.
(
  cd "$workdir/bundle/edge-functions"
  mkdir -p supabase/functions
  supabase functions list --project-ref "$PORTFOLIOAI_SUPABASE_PROJECT_REF" \
    > "$workdir/bundle/inventory/edge-functions-list.txt"
  supabase functions download --project-ref "$PORTFOLIOAI_SUPABASE_PROJECT_REF" --use-api
)

# Also retain the repository Edge Function source/configuration present at backup time.
if [[ -d edge-functions ]]; then
  mkdir -p "$workdir/bundle/edge-functions/repository"
  cp -R edge-functions "$workdir/bundle/edge-functions/repository/"
fi
if [[ -d supabase/functions ]]; then
  mkdir -p "$workdir/bundle/edge-functions/repository-supabase"
  cp -R supabase/functions "$workdir/bundle/edge-functions/repository-supabase/"
fi

# 7) Capture non-secret project/platform configuration exposed by the
# Supabase Management API. Auth secret fields are returned as non-reversible
# HMACs by Supabase; we additionally redact secret/password/token/key-shaped
# fields before storing the snapshot. Failure to read this optional snapshot
# does not invalidate the database/Storage/Edge Function backup.
management_config="$workdir/bundle/inventory/project-config-redacted.json"
if curl -fsS --retry 3 \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "https://api.supabase.com/v2/projects/$PORTFOLIOAI_SUPABASE_PROJECT_REF/config" \
  -o "$workdir/project-config.raw.json"; then
  jq '
    def scrub:
      if type == "object" then
        with_entries(
          if (.key | ascii_downcase | test("secret|password|passwd|token|api[_-]?key|private[_-]?key|smtp_pass"))
          then .value = "[REDACTED]"
          else .value |= scrub
          end
        )
      elif type == "array" then map(scrub)
      else .
      end;
    scrub
  ' "$workdir/project-config.raw.json" > "$management_config"
  rm -f "$workdir/project-config.raw.json"
else
  printf '%s\n' '{"status":"unavailable","reason":"Management API config snapshot could not be read with the configured access token."}' \
    > "$management_config"
fi

# 8) Capture migrations and recovery-relevant repository configuration.
mkdir -p "$workdir/bundle/repository"
for path in db/migrations .github/workflows docs; do
  if [[ -e "$path" ]]; then
    cp -R "$path" "$workdir/bundle/repository/"
  fi
done

# 9) Manifest and integrity hashes.
server_version="$(psql "$PORTFOLIOAI_DATABASE_URL" -XAtqc 'show server_version')"
client_version="$(pg_dump --version | sed 's/^pg_dump (PostgreSQL) //')"
supabase_cli_version="$(supabase --version | head -n1)"
git_sha="${GITHUB_SHA:-unknown}"

find "$workdir/bundle" -type f ! -name SHA256SUMS -print0 \
  | sort -z \
  | xargs -0 sha256sum \
  | sed "s#  $workdir/bundle/#  #" \
  > "$workdir/bundle/SHA256SUMS"

file_count="$(find "$workdir/bundle" -type f | wc -l | tr -d ' ')"
storage_file_count="$(find "$workdir/bundle/storage/files" -type f | wc -l | tr -d ' ')"

jq -n \
  --arg format_version "2" \
  --arg created_at "$timestamp" \
  --arg source_project_ref "$PORTFOLIOAI_SUPABASE_PROJECT_REF" \
  --arg object_key "$object_key" \
  --arg postgres_server_version "$server_version" \
  --arg pg_dump_version "$client_version" \
  --arg supabase_cli_version "$supabase_cli_version" \
  --arg git_sha "$git_sha" \
  --argjson file_count "$file_count" \
  --argjson storage_file_count "$storage_file_count" \
  '{
    format_version:$format_version,
    created_at_utc:$created_at,
    source_project_ref:$source_project_ref,
    storage_object_key:$object_key,
    postgres_server_version:$postgres_server_version,
    pg_dump_version:$pg_dump_version,
    supabase_cli_version:$supabase_cli_version,
    repository_git_sha:$git_sha,
    total_files:$file_count,
    physical_storage_files:$storage_file_count,
    contains:{
      full_logical_database_dump:true,
      public_recovery_dump:true,
      auth_data:true,
      storage_bucket_metadata:true,
      physical_storage_objects:true,
      deployed_edge_function_source:true,
      repository_edge_function_source:true,
      database_extensions_inventory:true,
      database_object_inventories:true,
      redacted_project_configuration:true,
      migrations_and_workflows:true,
      edge_function_secret_values:false,
      provider_secret_values:false,
      oauth_client_secret_values:false
    },
    limitations:[
      "Supabase-managed secret values are not exportable and are not present.",
      "Some project/dashboard settings are platform-managed and are represented only where visible in database/repository state.",
      "database-full.dump is an archival/forensic snapshot and must not be blindly replayed over managed Supabase schemas.",
      "The configured backup bucket itself is excluded from physical Storage export to prevent recursive backups."
    ]
  }' > "$workdir/bundle/manifest.json"

cat > "$workdir/bundle/RECOVERY-NOTES.txt" <<'EOF'
PortfolioAI Supabase full-recovery bundle.

Contains:
- full logical PostgreSQL archive of every database object/data row accessible to the source postgres connection;
- separate recovery-friendly public schema dump;
- controlled Auth table data;
- Storage bucket/object inventories and physical files from every bucket except the dedicated backup bucket;
- deployed Edge Function source downloadable through the Supabase CLI;
- repository Edge Function source, migrations, workflows, and documentation;
- redacted non-secret project/service configuration available through the Supabase Management API;
- object inventories, versions, hashes, and manifest.

Not contained:
- Edge Function secret values;
- external-provider secret values;
- OAuth client secret values;
- regenerated project-specific API keys/identifiers;
- platform settings Supabase does not expose for export.

Do not blindly pg_restore database-full.dump into managed Supabase schemas.
Use the manifest/inventories and a reviewed restore procedure.
EOF

# Rebuild checksums after manifest/notes are present.
find "$workdir/bundle" -type f ! -name SHA256SUMS -print0 \
  | sort -z \
  | xargs -0 sha256sum \
  | sed "s#  $workdir/bundle/#  #" \
  > "$workdir/bundle/SHA256SUMS"

tar -C "$workdir" -cf "$workdir/${bundle_name}.tar" bundle
age --encrypt --recipient "$PORTFOLIOAI_AGE_RECIPIENT" \
  --output "$workdir/${bundle_name}.tar.age" "$workdir/${bundle_name}.tar"

cipher_sha="$(sha256sum "$workdir/${bundle_name}.tar.age" | cut -d' ' -f1)"
cipher_size="$(stat -c%s "$workdir/${bundle_name}.tar.age")"

aws s3 cp "$workdir/${bundle_name}.tar.age" \
  "s3://$PORTFOLIOAI_BACKUP_BUCKET/$object_key" \
  --endpoint-url "$endpoint" --only-show-errors

remote_size="$(aws s3api head-object \
  --bucket "$PORTFOLIOAI_BACKUP_BUCKET" \
  --key "$object_key" \
  --endpoint-url "$endpoint" \
  --query ContentLength --output text)"
[[ "$remote_size" == "$cipher_size" ]] || {
  echo "Remote encrypted archive size verification failed." >&2
  exit 1
}

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  {
    echo "### PortfolioAI Supabase full-recovery backup"
    echo
    echo "- Private Storage object: \`$object_key\`"
    echo "- Ciphertext SHA-256: \`$cipher_sha\`"
    echo "- Encrypted size: $cipher_size bytes"
    echo "- Physical Storage files captured: $storage_file_count"
    echo
    echo "**Secret values are intentionally not included.**"
    echo
    echo "**Download this encrypted file off-project after every important backup. A copy stored only in the same Supabase project is not disaster-independent.**"
  } >> "$GITHUB_STEP_SUMMARY"
fi
