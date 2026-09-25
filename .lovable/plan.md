# Manual full-database backup and guarded recovery

## Goal

Add a manual GitHub Actions workflow that creates an encrypted, restorable PostgreSQL backup of PortfolioAI’s dedicated Supabase database—including application rows and Auth records—and stores it in a private Supabase Storage bucket. Add a strongly guarded, offline recovery procedure for the locally downloaded archive.

This implementation changes workflow/documentation files only. It does not run against the live database, alter migrations, change the app, or perform a restore.

## Recovery guarantee and boundary

The deliverable is not considered recovery-ready merely because `pg_dump` succeeds. Completion has two stages:

1. **Workflow implementation:** YAML and documentation are committed, with no live execution.
2. **Recovery certification:** the user supplies a disposable Supabase project, manually runs a backup, restores it into that disposable project, and the documented verification passes. This test is mandatory and cannot be silently skipped before claiming the backup can reproduce the database.

The database archive covers application schemas and rows, Auth rows, functions, views, triggers, RLS policies, grants, sequences, and extension declarations that PostgreSQL permits the connection to read. It does not reproduce Supabase project-level settings, Edge Function source/secrets, OAuth provider configuration, custom domains, or physical Storage files.

## 1. Database connection: Supavisor session mode

GitHub-hosted runners will use the **Supavisor pooler in session mode**, not transaction mode and not the IPv6-only direct hostname. This avoids requiring Supabase’s IPv4 add-on while retaining session semantics needed by `pg_dump`/`pg_restore`.

GitHub secret `PORTFOLIOAI_DATABASE_URL` must use the project’s **Session pooler** connection string copied from Supabase Dashboard → Connect, in this form:

```text
postgresql://postgres.<project-ref>:<password>@<region>.pooler.supabase.com:5432/postgres?sslmode=require
```

The workflow validates that the hostname contains `.pooler.supabase.com`, the port is `5432`, and the username is `postgres.<project-ref>`. It rejects port `6543` (transaction mode). No connection value is printed.

If the project later gains the IPv4 add-on, direct connectivity may be adopted only through a reviewed workflow change.

## 2. Backup workflow

Add `.github/workflows/backup-supabase-database.yml`, triggered only by `workflow_dispatch`:

1. Validate required secrets without printing values.
2. Install a pinned PostgreSQL 17 client matching the deployed database major version.
3. Confirm the connection is the approved session-pooler endpoint and read the server version.
4. Create:
   - `database.dump`: custom-format dump of application schemas, definitions, and row data.
   - `auth-data.dump`: a separately identifiable data-only dump of the `auth` schema for controlled recovery.
   - `globals.sql`: only project-created roles if any are explicitly allowlisted; Supabase system roles are not dumped or recreated.
   - `manifest.json`: UTC timestamp, source project ref, PostgreSQL/client versions, included schemas, object/row inventories, file sizes, and SHA-256 hashes—never credentials.
5. Package those files with a generated recovery README.
6. Encrypt the package before upload using `age` with a public recipient key stored as a GitHub variable. The private recovery key remains fully offline with the owner: it is never placed in Supabase, GitHub Actions secrets/environments, the repository, or the workflow runner. Only the `.age` ciphertext is uploaded.
7. Upload the encrypted archive to the configured private Supabase Storage bucket through its S3-compatible endpoint and dedicated S3 credentials.
8. Verify the remote encrypted object exists and its byte size matches; never generate a public URL.
9. Write the exact private Storage object key to the GitHub Actions job summary and manifest, followed by: **“Download this encrypted file to your local computer now. The backup is not disaster-independent until that download is complete.”** The key/path is not sensitive and no signed/public URL is generated.
10. Securely remove runner files in an `always()` cleanup step. No GitHub Actions artifact is created.

Object key:

```text
database-backups/portfolioai/portfolioai-db-YYYYMMDDTHHMMSSZ.tar.age
```

## 3. Auth restore handling

The workflow must not treat `auth` like an ordinary owner-restorable schema. Supabase owns it through `supabase_auth_admin`, and a new project already contains Supabase Auth migrations and objects.

Recovery therefore uses this controlled approach:

- Never drop or recreate the target project’s `auth` schema.
- Never restore Auth schema DDL or ownership from the source.
- Require a freshly created disposable/target Supabase project at a compatible Auth schema version.
- Restore application schema/data first.
- Restore only compatible Auth table data from `auth-data.dump`, using a reviewed table allowlist and target-side ownership; exclude migration/version bookkeeping and Supabase-managed internal configuration tables.
- Use `--no-owner --no-privileges` for Auth data and perform preflight column/schema comparisons. Any mismatch stops recovery before Auth data writes.
- Restore Auth data in a transaction with constraints deferred where supported; failure rolls back that stage.
- Re-run Supabase Auth/API smoke checks after restore (user counts, identity links, sign-in/session behavior using a designated test user) without printing personal information.

Because Supabase can change its managed Auth schema, the exact Auth allowlist is derived from and recorded by the first backup, then validated against the disposable target. The mandatory disposable-project restore determines whether the result is certifiable. If Supabase permissions prevent safe Auth data restoration, the workflow stops and documentation states that full Auth recovery requires Supabase’s managed backup/PITR/support path; it will not weaken permissions or claim exact recovery.

## 4. Roles and grants

Do **not** restore an unfiltered `pg_dumpall --roles-only` output.

- Exclude all pre-existing Supabase/platform roles, including `postgres`, `anon`, `authenticated`, `service_role`, `authenticator`, `supabase_admin`, `supabase_auth_admin`, `supabase_storage_admin`, dashboard/replication roles, and any `pg_*` role.
- Inventory project-created roles separately and include only names explicitly allowlisted in the workflow configuration.
- Application object grants to existing `anon`, `authenticated`, and `service_role` are carried by the application-schema dump and reapplied only after the pre-existing target roles are confirmed.
- Restore with `--no-owner`; map application object ownership to the target’s `postgres` role rather than attempting to recreate source ownership.
- Role/grant SQL is parsed defensively and run with error-stop behavior; no `CREATE ROLE` for Supabase system roles is generated.

## 5. Storage metadata/file divergence risk

Document a named risk: **orphaned Storage metadata after database recovery**. Database rows such as `storage.objects` can name files, but `pg_dump` does not include the binary objects stored in Supabase Storage. Restoring metadata without files can leave broken references.

For the first pass:

- Exclude Supabase-managed `storage` schema DDL from generic restore.
- Inventory Storage metadata in the manifest for audit only; do not restore it as though the binaries existed.
- After recovery, run a documented reconciliation that lists restored/expected object keys and compares them with actual bucket object listings; report missing binaries and metadata-only entries.
- A separate Storage-object export is required for full file recovery and is explicitly outside this first database-backup workflow.

## 6. Guarded offline restore procedure

Because the private `age` identity never touches GitHub, restoration is deliberately performed from the owner’s trusted local computer rather than a GitHub runner. Add a reviewed restore script and documentation with these gates:

1. Require the local encrypted archive path, source and target project refs, acknowledgement that target data will be replaced, and typed phrase `RESTORE PORTFOLIOAI DATABASE`.
2. Require `--disposable-test` mode until recovery certification has passed. Production mode remains disabled in the script unless a local certification record names the tested backup format/version.
3. Decrypt locally with the owner’s offline `age` identity, reject unsafe archive paths, and verify manifest hashes before any database connection.
4. Verify source metadata, target project ref, PostgreSQL major version, application migration inventory, and Auth schema compatibility.
5. Take a fresh pre-restore encrypted backup of the target before destructive operations.
6. Restore permitted project-created roles, then application schemas/data with deterministic `pg_restore` options, ownership mapping, error-stop behavior, and the narrow Auth process above.
7. Avoid extension conflicts by listing extension requirements in the manifest, verifying required extensions already exist on the Supabase target, and restoring from a filtered `pg_restore` table-of-contents that excludes `EXTENSION` and `COMMENT - EXTENSION` entries. The script never drops, recreates, or changes ownership of Supabase-managed extensions; a missing or incompatible required extension stops the restore.
8. Run read-only checks for expected migrations, schemas, functions, views, RLS policies, grants, Auth counts/identity integrity, and representative application row counts captured in the manifest.
9. Run the Storage metadata/object reconciliation and report divergence.
10. Delete decrypted working files and unset database credentials on exit, including failure paths.

The restore script is created and statically tested but is not run against Supabase during implementation.

## 7. Required GitHub configuration

Document these repository/environment values:

- Secret `PORTFOLIOAI_DATABASE_URL`: source Session pooler URL.
- Variable `PORTFOLIOAI_SUPABASE_PROJECT_REF`.
- Secret `PORTFOLIOAI_STORAGE_S3_ACCESS_KEY_ID`.
- Secret `PORTFOLIOAI_STORAGE_S3_SECRET_ACCESS_KEY`.
- Variable `PORTFOLIOAI_BACKUP_BUCKET` (must already exist and be private).
- Variable `PORTFOLIOAI_AGE_RECIPIENT`: public encryption recipient.

The workflow uses dedicated Storage S3 credentials; it does not introduce a service-role key into the app or repository. The private `age` identity and target restore database URL are supplied only on the owner’s local machine and never configured in GitHub.

## 8. Documentation and certification checklist

Add `docs/database-backup-and-recovery.md` covering setup, connection format, encryption-key custody, manual backup, private object inspection, local download, restore gates, Auth limitations, extension handling, Storage divergence, and platform configuration exclusions.

The documentation must state prominently that the Supabase Storage object is **not** disaster-independent while it remains in the same project. Immediately after every successful run, the owner must copy the exact object key shown in the workflow summary, download that encrypted `.age` file to local offline storage, and verify its ciphertext SHA-256 hash against the manifest/summary. Only that completed download provides the requested off-project second copy.

The certification checklist requires an actual disposable-project test after implementation:

- Backup completes, the exact Storage object key is visible in the summary, and the encrypted archive is downloaded and hash-verified on the owner’s local computer.
- Archive decrypts and all hashes match.
- Application schema, data, functions, policies, grants, and migrations match expected inventories.
- Auth data restore succeeds without replacing managed Auth DDL; a designated test login works.
- No Supabase system role creation conflicts occur.
- Storage reconciliation identifies metadata/binary differences accurately.
- A second backup after restore can be generated.

Production restore remains disabled until these checks are recorded as passed. If the user does not provide a disposable project, implementation can finish but recovery remains **uncertified**.

## 9. Static validation before delivery

- Parse the backup YAML and validate action structure; syntax-check the offline restore script without connecting to a database.
- Run ShellCheck against shell blocks where practical.
- Confirm both triggers are manual-only and permissions are least privilege.
- Confirm transaction-mode pooler endpoints are rejected.
- Confirm the archive uploaded to Storage is encrypted ciphertext only and no GitHub Actions artifact upload exists.
- Confirm no broad role restoration or managed Auth schema replacement exists.
- Confirm restore TOC filtering excludes extension DDL and comments while preflight verifies required extensions.
- Scan for secret-shaped values.
- Confirm no workflow was dispatched, no database/Storage operation occurred, and no migration/app file changed.

## Out of scope

- Scheduled execution, GitHub Actions artifact retention, and automatic deletion retention.
- Running the first backup or mandatory disposable-project recovery certification in the implementation turn.
- Physical Supabase Storage-object backup.
- Supabase project settings, Auth provider configuration, Edge Function code/secrets, custom domains, or external-provider configuration.
- Application, migration, RLS, Edge Function, or UI changes.
