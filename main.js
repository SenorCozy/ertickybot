require("dotenv").config();
const { Client, GatewayIntentBits, Collection, Events } = require("discord.js");
// ✅ Initialize Discord Bot
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
});
const express = require("express");
const session = require("express-session");
const passport = require("passport");
const SQLiteStore = require("connect-sqlite3")(session);
const path = require("path");
const bodyParser = require("body-parser");
const flash = require("express-flash");
const passportDiscord = require("passport-discord").Strategy;
const cookieParser = require("cookie-parser");
const { exec } = require("child_process");
const fs = require("fs");
const http = require("http");
const { Server } = require("socket.io");
const {
  db,
  backupDatabase,
  deleteOldBackups,
  closeDatabase,
} = require("./database");
const marked = require("marked");
const he = require("he");
const { encryptText, decryptText } = require("./crypto");

// Remove all existing listeners for the interactionCreate event
client.removeAllListeners("interactionCreate");

// Load event files
const eventFiles = fs
  .readdirSync("./events")
  .filter((file) => file.endsWith(".js"));

for (const file of eventFiles) {
  const event = require(`./events/${file}`);
  console.log(`🟢 Loading event: ${event.name} from ${file}`);
  if (event.once) {
    client.once(event.name, (...args) => event.execute(...args, client));
  } else {
    client.on(event.name, (...args) => event.execute(...args, client));
  }
}
const lockFile = "./bot.lock";

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0); // Signal 0 doesn't kill, just tests existence
    return true;
  } catch (err) {
    return false;
  }
}

if (fs.existsSync(lockFile)) {
  const existingPid = parseInt(fs.readFileSync(lockFile, "utf8"), 10);
  if (!isNaN(existingPid) && isProcessRunning(existingPid)) {
    console.error(
      `❌ Another bot instance (PID ${existingPid}) is already running. Exiting...`
    );
    process.exit(1);
  } else {
    console.warn(
      `⚠️ Stale lockfile found for PID ${existingPid}. Removing stale lock.`
    );
    fs.unlinkSync(lockFile);
  }
}

// Create the new lock file with current PID
fs.writeFileSync(lockFile, process.pid.toString());

// Clean up the lock file on exit
process.on("exit", () => {
  if (fs.existsSync(lockFile)) {
    fs.unlinkSync(lockFile);
  }
});

// Graceful shutdown: stop the idle loop, disconnect Discord, checkpoint +
// close the DB (so a pm2 restart never abandons a fat WAL), then exit. A hard
// timeout guarantees we never hang pm2's stop sequence.
let isShuttingDown = false;
let idleInterval = null;

function gracefulShutdown(signal, exitCode) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log(`🔻 Received ${signal} — shutting down gracefully...`);

  const killTimer = setTimeout(() => {
    console.error("⏰ Graceful shutdown timed out — forcing exit.");
    process.exit(exitCode);
  }, 4000);
  killTimer.unref();

  try {
    if (idleInterval) clearInterval(idleInterval);
  } catch {}

  Promise.resolve()
    .then(() => client.destroy())
    .catch((e) => console.error("❌ Error destroying Discord client:", e))
    .finally(() => {
      closeDatabase(() => {
        clearTimeout(killTimer);
        process.exit(exitCode);
      });
    });
}

process.on("SIGINT", () => gracefulShutdown("SIGINT", 0));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM", 0));

process.on("uncaughtException", (err) => {
  console.error("❌ Uncaught Exception:", err);
  gracefulShutdown("uncaughtException", 1);
});

// Log and keep running. A single stray promise rejection (transient Discord
// API error, reply on an expired interaction token, etc.) must not crash-loop
// the whole bot under pm2. Genuinely fatal errors still surface as
// uncaughtException above and trigger a clean restart.
process.on("unhandledRejection", (reason) => {
  console.error("❌ Unhandled Rejection (logged, bot continues):", reason);
});

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  PermissionsBitField,
} = require("discord.js");

client.commands = new Collection();
client.buttons = new Collection();
client.modals = new Collection();

let isBotReady = false;
const readyPromise = new Promise((resolve) => {
  client.once("ready", () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
    console.log(`✅ Connected to ${client.guilds.cache.size} servers`);
    isBotReady = true;
    resolve(true);
  });
});

client.isBotReady = () => isBotReady;

// Rep-detection tuning. A separate reputation bot actually records reps by
// reacting with ✅; this bot only offers an "Undo Rep" prompt afterward. The
// ✅ gate is the real arbiter, so this pre-filter is intentionally generous:
// `thank\w*` catches thank/thanks/thankyou/thanku/thankful/thanking (no
// non-gratitude word starts with "thank"), the abbreviations are explicit so
// tysm/tyvm work, and bare `ty` only matches as a whole word (never inside
// pretty/party/type/city).
const REP_PHRASE_REGEX = /\b(?:thank\w*|thanx|thnx|thx|tysm|tyvm|tyty|ty)\b/i;
const REP_CONFIRM_EMOJI = "✅";
// The reputation bot reacts ✅ at an unpredictable latency (longer for double
// reps, since it does more work and is itself rate-limited). A single fixed
// check loses that race, so poll instead: first look after START, then every
// INTERVAL, give up after MAX. The prompt fires exactly once per message.
const REP_POLL_START_MS = 2000;
const REP_POLL_INTERVAL_MS = 3000;
const REP_POLL_MAX_MS = 24000;
const repHandledMessageIds = new Set();

async function pollForRepReaction(message, mentionCount) {
  const deadline = Date.now() + REP_POLL_MAX_MS;
  let attempt = 0;

  await new Promise((r) => setTimeout(r, REP_POLL_START_MS));

  while (Date.now() <= deadline) {
    attempt++;
    if (repHandledMessageIds.has(message.id)) return;

    try {
      const fresh = await message.channel.messages.fetch(message.id);
      const hasRep = fresh.reactions.cache.has(REP_CONFIRM_EMOJI);
      console.log(`🔎 Rep poll #${attempt} msg=${message.id}: ✅=${hasRep}`);

      if (hasRep) {
        try {
          const undoRepButton = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId(`undo_rep_${message.id}`)
              .setLabel("Undo Rep")
              .setStyle(ButtonStyle.Danger)
          );

          if (mentionCount === 1) {
            await message.reply({
              content: `🔍 **Did you mean to give rep?** If not, click below to undo it.`,
              components: [undoRepButton],
            });
          } else {
            await message.reply({
              content: `⚠️ **Did you mean to give rep to more than one player?**\nMost tickets are only eligible for one rep per person per ticket unless this is a specific \`!doubles\` DLC boss or at handler discretion.\n\nClick the button below to remove the rep if needed.`,
              components: [undoRepButton],
            });
          }

          repHandledMessageIds.add(message.id);
          if (repHandledMessageIds.size > 500) repHandledMessageIds.clear();
          console.log(
            `🟢 Rep prompt sent for msg=${message.id} (poll #${attempt}).`
          );
          return;
        } catch (replyErr) {
          console.error(
            `❌ Rep prompt reply failed msg=${message.id}: ${
              replyErr.message || replyErr
            } — will retry.`
          );
        }
      }
    } catch (fetchErr) {
      console.error(
        `❌ Rep poll #${attempt} fetch error msg=${message.id}: ${
          fetchErr.message || fetchErr
        }`
      );
    }

    if (Date.now() + REP_POLL_INTERVAL_MS > deadline) break;
    await new Promise((r) => setTimeout(r, REP_POLL_INTERVAL_MS));
  }

  console.log(
    `⌛ Rep poll gave up for msg=${message.id} after ${attempt} checks (no ✅ within ${REP_POLL_MAX_MS}ms).`
  );
}

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;

  // 🔍 Check if this is a ticket channel
  db.get(
    "SELECT * FROM tickets WHERE channel_id = ? AND status = 'open'",
    [message.channel.id],
    async (err, ticket) => {
      if (err) {
        console.error("❌ Database error checking ticket:", err);
        return;
      }

      if (!ticket) return; // Not a valid ticket channel

      // Only the ticket creator's messages count as activity and reset the
      // idle/reminder cycle. Helper messages intentionally do not, so the bot
      // can still nudge an absent creator during helper triage.
      if (message.author.id === ticket.user_id) {
        db.run(
          "UPDATE tickets SET last_activity = ?, reminder_stage = 'none', last_reminder_sent = NULL, snooze_until = NULL WHERE channel_id = ?",
          [new Date().toISOString(), message.channel.id],
          (updateErr) => {
            if (updateErr) {
              console.error("❌ Error updating ticket activity:", updateErr);
            }
          }
        );
      }

      // ✅ Rep detection — see REP_* constants above.
      const hasThankYou = REP_PHRASE_REGEX.test(message.content);
      // Bots can't be repped, and you can't rep yourself — exclude both so the
      // single-vs-multiple wording reflects the real targets.
      const humanMentions = message.mentions.users.filter(
        (u) => !u.bot && u.id !== message.author.id
      );
      const mentionCount = humanMentions.size;

      if (hasThankYou && mentionCount > 0) {
        console.log(
          `🔵 Possible rep detected (mentions=${mentionCount}, msg=${message.id}): ${message.content}`
        );

        if (repHandledMessageIds.has(message.id)) {
          console.log(
            `↩️ Rep msg ${message.id} already handled — skipping duplicate.`
          );
        } else {
          pollForRepReaction(message, mentionCount).catch((e) =>
            console.error(
              `❌ Rep poll crashed for msg=${message.id}:`,
              e.message || e
            )
          );
        }
      }
    }
  );
});

client.on(Events.GuildMemberRemove, async (member) => {
  try {
    console.log(`🔴 User ${member.user.tag} left the server.`);

    db.get(
      "SELECT * FROM tickets WHERE user_id = ? AND status = 'open'",
      [member.id],
      async (err, ticket) => {
        if (err) {
          console.error("❌ Database error checking open tickets:", err);
          return;
        }

        if (!ticket) {
          console.log(`✅ No open ticket found for ${member.user.tag}.`);
          return;
        }

        const guild = member.guild;
        const ticketChannel = guild.channels.cache.get(ticket.channel_id);

        if (!ticketChannel) {
          console.warn(
            `⚠️ Ticket channel ${ticket.channel_id} not found, skipping message.`
          );
          return;
        }

        console.log(
          `⚠️ User ${member.user.tag} left with an open ticket. Sending notice to channel.`
        );

        // Notify others in the ticket channel
        await ticketChannel.send({
          content: `🚨 According to my calculations 🤓, <@${ticket.user_id}> (the original ticket creator) has left the server.\nThis ticket can most likely be closed by an active helper or ticket handler.`,
        });
      }
    );
  } catch (error) {
    console.error("❌ Error handling guildMemberRemove event:", error);
  }
});

// ✅ Load Commands
const commandFiles = fs
  .readdirSync(path.join(__dirname, "commands"))
  .filter((file) => file.endsWith(".js"));

for (const file of commandFiles) {
  const command = require(`./commands/${file}`);
  client.commands.set(command.data.name, command);
}
// ✅ Log in Bot
console.log("🔑 Logging in bot...");
client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error("❌ Error logging in bot:", err);
});

// SQLite connection is owned by ./database (single shared connection, imported
// above as `db`). main.js no longer opens its own second connection.

//port for server to run on
const PORT = 3000;

// ✅ Create a log file if it doesn't exist
const logFile = "bot.log";
if (!fs.existsSync(logFile)) {
  fs.writeFileSync(logFile, "Bot log initialized...\n");
}

// ✅ Initialize Express App
const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));
app.use(express.static(path.join(__dirname, "public")));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(flash());

//bot logs server and setup
const server = http.createServer(app);
const io = new Server(server);

// bot logs code
// ✅ WebSocket for Live Log Updates
io.on("connection", (socket) => {
  console.log("🟢 New client connected to bot logs.");
  socket.on("error", (error) => {
    console.error("❌ WebSocket error:", error);
  });

  // ✅ Send the entire log history when a client connects
  fs.readFile(logFile, "utf8", (err, data) => {
    if (!err && data) {
      const logLines = data.split("\n").filter((line) => line.trim() !== "");
      socket.emit("logHistory", logLines);
    }
  });

  // ✅ Send error log history separately
  fs.readFile("error.log", "utf8", (err, data) => {
    if (!err && data) {
      const errorLines = data.split("\n").filter((line) => line.trim() !== "");
      socket.emit("errorLogUpdate", errorLines);
    }
  });

  // ✅ Listen for manual log update requests
  socket.on("requestLogUpdate", () => {
    fs.readFile(logFile, "utf8", (err, data) => {
      if (!err && data) {
        const logLines = data.split("\n").filter((line) => line.trim() !== "");
        socket.emit("logUpdate", logLines);
      }
    });

    // ✅ Update error log as well
    fs.readFile("error.log", "utf8", (err, data) => {
      if (!err && data) {
        const errorLines = data
          .split("\n")
          .filter((line) => line.trim() !== "");
        socket.emit("errorLogUpdate", errorLines);
      }
    });
  });

  // ✅ Handle Client Disconnection
  socket.on("disconnect", () => {
    console.log("🔴 Client disconnected from bot logs.");
  });
});

// ✅ Overriding `console.log` to also write to `bot.log`
const originalLog = console.log;
console.log = (...args) => {
  try {
    const message = `[${new Date().toLocaleString()}] ${args.join(" ")}`;
    fs.appendFileSync(logFile, message + "\n"); // Save to log file
    io.emit("logUpdate", message); // Send logs to frontend via WebSocket
  } catch (error) {
    originalLog("❌ Error writing to bot.log:", error);
  }
  originalLog(...args);
};

// ✅ Overriding `console.error` to also write to `error.log`
const originalError = console.error;
console.error = (...args) => {
  try {
    const message = `[${new Date().toLocaleString()}] ERROR: ${args.join(" ")}`;
    fs.appendFileSync("error.log", message + "\n"); // Save to error log file
    io.emit("errorLogUpdate", message); // Send errors to frontend
  } catch (error) {
    originalError("❌ Error writing to error.log:", error);
  }
  originalError(...args);
};

// ✅ Function to Log General Bot Events
function logToFile(message) {
  try {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}\n`;
    fs.appendFile(logFile, logMessage, (err) => {
      if (err) console.error("❌ Error writing to log file:", err);
    });

    // ✅ Send real-time log updates
    io.emit("logUpdate", logMessage);
  } catch (error) {
    console.error("❌ Failed to log event:", error);
  }
}

app.use(
  session({
    secret: process.env.SESSION_SECRET || "supersecret",
    resave: false,
    saveUninitialized: false,
    store: new SQLiteStore({ db: "sessions.db", dir: "./database" }),
    cookie: {
      secure: false, // ❌ `false` for local development; should be `true` in production with HTTPS
      httpOnly: true, // ✅ Prevents client-side JS access for security
      maxAge: 24 * 60 * 60 * 1000, // ✅ 1-day expiration
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// ✅ Middleware: Ensure Bot is Ready
app.use(async (req, res, next) => {
  if (!client.isBotReady()) {
    console.log("⏳ Waiting for bot to be ready before handling request...");
    await readyPromise;
  }
  next();
});

// ✅ OAuth Callback - Stores Access & Refresh Tokens
passport.use(
  new passportDiscord(
    {
      clientID: process.env.DISCORD_CLIENT_ID,
      clientSecret: process.env.DISCORD_CLIENT_SECRET,
      callbackURL: "https://ticketbot.cc/auth/discord/callback",
      scope: ["identify", "guilds", "guilds.members.read"],
    },
    async (accessToken, refreshToken, profile, done) => {
      try {
        profile.accessToken = accessToken;
        profile.refreshToken = refreshToken;
        profile.expiresAt = Date.now() + 604800000; // ✅ Token valid for 7 days
        console.log("✅ OAuth User Authenticated:", profile.username);
        return done(null, profile);
      } catch (err) {
        console.error("❌ OAuth Error:", err);
        return done(err, null);
      }
    }
  )
);

passport.serializeUser((user, done) => {
  done(null, user);
});

passport.deserializeUser((obj, done) => {
  done(null, obj);
});

// ✅ API route to trigger a manual backup
app.post("/backup", ensureAuthenticated, checkModeratorRole, (req, res) => {
  try {
    console.log("⏳ Manual database backup initiated...");
    backupDatabase();
    res.send("✅ Manual backup has been created!");
  } catch (error) {
    console.error("❌ Error in manual backup route:", error);
    res.status(500).send("An error occurred while backing up the database.");
  }
});

// ✅ Discord Login Route - Prevent Storing `/auth/discord` as Return URL
app.get(
  "/auth/discord",
  (req, res, next) => {
    try {
      const currentReturnTo = req.cookies.returnTo;

      // Prevent storing `/auth/discord` itself as returnTo to avoid infinite loop
      if (!currentReturnTo || currentReturnTo === "/auth/discord") {
        res.cookie("returnTo", req.originalUrl, { httpOnly: true });
        console.log("✅ Storing returnTo in cookie:", req.originalUrl);
      }
      next();
    } catch (error) {
      console.error("❌ Error in /auth/discord route:", error);
      res.redirect("/"); // Redirect to home if an error occurs
    }
  },
  passport.authenticate("discord")
);

// ✅ OAuth Callback - Prevent Loop & Clear Cookies on Error
app.get(
  "/auth/discord/callback",
  passport.authenticate("discord", { failureRedirect: "/" }),
  (req, res) => {
    try {
      console.log("✅ OAuth Callback: User Authenticated");

      // Ensure session is saved before redirecting
      req.session.save((err) => {
        if (err) {
          console.error("❌ Error saving session:", err);
          req.logout(() => {}); // Clear session to prevent loop
          res.clearCookie("returnTo");
          return res.redirect("/"); // Redirect to home to break the loop
        }

        // Read `returnTo` from cookie, default to `/tickets`
        let redirectTo = req.cookies.returnTo || "/tickets";

        // Prevent redirecting to `/auth/discord` in case of a loop
        if (redirectTo === "/auth/discord") {
          console.warn("⚠️ Detected potential redirect loop. Resetting...");
          redirectTo = "/dashboard"; // Fallback to a safe page
        }

        console.log("🚀 Redirecting user to:", redirectTo);
        res.clearCookie("returnTo"); // Remove the returnTo cookie after use
        res.redirect(redirectTo);
      });
    } catch (error) {
      console.error("❌ Error in /auth/discord/callback route:", error);
      req.logout(() => {}); // Ensure logout on failure
      res.clearCookie("returnTo");
      res.redirect("/"); // Redirect to a safe page
    }
  }
);

app.post("/restart", ensureAuthenticated, checkModeratorRole, (req, res) => {
  try {
    console.log("🔄 Received /restart request. Attempting to restart...");

    exec("pm2 restart ticketbot", (error, stdout, stderr) => {
      if (error) {
        console.error("❌ Error executing PM2 restart:", error);
        return res.status(500).send("Failed to restart via PM2.");
      }

      console.log("✅ PM2 Restart Command Executed.");
      console.log(`🖥️ STDOUT: ${stdout}`);
      console.log(`⚠️ STDERR: ${stderr}`);

      res.send("✅ Restarting via PM2...");
    });
  } catch (error) {
    console.error("❌ Unexpected error in /restart route:", error);
    res.status(500).send("Unexpected error while restarting the bot.");
  }
});

// 🔁 Redirect root to /dashboard
app.get("/", ensureAuthenticated, checkModeratorRole, (req, res) => {
  res.redirect("/dashboard");
});

// 🧠 Main dashboard route
app.get(
  "/dashboard",
  ensureAuthenticated,
  checkModeratorRole,
  async (req, res) => {
    try {
      await waitForBotReady(); // Ensures the bot is ready before proceeding
      const botUser = await client.user.fetch();
      const botAvatar = botUser.displayAvatarURL({ format: "png", size: 256 });
      const botName = botUser.username;

      // ✅ Fetch bot status
      const botStatus = {
        uptime: Math.floor(process.uptime()),
        serverCount: client.guilds.cache.size,
        userCount: client.users.cache.size,
        status: client.isReady() ? "🟢 Online" : "🔴 Offline",
      };

      // ✅ Fetch active ticket count
      const activeTickets = await new Promise((resolve, reject) => {
        db.get(
          "SELECT COUNT(*) as count FROM tickets WHERE status = 'open'",
          [],
          (err, row) => {
            if (err) reject(err);
            else resolve(row.count);
          }
        );
      });
      // ✅ Fetch recent transcripts
      const transcripts = await new Promise((resolve, reject) => {
        db.all(
          "SELECT * FROM transcripts ORDER BY closed_at DESC LIMIT 5",
          [],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          }
        );
      });

      res.render("dashboard", {
        botStatus,
        activeTickets,
        user: req.user,
        transcripts,
        botAvatar,
        botName,
      });
    } catch (error) {
      console.error("❌ Error loading dashboard:", error);
      res.redirect("/auth/discord");
    }
  }
);

//bot log view

// ✅ Bot Logs Route (WebSocket-based real-time logs)
app.get("/botlog", ensureAuthenticated, (req, res) => {
  try {
    fs.readFile(logFile, "utf8", (err, data) => {
      if (err) {
        console.error("❌ Error reading log file:", err);
        return res.status(500).send("Error loading bot logs.");
      }
      res.render("botlog", { logs: data.split("\n"), user: req.user });
    });
  } catch (error) {
    console.error("❌ Unexpected error loading bot logs:", error);
    res.status(500).send("Internal Server Error.");
  }
});

// ✅ Watch `bot.log` for changes and send updates via WebSocket
fs.watch(logFile, (eventType, filename) => {
  if (filename && eventType === "change") {
    try {
      fs.readFile(logFile, "utf8", (err, data) => {
        if (err) {
          console.error("❌ Error reading bot.log:", err);
          return;
        }
        io.emit("logUpdate", data); // Send log updates to connected clients
      });
    } catch (error) {
      console.error("❌ Unexpected error in log watcher:", error);
    }
  }
});

//fake error test
setTimeout(() => {
  console.error(
    "❌ Test Error: This is a fake error to test the error log system!"
  );
}, 5000);

// View List of Transcripts with Correct Numbering
app.get(
  "/transcripts",
  ensureAuthenticated,
  checkModeratorRole,
  async (req, res) => {
    try {
      if (!req.user) {
        console.error("❌ No user found in session.");
        return res.status(403).send("Forbidden: Not authenticated.");
      }

      console.log("🟢 Loading transcripts for user:", req.user.username);

      const page = parseInt(req.query.page) || 1;
      const limit = 25;
      const offset = (page - 1) * limit;

      const totalTranscripts = await new Promise((resolve, reject) => {
        db.get("SELECT COUNT(*) as count FROM transcripts", [], (err, row) => {
          if (err) reject(err);
          else resolve(row.count);
        });
      });

      const transcripts = await new Promise((resolve, reject) => {
        db.all(
          "SELECT id, username, closed_by_username, closed_at FROM transcripts ORDER BY closed_at DESC LIMIT ? OFFSET ?",
          [limit, offset],
          (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
          }
        );
      });

      transcripts.forEach((transcript, index) => {
        transcript.number = totalTranscripts - offset - index;
      });

      res.render("transcripts", {
        transcripts,
        page,
        totalPages: Math.ceil(totalTranscripts / limit),
        user: req.user, // Ensure the user object is passed
      });
    } catch (error) {
      console.error("❌ Unexpected error in transcripts route:", error);
      res.status(500).send("Error loading transcripts.");
    }
  }
);

// ✅ Delete Transcript Route
app.delete(
  "/transcripts/:id",
  ensureAuthenticated,
  checkModeratorRole,
  async (req, res) => {
    try {
      const transcriptId = req.params.id;
      console.log(`🗑️ Attempting to delete transcript ID: "${transcriptId}"`);

      // Verify if transcript exists
      db.get(
        "SELECT * FROM transcripts WHERE id = ?",
        [transcriptId],
        (err, row) => {
          if (err) {
            console.error("❌ Database error checking transcript:", err);
            return res.status(500).send("Database error.");
          }
          if (!row) {
            console.error("❌ Transcript not found:", transcriptId);
            return res.status(404).send("Transcript not found.");
          }

          console.log(
            `✅ Transcript found, proceeding with deletion: "${transcriptId}"`
          );

          // Delete related messages first
          db.run(
            "DELETE FROM transcript_messages WHERE transcript_id = ?",
            [transcriptId],
            function (err) {
              if (err) {
                console.error("❌ Error deleting transcript messages:", err);
                return res
                  .status(500)
                  .send("Failed to delete transcript messages.");
              }

              // Delete transcript itself
              db.run(
                "DELETE FROM transcripts WHERE id = ?",
                [transcriptId],
                function (err) {
                  if (err) {
                    console.error("❌ Error deleting transcript:", err);
                    return res.status(500).send("Failed to delete transcript.");
                  }

                  console.log(
                    `✅ Successfully deleted transcript ID: "${transcriptId}"`
                  );
                  res.sendStatus(200);
                }
              );
            }
          );
        }
      );
    } catch (error) {
      console.error("❌ Unexpected error deleting transcript:", error);
      res.status(500).send("Failed to delete transcript.");
    }
  }
);

// ✅ View Individual Transcript
app.get("/transcripts/:id", ensureAuthenticated, checkModeratorRole, async (req, res) => {
  try {
    const transcriptId = req.params.id;

    // Fetch transcript metadata
    const transcript = await new Promise((resolve, reject) => {
      db.get(
        "SELECT * FROM transcripts WHERE id = ?",
        [transcriptId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });

    if (!transcript) {
      return res.status(404).send("Transcript not found");
    }

    // Fetch messages
    const messages = await new Promise((resolve, reject) => {
      db.all(
        "SELECT * FROM transcript_messages WHERE transcript_id = ? ORDER BY timestamp ASC",
        [transcriptId],
        (err, rows) => {
          if (err) reject(err);
          else {
            // Decrypt stored message text, then decode HTML entities before passing to EJS
            rows.forEach((row) => {
              row.message = he.decode(decryptText(row.message));
            });
            resolve(rows);
          }
        }
      );
    });

    res.render("transcript", { transcript, messages, marked, he }); // Pass `he` to EJS
  } catch (error) {
    console.error("❌ Error fetching transcript:", error);
    res.status(500).send("Server error");
  }
});

// ✅ Secure Tickets Dashboard View
app.get(
  "/tickets",
  ensureAuthenticated,
  checkModeratorRole,
  async (req, res) => {
    try {
      db.all(
        "SELECT * FROM tickets WHERE status = 'open'",
        [],
        (err, tickets) => {
          if (err) {
            console.error("❌ Database error fetching tickets:", err);
            return res.status(500).send("Internal Server Error.");
          }

          // ✅ Ensure `user` is always defined before rendering
          res.render("tickets", { tickets, user: req.user || {} });
        }
      );
    } catch (error) {
      console.error("❌ Unexpected error in tickets route:", error);
      res.status(500).send("Internal Server Error.");
    }
  }
);

// ✅ Public Privacy Policy (no auth — must be readable by anyone, incl. Discord's review)
app.get("/privacy", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "privacy.html"));
});

// ✅ Logout Route
app.get("/logout", (req, res) => {
  try {
    req.logout((err) => {
      if (err) {
        console.error("❌ Error during logout:", err);
        return res.status(500).send("Error logging out. Please try again.");
      }
      res.redirect("/");
    });
  } catch (error) {
    console.error("❌ Unexpected error in logout route:", error);
    res.status(500).send("Internal Server Error: Logout failed.");
  }
});

// ✅ Start Server After Bot is Ready (with WebSockets)
(async () => {
  try {
    console.log("⏳ Waiting for bot to be ready...");
    await readyPromise;

    server.listen(PORT, "0.0.0.0", () => {
      console.log(
        `🚀 Web dashboard running with WebSockets on http://0.0.0.0:${PORT}`
      );
    });
  } catch (error) {
    console.error("❌ Error starting server:", error);
    process.exit(1); // ✅ Exit the process if the server fails to start
  }
})();

app.post("/close/:id", async (req, res) => {
  try {
    const ticketId = req.params.id;
    const user = req.user;

    db.get(
      "SELECT * FROM tickets WHERE id = ?",
      [ticketId],
      async (err, ticket) => {
        if (err || !ticket) {
          console.error("❌ Ticket not found or DB error:", err);
          return res.status(404).json({ message: "Ticket not found." });
        }

        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        if (!guild) {
          console.error("❌ Guild not found.");
          return res
            .status(500)
            .json({ message: "Bot is not connected to the server." });
        }

        const ticketChannel = guild.channels.cache.get(ticket.channel_id);
        let transcriptId;

        if (ticketChannel) {
          try {
            const messages = await fetchAllMessages(ticketChannel);
            const formattedMessages = messages
              .map((msg) => ({
                user_id: msg.author.id,
                username: msg.author.username,
                avatar: msg.author.displayAvatarURL({ dynamic: true }),
                content: msg.content?.trim().length
                  ? msg.content
                  : msg.attachments.size > 0
                  ? "(Image/GIF attached)"
                  : "(No content)",
                timestamp: msg.createdTimestamp,
                attachments:
                  msg.attachments.size > 0
                    ? JSON.stringify(msg.attachments.map((a) => a.proxyURL))
                    : null,
                embeds:
                  msg.embeds.length > 0
                    ? JSON.stringify(msg.embeds.map((e) => e.toJSON()))
                    : null,
                reactions:
                  msg.reactions.cache.size > 0
                    ? JSON.stringify(
                        msg.reactions.cache.map((r) => ({
                          emoji: r.emoji.name,
                          count: r.count,
                        }))
                      )
                    : null,
              }))
              .reverse();

            transcriptId = `transcript_${Date.now()}`;

            db.run(
              `INSERT INTO transcripts (id, ticket_id, user_id, username, closed_by, closed_by_username, closure_reason, created_at, closed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                transcriptId,
                ticket.id,
                ticket.user_id,
                ticket.username,
                "Admin",
                "Force closed by admin",
                "Forced closure via dashboard",
                ticket.created_at,
                new Date().toISOString(),
              ]
            );

            formattedMessages.forEach((msg) => {
              db.run(
                `INSERT INTO transcript_messages (transcript_id, user_id, username, avatar_url, message, timestamp, attachment_url, embed_data, reactions)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  transcriptId,
                  msg.user_id,
                  msg.username,
                  msg.avatar,
                  encryptText(msg.content),
                  msg.timestamp,
                  msg.attachments,
                  msg.embeds,
                  msg.reactions,
                ]
              );
            });

            const logChannel = guild.channels.cache.get(
              process.env.TRANSCRIPT_CHANNEL_ID
            );
            if (logChannel) {
              const transcriptUrl = `${process.env.TRANSCRIPT_BASE_URL}/${transcriptId}`;
              await logChannel.send({
                embeds: [
                  new EmbedBuilder()
                    .setColor(0xff0000)
                    .setTitle("⚠️ Ticket Force Closed")
                    .addFields(
                      {
                        name: "📄 Ticket ID",
                        value: `${ticket.id}`,
                        inline: true,
                      },
                      {
                        name: "✅ Opened By",
                        value: `<@${ticket.user_id}>`,
                        inline: true,
                      },
                      {
                        name: "🔴 Closed By",
                        value: "Admin (Forced Close)",
                        inline: true,
                      },
                      {
                        name: "📝 Reason",
                        value: "Forced closure via dashboard",
                        inline: false,
                      },
                      {
                        name: "📅 Date Created",
                        value: `<t:${Math.floor(
                          new Date(ticket.created_at).getTime() / 1000
                        )}:F>`,
                        inline: true,
                      },
                      {
                        name: "📅 Date Closed",
                        value: `<t:${Math.floor(Date.now() / 1000)}:F>`,
                        inline: true,
                      }
                    ),
                ],
                components: [
                  new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                      .setLabel("View Transcript")
                      .setStyle(ButtonStyle.Link)
                      .setURL(transcriptUrl)
                  ),
                ],
              });
            }

            await ticketChannel
              .delete()
              .catch((err) =>
                console.warn(
                  "⚠️ Channel already deleted or could not delete:",
                  err
                )
              );
          } catch (transcriptErr) {
            console.error(
              "❌ Error generating transcript or deleting channel:",
              transcriptErr
            );
          }
        } else {
          console.warn(
            "⚠️ Ticket channel not found. Skipping transcript and deletion."
          );
        }

        // Final DB update and cleanup
        try {
          db.run(
            "UPDATE tickets SET status = 'closed' WHERE id = ?",
            [ticketId],
            (err) => {
              if (err)
                console.error("❌ Failed to force-close ticket:", err);
            }
          );
          return res.json({ message: "Ticket force-closed successfully." });
        } catch (updateErr) {
          console.error("❌ Final DB cleanup error:", updateErr);
          return res
            .status(500)
            .json({ message: "Ticket closed, but cleanup failed." });
        }
      }
    );
  } catch (error) {
    console.error("❌ Uncaught error in force-close:", error);
    return res
      .status(500)
      .json({ message: "Unhandled server error during force close." });
  }
});

//helper functions

// Promisified wrappers around the single shared sqlite3 connection (owned by
// ./database, imported as `db`). They log centrally so a failed write is never
// silent. The idle-check awaits them so state is committed before the loop
// continues / the next tick reads it.
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

// Reminder state machine: reminder_stage ∈ none → reminded → final.
//   none     — no reminder outstanding; send one once idle ≥ 30 min.
//   reminded — reminder posted; 30 min later (still idle) post the one-time
//              inactivity notice and move to 'final'.
//   final    — notice already posted; leave the ticket open, do nothing.
// snooze_until pauses the whole machine for 60 min; on expiry the ticket is
// reset to 'none' and re-evaluated immediately (a fresh reminder fires).
// Only the ticket creator's messages reset state (handled in messageCreate).
let idleCheckRunning = false;

async function checkIdleTickets(client) {
  if (idleCheckRunning) {
    console.log("⏭️ Idle check still running — skipping this tick.");
    return;
  }
  idleCheckRunning = true;

  const IDLE_THRESHOLD = 30 * 60 * 1000;
  const POST_REMINDER_GRACE = 30 * 60 * 1000;

  try {
    console.log("Checking for idle tickets...");
    const guild = await client.guilds.fetch(process.env.GUILD_ID);
    const tickets = await dbAll(
      "SELECT * FROM tickets WHERE status = 'open'"
    );

    if (!tickets.length) {
      console.log("ℹ️ No open tickets to check.");
      return;
    }

    for (const ticket of tickets) {
      try {
        const channel = guild.channels.cache.get(ticket.channel_id);
        if (!channel) {
          console.warn(
            `⚠️ Ticket channel ${ticket.channel_id} missing — force closing`
          );
          await dbRun("UPDATE tickets SET status = 'closed' WHERE id = ?", [
            ticket.id,
          ]);
          continue;
        }

        const now = Date.now();
        const lastActivity = ticket.last_activity
          ? new Date(ticket.last_activity).getTime()
          : 0;
        const idleMs = now - lastActivity;
        const snoozeUntil = ticket.snooze_until
          ? new Date(ticket.snooze_until).getTime()
          : 0;
        let stage = ticket.reminder_stage || "none";

        // Active snooze — leave the ticket alone.
        if (snoozeUntil && now < snoozeUntil) continue;

        // Snooze expired — reset and re-evaluate as a fresh cycle this tick.
        if (snoozeUntil && now >= snoozeUntil) {
          await dbRun(
            "UPDATE tickets SET snooze_until = NULL, reminder_stage = 'none', last_reminder_sent = NULL WHERE id = ?",
            [ticket.id]
          );
          stage = "none";
        }

        if (stage === "none") {
          if (idleMs >= IDLE_THRESHOLD) {
            await channel.send({
              content: `<@${ticket.user_id}> Are you still needing help?`,
              components: [
                new ActionRowBuilder().addComponents(
                  new ButtonBuilder()
                    .setCustomId(`snooze_ticket_${ticket.id}`)
                    .setLabel("I still need help")
                    .setStyle(ButtonStyle.Primary),
                  new ButtonBuilder()
                    .setCustomId(`user_close_ticket_${ticket.id}`)
                    .setLabel("I don't need help anymore (Close Ticket)")
                    .setStyle(ButtonStyle.Danger)
                ),
              ],
            });
            await dbRun(
              "UPDATE tickets SET reminder_stage = 'reminded', last_reminder_sent = ? WHERE id = ?",
              [new Date().toISOString(), ticket.id]
            );
            console.log(`🔔 Sent idle reminder for ticket ${ticket.id}`);
          }
          continue;
        }

        if (stage === "reminded") {
          const lastReminder = ticket.last_reminder_sent
            ? new Date(ticket.last_reminder_sent).getTime()
            : 0;
          if (
            lastReminder &&
            now - lastReminder >= POST_REMINDER_GRACE &&
            idleMs >= IDLE_THRESHOLD
          ) {
            await channel.send({
              content:
                `⏳ This ticket has been inactive beyond 30 minutes following a reminder. ` +
                `Any helper may now close this ticket if appropriate.`,
            });
            await dbRun(
              "UPDATE tickets SET reminder_stage = 'final' WHERE id = ?",
              [ticket.id]
            );
            console.log(`📣 Sent inactivity notice for ticket ${ticket.id}`);
          }
          continue;
        }

        // stage === 'final' — notice already posted once; leave open.
      } catch (ticketErr) {
        console.error(`❌ Error processing ticket ${ticket.id}:`, ticketErr);
      }
    }
  } catch (guildErr) {
    console.error("❌ Failed to run idle ticket check:", guildErr);
  } finally {
    idleCheckRunning = false;
  }
}

// Run the check every 2 minutes so the 30-minute thresholds are honored
// promptly (within ~2 min instead of ~5).
client.once("ready", async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);

  // Call it once immediately on startup
  checkIdleTickets(client);

  // Then run it every 2 minutes
  idleInterval = setInterval(() => checkIdleTickets(client), 2 * 60 * 1000);
});

// ✅ Fetch All Messages from a Channel
async function fetchAllMessages(channel) {
  try {
    let messages = [];
    let lastMessageId = null;

    while (true) {
      try {
        // ✅ Fetch messages in batches of 100 (Discord limit)
        const fetchedMessages = await channel.messages.fetch({
          limit: 100,
          ...(lastMessageId && { before: lastMessageId }),
        });

        if (fetchedMessages.size === 0) break; // ✅ Stop if no more messages
        messages.push(...fetchedMessages.values());
        lastMessageId = fetchedMessages.last()?.id; // ✅ Prevents possible errors if last() is null
      } catch (fetchError) {
        console.error("❌ Error fetching messages from channel:", fetchError);
        break; // Stop fetching on error to avoid infinite loops
      }
    }

    return messages.reverse(); // ✅ Ensure chronological order
  } catch (error) {
    console.error("❌ Critical error in fetchAllMessages function:", error);
    return []; // ✅ Return empty array to prevent breaking other logic
  }
}

// ✅ Ensure User is Authenticated (Middleware)
function ensureAuthenticated(req, res, next) {
  try {
    console.log("🔍 Checking Authentication:", req.isAuthenticated());

    if (req.isAuthenticated()) {
      return next();
    }

    // Prevent storing `/auth/discord` itself as returnTo to avoid infinite loop
    if (req.originalUrl !== "/auth/discord") {
      res.cookie("returnTo", req.originalUrl, { httpOnly: true });
      console.log("✅ Storing returnTo in cookie:", req.originalUrl);
    }

    res.redirect("/auth/discord");
  } catch (error) {
    console.error("❌ Error in authentication middleware:", error);
    res.status(500).send("Internal Server Error: Authentication failed.");
  }
}

// ✅ Function to Refresh Expired Tokens (with error handling)
async function refreshDiscordTokenIfNeeded(user) {
  try {
    if (!user.expiresAt || Date.now() < user.expiresAt) {
      return null; // Token is still valid
    }

    console.log("🔄 Refreshing Discord OAuth token...");

    const params = new URLSearchParams();
    params.append("client_id", process.env.DISCORD_CLIENT_ID);
    params.append("client_secret", process.env.DISCORD_CLIENT_SECRET);
    params.append("grant_type", "refresh_token");
    params.append("refresh_token", user.refreshToken);

    const response = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("❌ Failed to refresh token:", errorText);
      return null;
    }

    const tokenData = await response.json();

    // ✅ Update session with new token
    user.accessToken = tokenData.access_token;
    user.refreshToken = tokenData.refresh_token;
    user.expiresAt = Date.now() + tokenData.expires_in * 1000;

    console.log("✅ Token successfully refreshed!");
    return user.accessToken;
  } catch (error) {
    console.error("❌ Error in refreshDiscordTokenIfNeeded:", error);
    return null;
  }
}

// Middleware: Fetch and Validate User Roles
async function checkModeratorRole(req, res, next) {
  try {
    const user = req.user;

    if (!user || !user.accessToken) {
      console.warn(
        "⚠️ User session missing or expired, redirecting to login..."
      );
      req.logout(() => {}); // Ensure logout before redirect
      return res.redirect("/auth/discord");
    }

    // ✅ Attempt to refresh token if expired
    const newAccessToken = await refreshDiscordTokenIfNeeded(user);
    if (newAccessToken) {
      user.accessToken = newAccessToken;
    }

    // ✅ Fetch user's guild membership
    const guildResponse = await fetch(
      `https://discord.com/api/v10/users/@me/guilds/${process.env.GUILD_ID}/member`,
      {
        headers: { Authorization: `Bearer ${user.accessToken}` },
      }
    );

    if (!guildResponse.ok) {
      console.warn(
        "⚠️ Failed to verify Discord membership. Skipping moderator check."
      );
      return next(); // Instead of redirecting, continue without moderator privileges
    }

    const guildMember = await guildResponse.json();
    const userRoles = guildMember.roles || [];
    const allowedRoles = [
      process.env.TICKET_MODERATOR_ROLE,
      process.env.ELDEN_MODERATOR,
      process.env.ELDEN_ENFORCER,
    ];

    if (!userRoles.some((role) => allowedRoles.includes(role))) {
      console.warn("⚠️ User does not have an allowed role. Access denied.");
      return res.status(403).send("Forbidden: You do not have access.");
    }

    next();
  } catch (error) {
    console.error("❌ Error checking moderator role:", error);
    return next(); // Prevent redirect loop
  }
}

// ✅ Wait for Bot to Be Ready
async function waitForBotReady() {
  try {
    if (client.isReady()) return true; // ✅ If already ready, return immediately

    console.log("⏳ Waiting for bot to be ready...");
    await readyPromise; // ✅ Waits for `client.js` to confirm bot readiness
    console.log("✅ Bot is now ready!");
    return true;
  } catch (error) {
    console.error("❌ Error waiting for bot to be ready:", error);
    return false; // Return false in case of failure
  }
}

// ✅ Log errors
client.on("error", (error) => logToFile(`❌ Bot error: ${error}`));
