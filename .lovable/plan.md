# Manual full-database backup and guarded recovery

## Goal

Add GitHub Actions workflows that create a restorable PostgreSQL backup of PortfolioAI’s dedicated Supabase database—including application data and Auth records—and retain it in a private Supabase Storage bucket. Add a separately triggered, strongly guarded recovery workflow capable of rebuilding the database from a selected backup.

This changes GitHub automation and documentation only. It does not run a backup, restore data, modify migrations, change the app, or alter the live database during implementation.

## Important recovery boundary

The backup will reproduce all database objects and rows the Supabase database owner can export: application schemas and data, Auth schema/data, functions, views, triggers, RLS policies, grants, sequences, extensions metadata, and accessible roles. It cannot reproduce Supabase platform configuration outside PostgreSQL, such as project settings, Edge Function source/secrets, OAuth provider settings, custom domains, or Storage object file contents. Those require separate exports/configuration.

Keeping the only backup inside the same Supabase project is not disaster-independent: if that project or its Storage becomes unavailable, the backup may also be unavailable. This implementation will follow the requested private Supabase bucket destination, while documenting that a later second copy outside the project is recommended.

## Files to add

### `.github/workflows/backup-supabase-database.yml`

Manual `workflow_dispatch` only:

1. Validate required GitHub Actions secrets without printing values.
2. Install a pinned PostgreSQL 17 client to match the deployed PostgreSQL major version.
3. Create two dumps:
   - `database.dump`: custom-format `pg_dump` of every accessible non-system schema, including schema definitions and all row data (including `auth`).
   - `roles.sql`: `pg_dumpall --roles-only`, filtered only where needed for Supabase-managed restrictions while retaining restorable role/grant definitions.
4. Generate a plaintext manifest with UTC timestamp, project reference, PostgreSQL version, dump format/version, SHA-256 checksums, and file sizes—never credentials.
5. Package the dump, role file, manifest, and a generated restore README into one timestamped archive.
6. Upload it to a configured private Supabase Storage bucket/path using Supabase Storage’s S3-compatible endpoint and dedicated Storage access credentials.
7. Verify the remote object exists and its uploaded size matches; do not expose a public URL.
8. Always delete local dump files from the runner.
9. Use least-privilege GitHub permissions (`contents: read`), no schedule, no commits, concurrency protection, timeout, and shell fail-fast behavior.

Suggested object key:

```text
database-backups/portfolioai/portfolioai-db-YYYYMMDDTHHMMSSZ.tar.gz
```

### `.github/workflows/restore-supabase-database.yml`

Separate manual-only recovery workflow:

1. Require explicit inputs:
   - exact private Storage object key;
   - target project reference;
   - typed confirmation phrase `RESTORE PORTFOLIOAI DATABASE`;
   - acknowledgement that current target data will be replaced.
2. Require a protected GitHub Environment named `database-recovery`, allowing repository owners to configure required reviewers before this workflow can run.
3. Download the selected private archive with Storage S3 credentials.
4. Verify archive path safety and SHA-256 checksums before any database connection.
5. Verify the backup’s PostgreSQL major version and target project reference; stop on mismatch unless a separate explicit cross-project recovery input is supplied.
6. Run a preflight inventory and connection check before destructive operations.
7. Restore roles first where permitted, then restore the custom-format database dump with deterministic `pg_restore` options, transaction/error-stop safeguards, and no secrets in logs.
8. Run read-only post-restore checks for expected PortfolioAI schemas/tables, Auth rows, migration objects, functions, RLS-enabled tables, and key row counts recorded in the manifest.
9. Delete downloaded backup material from the runner even on failure.

The recovery workflow will not be run while building this feature.

## Supporting documentation

Add `docs/database-backup-and-recovery.md` covering:

- What is and is not included.
- One-time setup for a **private** bucket and GitHub Environment protection.
- Required GitHub repository secrets, stored only in GitHub Actions:
  - `PORTFOLIOAI_DATABASE_URL`: direct PostgreSQL connection string for database owner-level dump/restore access.
  - `PORTFOLIOAI_SUPABASE_PROJECT_REF`: target project reference (may instead be a non-secret repository variable).
  - `PORTFOLIOAI_STORAGE_S3_ACCESS_KEY_ID` and `PORTFOLIOAI_STORAGE_S3_SECRET_ACCESS_KEY`: dedicated S3-compatible Storage credentials used only for the private backup bucket.
  - `PORTFOLIOAI_BACKUP_BUCKET`: private bucket name (prefer a non-secret repository variable).
- The Storage credentials are preferred over introducing a service-role key; no service-role credential enters the application or repository.
- How to trigger a backup, inspect its manifest, apply retention manually, test a restore into a disposable Supabase project, and invoke production recovery only after approval.
- A warning that a backup is not proven until a test restore succeeds.
- Separate export requirements for Storage objects and Supabase platform/Edge Function configuration.

## Security controls

- No credentials in YAML, source, artifacts, command output, manifests, or documentation examples.
- GitHub secrets are masked and passed only to the exact steps that need them.
- Connection strings are never placed in command arguments where avoidable; use `PG*` environment variables derived without echoing.
- Backup bucket must already exist and be private; workflows fail rather than create or make a bucket public.
- Backup workflow has no restore/delete capability against the database.
- Restore workflow uses a protected environment, exact confirmation phrase, target-project check, checksum verification, and manual dispatch only.
- Archives are not published as GitHub artifacts and receive no public/signed URL.

## Validation before delivery

- Parse both YAML files and validate GitHub Actions structure.
- Run ShellCheck against extracted shell blocks where practical.
- Confirm workflow permissions are read-only and both triggers are manual only.
- Confirm no secret-shaped values are present and existing application/migration files are untouched.
- Confirm no workflow was dispatched, no live database/storage operation occurred, and no bucket or migration was created.
- Document that the first real backup and a test restore into a disposable project are still required to establish recoverability.

## Deliberately not included

- Scheduled backups or automatic retention deletion.
- Live execution during implementation.
- Application, database migration, RLS, Auth, Edge Function, or UI changes.
- Storage object-content backup, Edge Function secrets, or provider configuration export.
