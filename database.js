const sqlite3 = require("sqlite3").verbose();
const path = require("path");
const fs = require("fs");
const schedule = require("node-schedule");

// ✅ Define database and backup paths with fallbacks
const dbPath = path.resolve(process.env.DB_PATH || "./database/tickets.db");
const backupDir = path.resolve(process.env.BACKUP_DIR || "./database/backups");

// ✅ Ensure backup directory exists
if (!fs.existsSync(backupDir)) {
  fs.mkdirSync(backupDir, { recursive: true });
}

// ✅ Connect to the SQLite database
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error("❌ Database Connection Error:", err);
    process.exit(1); // Exit if the database connection fails
  } else {
    console.log("✅ Connected to the SQLite database.");
    db.serialize(() => {
      db.run("PRAGMA foreign_keys = ON;"); // Enforce FK constraints
      db.run("PRAGMA journal_mode = WAL;"); // Confirm WAL mode (persisted on disk)
      db.run("PRAGMA synchronous = NORMAL;"); // Safe + fast pairing with WAL
      db.run("PRAGMA wal_autocheckpoint = 1000;"); // ~4MB; ensure not disabled
      db.run("PRAGMA busy_timeout = 5000;"); // Wait up to 5s instead of SQLITE_BUSY
    });
  }
});

// ✅ Force a full WAL checkpoint and truncate the -wal file back to zero.
// TRUNCATE (not PASSIVE/FULL) is what actually shrinks the file on disk.
function checkpointWAL(callback) {
  db.run("PRAGMA wal_checkpoint(TRUNCATE);", (err) => {
    if (err) {
      console.error("❌ WAL checkpoint failed:", err);
    } else {
      console.log("✅ WAL checkpoint (TRUNCATE) completed.");
    }
    if (callback) callback(err);
  });
}

// ✅ Checkpoint then close the connection cleanly (used on graceful shutdown
// so a pm2 restart never leaves a bloated WAL or a half-written transaction).
function closeDatabase(callback) {
  checkpointWAL(() => {
    db.close((err) => {
      if (err) {
        console.error("❌ Error closing database:", err);
      } else {
        console.log("✅ Database connection closed cleanly.");
      }
      if (callback) callback(err);
    });
  });
}

// ✅ Promisified query helpers with centralized error logging. Use these for
// new code and for fire-and-forget writes that would otherwise swallow errors.
// dbRun resolves with the statement context (this.lastID / this.changes).
function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) {
        console.error("❌ dbGet failed:", err.message, "| SQL:", sql);
        return reject(err);
      }
      resolve(row);
    });
  });
}

function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) {
        console.error("❌ dbAll failed:", err.message, "| SQL:", sql);
        return reject(err);
      }
      resolve(rows);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) {
        console.error("❌ dbRun failed:", err.message, "| SQL:", sql);
        return reject(err);
      }
      resolve(this);
    });
  });
}

// ✅ Function to create a database backup
function backupDatabase() {
  vacuumDatabase((err) => {
    if (err) {
      console.error("❌ Backup aborted due to VACUUM failure:", err);
      return;
    }

    // Flush the WAL into the main DB file BEFORE copying, otherwise the
    // backup is missing every change still sitting in tickets.db-wal.
    checkpointWAL(() => {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = path.join(backupDir, `backup-${timestamp}.db`);

      fs.copyFile(dbPath, backupPath, (err) => {
        if (err) {
          console.error("❌ Database backup failed:", err);
        } else {
          console.log(`✅ Database backup created: ${backupPath}`);
        }
      });
    });
  });
}

// ✅ Function to perform a VACUUM operation
function vacuumDatabase(callback) {
  db.run("VACUUM", (err) => {
    if (err) {
      console.error("❌ VACUUM operation failed:", err);
      callback(err);
    } else {
      console.log("✅ Database VACUUM completed.");
      callback();
    }
  });
}

// ✅ Function to check database integrity
function checkDatabaseIntegrity() {
  db.get("PRAGMA integrity_check", (err, row) => {
    if (err) {
      console.error("❌ Database integrity check failed:", err);
    } else if (row.integrity_check !== "ok") {
      console.warn("⚠️ Potential database corruption detected!", row);
    } else {
      console.log("✅ Database integrity check passed.");
    }
  });
}

// ✅ Function to delete old backups (older than 7 days)
async function deleteOldBackups() {
  try {
    const files = fs.readdirSync(backupDir);
    const now = Date.now();
    const sevenDays = 7 * 24 * 60 * 60 * 1000;

    await Promise.all(
      files.map(async (file) => {
        const filePath = path.join(backupDir, file);
        const stats = fs.statSync(filePath);

        if (now - stats.mtimeMs > sevenDays) {
          fs.unlink(filePath, (err) => {
            if (err) {
              console.error("❌ Failed to delete old backup:", err);
            } else {
              console.log(`🗑️ Deleted old backup: ${filePath}`);
            }
          });
        }
      })
    );
  } catch (error) {
    console.error("❌ Error cleaning up old backups:", error);
  }
}

// ✅ Function to initialize database tables
function initializeTables() {
  db.serialize(() => {
    db.run("BEGIN TRANSACTION");
    //create ai_info table
    db.run(
      `CREATE TABLE IF NOT EXISTS ai_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        guild_id TEXT,
        ticket_id TEXT,
        prompt_length INTEGER,
        model_used TEXT,
        fallback_used BOOLEAN,
        tokens_estimated INTEGER,
        response_time_ms INTEGER,
        success BOOLEAN,
        error_message TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      function (err) {
        if (err) {
          console.error("❌ Error creating 'ai_logs' table:", err);
        } else {
          console.log("✅ 'ai_logs' table created or already exists.");
        }
      }
    );

    // Create tickets table
    db.run(
      `CREATE TABLE IF NOT EXISTS tickets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        claimed_by TEXT DEFAULT NULL,
        status TEXT DEFAULT 'open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_activity TEXT DEFAULT CURRENT_TIMESTAMP,
        last_reminder_sent TIMESTAMP DEFAULT NULL,
        reminder_stage TEXT DEFAULT 'none',
        snooze_until TEXT DEFAULT NULL,
        message_id TEXT NULL
      )`,
      function (err) {
        if (err) {
          console.error("❌ Error creating 'tickets' table:", err);
        } else {
          console.log("✅ 'tickets' table created or already exists.");
        }
      }
    );

    // Create ticket_users table
    db.run(
      `CREATE TABLE IF NOT EXISTS ticket_users (
        user_id TEXT PRIMARY KEY
      )`,
      function (err) {
        if (err) {
          console.error("❌ Error creating 'ticket_users' table:", err);
        } else {
          console.log("✅ 'ticket_users' table created or already exists.");
        }
      }
    );

    db.run(
      `CREATE TABLE IF NOT EXISTS ai_settings (
        guild_id TEXT PRIMARY KEY,
    
        ticket_ai_enabled BOOLEAN DEFAULT TRUE,
        ticket_ai_mode TEXT DEFAULT 'professional',
        ticket_ai_max_tokens INTEGER DEFAULT 50000,
    
        ai_chat_enabled BOOLEAN DEFAULT TRUE,
        ai_chat_mode TEXT DEFAULT 'casual',
        ai_chat_max_tokens INTEGER DEFAULT 2000,
    
        ignore_token_limit BOOLEAN DEFAULT FALSE
      )`,
      function (err) {
        if (err) {
          console.error("❌ Error creating 'ai_settings' table:", err);
        } else {
          console.log("✅ 'ai_settings' table created or already exists.");
        }
      }
    );

    // Create conversation_history table
    db.run(
      `CREATE TABLE IF NOT EXISTS conversation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ticket_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        user_id TEXT
      )`,
      function (err) {
        if (err) {
          console.error("❌ Error creating 'conversation_history' table:", err);
        } else {
          console.log(
            "✅ 'conversation_history' table created or already exists."
          );
        }
      }
    );

    // Create ticket_platforms table
    db.run(
      `CREATE TABLE IF NOT EXISTS ticket_platforms (
        platform TEXT PRIMARY KEY,
        ticket_count INTEGER DEFAULT 0
      )`,
      function (err) {
        if (err) {
          console.error("❌ Error creating 'ticket_platforms' table:", err);
        } else {
          console.log("✅ 'ticket_platforms' table created or already exists.");
        }
      }
    );

    // Create blacklist table
    db.run(
      `CREATE TABLE IF NOT EXISTS blacklist (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        reason TEXT DEFAULT NULL
      )`,
      function (err) {
        if (err) {
          console.error("❌ Error creating 'blacklist' table:", err);
        } else {
          console.log("✅ 'blacklist' table created or already exists.");
        }
      }
    );

    // Create settings table
    db.run(
      `CREATE TABLE IF NOT EXISTS settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        ticket_creation_paused BOOLEAN DEFAULT 0
      )`,
      function (err) {
        if (err) {
          console.error("❌ Error creating 'settings' table:", err);
        } else {
          console.log("✅ 'settings' table created or already exists.");
        }
      }
    );

    // Create transcripts table
    db.run(
      `CREATE TABLE IF NOT EXISTS transcripts (
        id TEXT PRIMARY KEY,
        ticket_id INTEGER NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        closed_by TEXT NOT NULL,
        closed_by_username TEXT NOT NULL,
        closure_reason TEXT DEFAULT NULL,
        created_at TIMESTAMP NOT NULL,
        closed_at TIMESTAMP NOT NULL
      )`,
      function (err) {
        if (err) {
          console.error("❌ Error creating 'transcripts' table:", err);
        } else {
          console.log("✅ 'transcripts' table created or already exists.");
        }
      }
    );

    // Create transcript_messages table
    db.run(
      `CREATE TABLE IF NOT EXISTS transcript_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        transcript_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        username TEXT NOT NULL,
        avatar_url TEXT NOT NULL,
        message TEXT NOT NULL,
        timestamp TIMESTAMP NOT NULL,
        attachment_url TEXT DEFAULT NULL,
        embed_data TEXT DEFAULT NULL,
        reactions TEXT DEFAULT NULL,
        FOREIGN KEY (transcript_id) REFERENCES transcripts(id)
      )`,
      function (err) {
        if (err) {
          console.error("❌ Error creating 'transcript_messages' table:", err);
        } else {
          console.log(
            "✅ 'transcript_messages' table created or already exists."
          );
        }
      }
    );

    db.run("COMMIT");
  });
}

// ✅ Idempotent schema migrations for existing databases.
// CREATE TABLE IF NOT EXISTS never alters an existing table, so columns added
// after the table was first created must be applied with ALTER TABLE here.
function runMigrations() {
  const requiredColumns = [
    { name: "reminder_stage", ddl: "TEXT DEFAULT 'none'" },
    { name: "snooze_until", ddl: "TEXT DEFAULT NULL" },
  ];

  db.all("PRAGMA table_info(tickets)", (err, rows) => {
    if (err) {
      console.error("❌ Migration failed reading tickets schema:", err);
      return;
    }

    const existing = new Set(rows.map((r) => r.name));

    for (const col of requiredColumns) {
      if (existing.has(col.name)) {
        console.log(`ℹ️ Migration skipped — column '${col.name}' already exists.`);
        continue;
      }
      db.run(
        `ALTER TABLE tickets ADD COLUMN ${col.name} ${col.ddl}`,
        (alterErr) => {
          if (alterErr) {
            console.error(
              `❌ Migration failed adding column '${col.name}':`,
              alterErr
            );
          } else {
            console.log(`✅ Migration applied — added column '${col.name}'.`);
          }
        }
      );
    }
  });
}

// ✅ Initialize tables
initializeTables();

// ✅ Apply migrations after tables exist (queued after initializeTables on the
// same serialized connection).
runMigrations();

// ✅ Schedule daily tasks
schedule.scheduleJob("0 2 * * *", () => {
  try {
    console.log("🔍 Running daily database integrity check...");
    checkDatabaseIntegrity();
  } catch (error) {
    console.error("❌ Error during integrity check:", error);
  }
});

schedule.scheduleJob("0 3 * * *", () => {
  try {
    console.log("⏳ Running scheduled database backup...");
    backupDatabase();
  } catch (error) {
    console.error("❌ Error during scheduled backup:", error);
  }
});

schedule.scheduleJob("0 4 * * *", () => {
  try {
    console.log("⏳ Running scheduled backup cleanup...");
    deleteOldBackups();
  } catch (error) {
    console.error("❌ Error during backup cleanup:", error);
  }
});

// Hourly (at :30) WAL checkpoint so the -wal file can't grow unbounded
// between nightly backups / restarts.
schedule.scheduleJob("30 * * * *", () => {
  try {
    console.log("⏳ Running hourly WAL checkpoint...");
    checkpointWAL();
  } catch (error) {
    console.error("❌ Error during WAL checkpoint:", error);
  }
});

// Function to record a unique user (inserts only if not already present)
function addUniqueUser(userId, callback) {
  db.run(
    `INSERT OR IGNORE INTO ticket_users (user_id) VALUES (?)`,
    [userId],
    function (err) {
      if (err) {
        console.error("Error adding unique user:", err);
      }
      if (callback) callback(err);
    }
  );
}

// Function to increment the ticket count for a given platform
function incrementTicketPlatform(platform, callback) {
  db.run(
    `UPDATE ticket_platforms SET ticket_count = ticket_count + 1 WHERE platform = ?`,
    [platform],
    function (err) {
      if (err) {
        console.error("Error updating ticket platform:", err);
        if (callback) callback(err);
      } else if (this.changes === 0) {
        // No row updated, so insert new record
        db.run(
          `INSERT INTO ticket_platforms (platform, ticket_count) VALUES (?, 1)`,
          [platform],
          function (err) {
            if (err) {
              console.error("Error inserting ticket platform:", err);
            }
            if (callback) callback(err);
          }
        );
      } else {
        if (callback) callback(null);
      }
    }
  );
}

// (Optional) Function to retrieve stats for display or logging
function getStats(callback) {
  db.get(`SELECT COUNT(*) AS count FROM ticket_users`, (err, row) => {
    if (err) return callback(err);

    const uniqueUserCount = row.count;

    db.all(
      `SELECT platform, ticket_count FROM ticket_platforms`,
      (err, rows) => {
        if (err) return callback(err);

        const platformStats = rows;

        // ✅ Sum ticket counts from platformStats
        const totalTicketCount = rows.reduce(
          (sum, row) => sum + Number(row.ticket_count),
          0
        );

        callback(null, {
          uniqueUserCount,
          platformStats,
          totalTicketCount,
        });
      }
    );
  });
}

// ✅ Export modules
module.exports = {
  db,
  backupDatabase,
  deleteOldBackups,
  addUniqueUser,
  incrementTicketPlatform,
  getStats,
  checkpointWAL,
  closeDatabase,
  dbGet,
  dbAll,
  dbRun,
};
