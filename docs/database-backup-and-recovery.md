# PortfolioAI database backup and recovery

## Status

The repository provides a manual encrypted database backup workflow and a guarded local restore script. Creating these files does not run a backup or prove recovery. Recovery is **uncertified** until a real archive has been restored and verified in a disposable Supabase project.

## What is backed up

The encrypted archive contains:

- the complete `public` application schema and its row data;
- Auth data from accessible base tables except managed migration/configuration tables (`schema_migrations`, `instances`, and ephemeral `flow_state` are excluded); the exact included table/column inventory is recorded in each manifest;
- application functions, views, triggers, constraints, RLS policies, grants, and sequences from `public`;
- a manifest of PostgreSQL/client versions, installed extensions, public tables, Auth table columns/counts, checksums, and the private Storage object key;
- an explicit empty project-role allowlist. PortfolioAI currently uses Supabase’s existing platform roles, so they are never recreated.

It does not back up Supabase project settings, Edge Function source/secrets, OAuth provider configuration, custom domains, external provider configuration, or physical Supabase Storage files.

## Critical limitations

### Recovery must be certified

A successful upload is not proof of recovery. Before production restore may be considered safe, run the documented restore against a fresh disposable Supabase project and verify application objects/data, Auth behavior, grants/RLS, and a second backup. Production use remains blocked until this is recorded in a local certification file.

### Same-project Storage is not disaster-independent

The private Storage archive lives in the same Supabase project as the database. If the project becomes unavailable, that copy may also be unavailable.

**After every backup: copy the exact object key from the GitHub Actions summary, download that encrypted `.age` file to your local computer immediately, and verify its SHA-256.** The requested off-project safety exists only after this local download is complete.

### Orphaned Storage metadata after database recovery

Database metadata can refer to Storage object names without containing the physical files. This workflow inventories Storage separately but excludes the managed `storage` schema from restore. After recovery, compare expected object keys with actual bucket listings and report missing binaries or metadata-only references. Full file recovery requires a separate Storage-object export.

### Managed Auth schema

The target already owns and migrates `auth` through `supabase_auth_admin`. The restore script never drops/recreates Auth DDL or ownership. It restores only allowlisted Auth table data after exact column compatibility checks. A mismatch stops before writes. If target permissions reject safe Auth data restoration, use Supabase managed backup/PITR/support; do not weaken ownership or grants.

### Extensions

Fresh Supabase projects already contain managed extensions such as `pgcrypto`, `uuid-ossp`, and `pg_graphql`. Restore filters `EXTENSION` and `COMMENT - EXTENSION` entries from the archive table of contents. It first verifies every source requirement exists in the target and stops if any is missing. It never drops, recreates, or changes ownership of Supabase-managed extensions.

## One-time setup

### 1. Create the private backup bucket

Create a bucket for database backups in the same Supabase project and keep it private. Do not add public read policies. Record its name as the GitHub repository variable `PORTFOLIOAI_BACKUP_BUCKET`.

### 2. Create dedicated Storage S3 credentials

In Supabase Storage S3 settings, create dedicated access credentials for this backup job. Store them as GitHub repository secrets:

- `PORTFOLIOAI_STORAGE_S3_ACCESS_KEY_ID`
- `PORTFOLIOAI_STORAGE_S3_SECRET_ACCESS_KEY`

Set these repository variables:

- `PORTFOLIOAI_STORAGE_REGION` — the Supabase project region used for S3 signing;
- `PORTFOLIOAI_SUPABASE_PROJECT_REF` — the source project reference.

These credentials are not application service-role credentials and must never enter app code.

### 3. Configure the session-pooler database URL

Copy the **Session pooler** connection string from Supabase Dashboard → Connect and save it as GitHub secret `PORTFOLIOAI_DATABASE_URL`:

```text
postgresql://postgres.<project-ref>:<password>@<region>.pooler.supabase.com:5432/postgres?sslmode=require
```

Port `5432` is required. Port `6543` is transaction mode and is rejected because it is unsuitable for dump/restore sessions. The direct IPv6 hostname is not used by GitHub-hosted runners.

### 4. Generate and retain the encryption identity offline

On your trusted local computer:

```bash
age-keygen -o portfolioai-backup-key.txt
age-keygen -y portfolioai-backup-key.txt
```

Store the first file offline in at least two protected locations. Never upload it to GitHub or Supabase. Save only the printed public `age1...` recipient as repository variable `PORTFOLIOAI_AGE_RECIPIENT`.

## Run a backup

1. Open GitHub → Actions → **Backup Supabase database**.
2. Choose **Run workflow**.
3. Wait for completion.
4. Copy the private Storage object key and ciphertext SHA-256 from the job summary.
5. Download that `.age` object from the private bucket to your local computer immediately.
6. Verify the downloaded ciphertext:

```bash
sha256sum portfolioai-db-YYYYMMDDTHHMMSSZ.tar.age
```

Match it exactly to the workflow summary. Retain the encrypted local file according to your own offline retention policy.

## Restore into a disposable project first

Install PostgreSQL 17 client tools, `age`, `jq`, and standard shell tools. Use a fresh disposable Supabase project with a Session pooler URL. Keep its connection URL only in your local environment:

```bash
export PORTFOLIOAI_RESTORE_DATABASE_URL='postgresql://postgres.TARGET_REF:...@...pooler.supabase.com:5432/postgres?sslmode=require'
export PORTFOLIOAI_AGE_RECIPIENT='age1...'
./scripts/restore-portfolioai-backup.sh \
  --archive ./portfolioai-db-YYYYMMDDTHHMMSSZ.tar.age \
  --identity /offline/path/portfolioai-backup-key.txt \
  --source-project-ref SOURCE_REF \
  --target-project-ref TARGET_REF \
  --disposable-test \
  --confirm 'RESTORE PORTFOLIOAI DATABASE'
```

The script verifies checksums, PostgreSQL version, extension presence, Auth table compatibility, project references, and safe archive paths before writes. It then creates an encrypted safety backup of the target in the current directory (or `PORTFOLIOAI_SAFETY_BACKUP_DIR`) before replacement begins. It restores `public` with ownership mapped to the target’s existing `postgres` role. It does not recreate `anon`, `authenticated`, `service_role`, any `pg_*` role, or Supabase administrative roles.

## Certification checklist

Do not claim recovery readiness until all checks pass on the disposable project:

- encrypted archive decrypts and every manifest checksum matches;
- expected public tables, rows, functions, views, triggers, constraints, and migrations are present;
- RLS state, policies, and grants match the source inventory;
- Auth users/identities have expected counts and a designated test user can sign in and establish a session;
- no Supabase role or extension conflicts occurred;
- Storage metadata/object reconciliation reports expected differences;
- a second backup can be generated from the restored project.

Record certification locally in a protected file containing:

```text
PORTFOLIOAI_RESTORE_CERTIFIED=true
```

For any later production recovery, pass that file with `--certification-file`. A fresh target backup is mandatory before replacement. Production recovery should be supervised and should not proceed when Auth schemas or extensions differ.
