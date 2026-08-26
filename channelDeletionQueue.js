// Shared rate-limit gate for Discord channel deletions, used by every
// ticket-close path (button/modal close, web dashboard force-close, and the
// /delete command). Exists to keep this bot's own channel-deletion rate under
// whatever threshold this server's anti-nuke bot (Wick) is watching for.
//
// Wick's anti-nuke uses a per-minute AND a per-hour limit, both configured by
// server admins through Wick's own dashboard — Wick does not publish default
// numbers (confirmed via docs.wickbot.com). The two values below are OUR OWN
// safety margin, NOT Wick's actual configured limits. They're a conservative
// placeholder until the admins share Wick's real numbers for this server —
// tune TICKET_DELETE_MIN_GAP_MS / TICKET_DELETE_MAX_PER_HOUR in .env then.
//
// All three call sites funnel through the single queue below, because Wick
// almost certainly tracks deletions by the bot's own Discord account, not by
// which internal feature triggered them. State is in-memory and resets on a
// bot restart — acceptable, since a restart only ever makes the gate MORE
// permissive for a short window afterward, never less safe.

const MIN_GAP_MS = Number(process.env.TICKET_DELETE_MIN_GAP_MS) || 20000; // 20s between deletions
const MAX_PER_HOUR = Number(process.env.TICKET_DELETE_MAX_PER_HOUR) || 30;
const HOUR_MS = 60 * 60 * 1000;

let lastDeletionAt = 0;
let hourWindowStart = Date.now();
let deletionsThisHour = 0;
let queueTail = Promise.resolve();

function resetHourWindowIfNeeded() {
  const now = Date.now();
  if (now - hourWindowStart >= HOUR_MS) {
    hourWindowStart = now;
    deletionsThisHour = 0;
  }
}

// ms to wait before it's safe to delete another channel. 0 = safe right now.
function msUntilSafeToDelete() {
  resetHourWindowIfNeeded();
  const gapRemaining = Math.max(0, MIN_GAP_MS - (Date.now() - lastDeletionAt));
  if (deletionsThisHour >= MAX_PER_HOUR) {
    const hourRemaining = HOUR_MS - (Date.now() - hourWindowStart);
    return Math.max(gapRemaining, hourRemaining);
  }
  return gapRemaining;
}

// Call this exactly once, right when a deletion actually executes — updates
// both the "last deleted" timer and the rolling hourly count together.
function recordDeletion() {
  resetHourWindowIfNeeded();
  lastDeletionAt = Date.now();
  deletionsThisHour += 1;
}

// Human-readable ETA for a "this will close automatically in ~X" notice.
function formatEta(ms) {
  const minutes = Math.ceil(ms / 60000);
  return minutes <= 1 ? "less than a minute" : `about ${minutes} minutes`;
}

// Queues performDeleteFn (a () => Promise) to run once it's safe, staggering
// it behind anything already queued so concurrent close requests drain one at
// a time in arrival order. If a wait is required, onDelayFn(waitMs) fires
// first (may be async — it is NOT awaited, so a slow message-send never
// delays the countdown itself). Returns a Promise resolving with
// performDeleteFn's own result once the deletion actually runs. One queued
// failure is logged but never blocks anything queued after it.
function scheduleDeletion(performDeleteFn, onDelayFn) {
  const runner = queueTail.then(async () => {
    const wait = msUntilSafeToDelete();
    if (wait > 0) {
      console.log(
        `⏳ Staggering channel deletion by ${formatEta(
          wait
        )} to stay clear of anti-nuke detection.`
      );
      if (onDelayFn) {
        Promise.resolve()
          .then(() => onDelayFn(wait))
          .catch((e) => console.error("❌ Delay notice failed:", e));
      }
      await new Promise((r) => setTimeout(r, wait));
    }
    recordDeletion();
    return performDeleteFn();
  });
  queueTail = runner.catch((e) => {
    console.error("❌ Queued channel deletion failed:", e);
  });
  return runner;
}

module.exports = { scheduleDeletion, formatEta };
