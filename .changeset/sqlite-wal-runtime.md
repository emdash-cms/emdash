---
"emdash": minor
---

Updates the `sqlite()` database adapter to open the database in write-ahead logging (WAL) mode, matching what `emdash init`, `emdash dev`, and `emdash seed` already do. Sites whose database was created or touched by those commands were already running in WAL mode; sites whose database was only ever opened by the running server switch to it on their next start.

In WAL mode, SQLite keeps `-wal` and `-shm` files next to the database (for example `data.db-wal` and `data.db-shm`), and the server needs write access to the database directory. If your backup script copies only the `.db` file while the site is running, switch to `sqlite3 data.db ".backup backup.db"`, or stop the server first and copy all three files.

Keep the database on a local disk or block volume: WAL does not work on network filesystems such as NFS or SMB.
