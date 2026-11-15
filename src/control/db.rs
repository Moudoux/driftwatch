//! SQLite storage for the control server: CA, agents, passkeys, sessions and
//! invites. Queries are tiny, so a mutex-guarded connection is plenty.

use std::path::Path;
use std::sync::Mutex;

use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;

pub struct Db(Mutex<Connection>);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRow {
    pub id: String,
    pub name: String,
    pub address: String,
    pub port: u16,
    pub fingerprint: String,
    pub created_at: i64,
    pub cert_issued_at: i64,
}

#[derive(Debug, Clone)]
pub struct PasskeyRow {
    pub id: Vec<u8>,
    pub name: String,
    pub public_key: Vec<u8>,
    pub sign_count: u32,
    pub created_at: i64,
    pub last_used_at: Option<i64>,
}

pub fn now() -> i64 {
    time::OffsetDateTime::now_utc().unix_timestamp()
}

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    address        TEXT NOT NULL,
    port           INTEGER NOT NULL,
    fingerprint    TEXT NOT NULL,
    created_at     INTEGER NOT NULL,
    cert_issued_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS passkeys (
    id           BLOB PRIMARY KEY,
    name         TEXT NOT NULL,
    public_key   BLOB NOT NULL,
    sign_count   INTEGER NOT NULL DEFAULT 0,
    created_at   INTEGER NOT NULL,
    last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
    token_hash BLOB PRIMARY KEY,
    passkey_id BLOB NOT NULL REFERENCES passkeys(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
    token_hash BLOB PRIMARY KEY,
    expires_at INTEGER NOT NULL
);
"#;

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).with_context(|| format!("create {}", dir.display()))?;
        }
        let conn = Connection::open(path).with_context(|| format!("open {}", path.display()))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "foreign_keys", "ON")?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.execute_batch(SCHEMA)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
        }
        Ok(Db(Mutex::new(conn)))
    }

    fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.0.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn meta_get(&self, key: &str) -> Result<Option<String>> {
        Ok(self
            .conn()
            .query_row("SELECT value FROM meta WHERE key = ?1", [key], |r| r.get(0))
            .optional()?)
    }

    pub fn meta_set(&self, key: &str, value: &str) -> Result<()> {
        self.conn().execute(
            "INSERT INTO meta (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    // ---- agents ----

    fn agent_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<AgentRow> {
        Ok(AgentRow {
            id: r.get(0)?,
            name: r.get(1)?,
            address: r.get(2)?,
            port: r.get(3)?,
            fingerprint: r.get(4)?,
            created_at: r.get(5)?,
            cert_issued_at: r.get(6)?,
        })
    }

    pub fn agents(&self) -> Result<Vec<AgentRow>> {
        let c = self.conn();
        let mut st = c.prepare(
            "SELECT id, name, address, port, fingerprint, created_at, cert_issued_at FROM agents ORDER BY name COLLATE NOCASE",
        )?;
        let rows = st
            .query_map([], Self::agent_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn agent(&self, id: &str) -> Result<Option<AgentRow>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT id, name, address, port, fingerprint, created_at, cert_issued_at FROM agents WHERE id = ?1",
                [id],
                Self::agent_from_row,
            )
            .optional()?)
    }

    pub fn insert_agent(&self, a: &AgentRow) -> Result<()> {
        self.conn().execute(
            "INSERT INTO agents (id, name, address, port, fingerprint, created_at, cert_issued_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![a.id, a.name, a.address, a.port, a.fingerprint, a.created_at, a.cert_issued_at],
        )?;
        Ok(())
    }

    pub fn update_agent(&self, id: &str, name: &str, address: &str, port: u16) -> Result<bool> {
        Ok(self.conn().execute(
            "UPDATE agents SET name = ?2, address = ?3, port = ?4 WHERE id = ?1",
            params![id, name, address, port],
        )? > 0)
    }

    pub fn set_agent_fingerprint(&self, id: &str, fingerprint: &str) -> Result<bool> {
        Ok(self.conn().execute(
            "UPDATE agents SET fingerprint = ?2, cert_issued_at = ?3 WHERE id = ?1",
            params![id, fingerprint, now()],
        )? > 0)
    }

    pub fn delete_agent(&self, id: &str) -> Result<bool> {
        Ok(self
            .conn()
            .execute("DELETE FROM agents WHERE id = ?1", [id])?
            > 0)
    }

    // ---- passkeys ----

    fn passkey_from_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<PasskeyRow> {
        Ok(PasskeyRow {
            id: r.get(0)?,
            name: r.get(1)?,
            public_key: r.get(2)?,
            sign_count: r.get(3)?,
            created_at: r.get(4)?,
            last_used_at: r.get(5)?,
        })
    }

    pub fn passkeys(&self) -> Result<Vec<PasskeyRow>> {
        let c = self.conn();
        let mut st = c.prepare(
            "SELECT id, name, public_key, sign_count, created_at, last_used_at FROM passkeys ORDER BY created_at",
        )?;
        let rows = st
            .query_map([], Self::passkey_from_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn passkey_count(&self) -> Result<i64> {
        Ok(self
            .conn()
            .query_row("SELECT COUNT(*) FROM passkeys", [], |r| r.get(0))?)
    }

    pub fn passkey(&self, id: &[u8]) -> Result<Option<PasskeyRow>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT id, name, public_key, sign_count, created_at, last_used_at FROM passkeys WHERE id = ?1",
                [id],
                Self::passkey_from_row,
            )
            .optional()?)
    }

    pub fn insert_passkey(
        &self,
        id: &[u8],
        name: &str,
        public_key: &[u8],
        sign_count: u32,
    ) -> Result<()> {
        self.conn().execute(
            "INSERT INTO passkeys (id, name, public_key, sign_count, created_at, last_used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
            params![id, name, public_key, sign_count, now()],
        )?;
        Ok(())
    }

    pub fn passkey_used(&self, id: &[u8], sign_count: u32) -> Result<()> {
        self.conn().execute(
            "UPDATE passkeys SET sign_count = ?2, last_used_at = ?3 WHERE id = ?1",
            params![id, sign_count, now()],
        )?;
        Ok(())
    }

    pub fn rename_passkey(&self, id: &[u8], name: &str) -> Result<bool> {
        Ok(self.conn().execute(
            "UPDATE passkeys SET name = ?2 WHERE id = ?1",
            params![id, name],
        )? > 0)
    }

    /// Deletes a passkey (and its sessions) unless it is the last one.
    pub fn delete_passkey(&self, id: &[u8]) -> Result<Result<(), &'static str>> {
        let mut c = self.conn();
        let tx = c.transaction()?;
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM passkeys", [], |r| r.get(0))?;
        if count <= 1 {
            return Ok(Err("you cannot delete your last passkey"));
        }
        let n = tx.execute("DELETE FROM passkeys WHERE id = ?1", [id])?;
        tx.commit()?;
        Ok(if n > 0 {
            Ok(())
        } else {
            Err("no such passkey")
        })
    }

    // ---- sessions ----

    pub fn create_session(
        &self,
        token_hash: &[u8],
        passkey_id: &[u8],
        ttl_secs: i64,
    ) -> Result<()> {
        let now = now();
        let c = self.conn();
        c.execute("DELETE FROM sessions WHERE expires_at < ?1", [now])?;
        c.execute(
            "INSERT INTO sessions (token_hash, passkey_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)",
            params![token_hash, passkey_id, now, now + ttl_secs],
        )?;
        Ok(())
    }

    /// Returns the passkey id of a valid session.
    pub fn session(&self, token_hash: &[u8]) -> Result<Option<Vec<u8>>> {
        Ok(self
            .conn()
            .query_row(
                "SELECT passkey_id FROM sessions WHERE token_hash = ?1 AND expires_at > ?2",
                params![token_hash, now()],
                |r| r.get(0),
            )
            .optional()?)
    }

    pub fn delete_session(&self, token_hash: &[u8]) -> Result<()> {
        self.conn()
            .execute("DELETE FROM sessions WHERE token_hash = ?1", [token_hash])?;
        Ok(())
    }

    // ---- invites ----

    pub fn create_invite(&self, token_hash: &[u8], ttl_secs: i64) -> Result<i64> {
        let now = now();
        let c = self.conn();
        c.execute("DELETE FROM invites WHERE expires_at < ?1", [now])?;
        c.execute(
            "INSERT INTO invites (token_hash, expires_at) VALUES (?1, ?2)",
            params![token_hash, now + ttl_secs],
        )?;
        Ok(now + ttl_secs)
    }

    pub fn invite_valid(&self, token_hash: &[u8]) -> Result<bool> {
        Ok(self
            .conn()
            .query_row(
                "SELECT 1 FROM invites WHERE token_hash = ?1 AND expires_at > ?2",
                params![token_hash, now()],
                |_| Ok(()),
            )
            .optional()?
            .is_some())
    }

    /// Atomically uses up an invite. Returns false if it was invalid or already used.
    pub fn consume_invite(&self, token_hash: &[u8]) -> Result<bool> {
        Ok(self.conn().execute(
            "DELETE FROM invites WHERE token_hash = ?1 AND expires_at > ?2",
            params![token_hash, now()],
        )? > 0)
    }
}
