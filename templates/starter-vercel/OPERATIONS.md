# Starter Operations Runbook

## Backups

### Local Node deployment (SQLite + local uploads)

- Database backup:

```bash
cp data.db backups/data-$(date +%F).db
```

- Uploads backup:

```bash
tar -czf backups/uploads-$(date +%F).tgz uploads/
```

### Serverless deployment (Postgres + S3)

- Database backup: use your Postgres provider snapshot/backup tooling.
- Media backup: enable bucket versioning or replication in your object storage provider.

## Restore

### Local Node deployment

```bash
cp backups/data-YYYY-MM-DD.db data.db
tar -xzf backups/uploads-YYYY-MM-DD.tgz
```

### Serverless deployment

- Restore database from provider snapshot.
- Restore object storage data from versioned objects or backup bucket.

## Update policy

1. Keep each client site in its own git repo.
2. Pull template updates into a staging branch first.
3. Run:
   - `pnpm setup:hosting --provider=<provider>`
   - `pnpm check:images`
   - `pnpm check:seo`
4. Verify `/`, `/posts`, `/contact`, and `/_emdash/admin` manually.
5. Merge and deploy only after staging checks pass.
