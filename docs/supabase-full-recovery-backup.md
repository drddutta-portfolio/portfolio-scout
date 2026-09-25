# PortfolioAI Supabase full-recovery backup

## Purpose

This is the broadest practical manual backup of the PortfolioAI Supabase project that can be produced without attempting to export Supabase-managed secret values.

It is separate from the smaller database-only backup workflow.

## Manual workflow

Run:

`.github/workflows/backup-supabase-full-recovery.yml`

from GitHub **Actions → Backup Supabase full recovery bundle → Run workflow**.

The workflow never runs on push or schedule.

## What the encrypted bundle contains

- a forensic full logical PostgreSQL dump of all database objects/data accessible to the source PostgreSQL connection;
- a separate recovery-friendly `public` schema/data dump;
- controlled Auth table data (excluding managed migration/ephemeral tables);
- PostgreSQL schemas, extensions, tables, views, functions and restore TOC inventories;
- Supabase Storage bucket/object metadata inventories;
- the physical files from all Storage buckets except the dedicated backup bucket;
- the source of deployed Edge Functions downloadable through the Supabase CLI;
- the repository's Edge Function source, migrations, workflows and documentation at the backup commit;
- a redacted snapshot of non-secret database/pooler/Auth/Data API/Realtime/Storage configuration exposed by the Supabase Management API when the access token permits it;
- a manifest and SHA-256 checksum inventory.

## Intentionally not included

The workflow does **not** attempt to export:

- Edge Function secret values;
- Angel One, Trendlyne, email/provider or other external-provider secret values;
- OAuth client secret values;
- target/project API keys that Supabase regenerates;
- project/platform configuration that Supabase does not expose in a safely exportable form.

The Management API snapshot is deliberately scrubbed of fields whose names look like secrets, passwords, tokens, API keys, or private keys before it is placed in the encrypted bundle.

The absence of secret values is deliberate.

## Important database boundary

`database-full.dump` is an archival/forensic database snapshot. It may contain managed Supabase schemas where the source PostgreSQL role can read them. It must not be blindly replayed over a live Supabase project.

For normal recovery, `public.dump`, the controlled Auth data archive, Storage files/inventories, downloaded Edge Function source and the manifest are the safer building blocks.

## Storage

The workflow downloads physical files from every S3-visible Storage bucket except `PORTFOLIOAI_BACKUP_BUCKET`. The backup bucket is excluded to prevent the backup from recursively backing up previous backups.

The completed encrypted bundle is then uploaded into that private backup bucket under:

`full-recovery/portfolioai/portfolioai-supabase-full-YYYYMMDDTHHMMSSZ.tar.age`

## Edge Functions

The workflow uses the Supabase CLI with `SUPABASE_ACCESS_TOKEN` to list and download deployed Edge Function source.

Supabase's CLI download does not export secret values. Dependency files that Supabase itself cannot reconstruct from a deployed bundle may still need the repository copy; for that reason the current repository Edge Function source is also included.

## Required GitHub configuration

Secrets:

- `PORTFOLIOAI_DATABASE_URL`
- `PORTFOLIOAI_STORAGE_S3_ACCESS_KEY_ID`
- `PORTFOLIOAI_STORAGE_S3_SECRET_ACCESS_KEY`
- `SUPABASE_ACCESS_TOKEN`

Variables:

- `PORTFOLIOAI_SUPABASE_PROJECT_REF`
- `PORTFOLIOAI_BACKUP_BUCKET`
- `PORTFOLIOAI_STORAGE_REGION`
- `PORTFOLIOAI_AGE_RECIPIENT`

The database URL must be the Supavisor **session-mode** URL on port 5432. The `age` recipient is the public encryption recipient only; the private identity remains offline.

## Disaster independence

A backup stored only inside the same Supabase project is not sufficient for project-loss disaster recovery.

After important runs, download the encrypted `.tar.age` object to protected local/off-project storage and retain the ciphertext SHA-256 shown in the GitHub Actions summary.

## Recovery claim

This workflow substantially expands backup coverage, but it does not promise a byte-for-byte identical Supabase project after restore. Supabase-managed secrets and some platform settings cannot be exported. Any restore must use a reviewed recovery procedure and re-enter/reconfigure omitted secret values separately.
