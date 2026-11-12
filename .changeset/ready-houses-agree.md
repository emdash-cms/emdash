---
"emdash": patch
---

Prevents SQLite from creating a blank database when the main file is missing but its `-wal` or `-shm` file remains, protecting committed content still in the write-ahead log. EmDash refuses the open and logs an error without changing these files. Stop the server and restore the original main file before restarting. This cannot recover data already overwritten by an earlier startup.

To intentionally discard all local SQLite data and start fresh, stop all processes using the database and delete `data.db`, `data.db-wal`, and `data.db-shm` (substitute your configured database path). Reset scripts that delete only `data.db` must also remove its sidecars.
