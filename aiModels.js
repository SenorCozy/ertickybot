// Resolves which OpenRouter models the AI handler should try, in order.
//
// Primary is `openrouter/free` — OpenRouter's own router that auto-selects a
// currently-available free model per request, so a single model being
// deprecated never breaks the bot. The dynamic fallbacks are pulled live from
// the documented /api/v1/models catalog (no hardcoded model IDs that can go
// stale), filtered to genuinely-free models and biased toward historically
// reliable families (popularity isn't exposed by the API). The list is cached
// and refreshed periodically; if the fetch fails we still return the primary.

const axios = require("axios");

const MODELS_API = "https://openrouter.ai/api/v1/models";
const PRIMARY_MODEL = process.env.OPENROUTER_PRIMARY_MODEL || "openrouter/free";
const FALLBACK_COUNT = Number(process.env.OPENROUTER_FALLBACK_COUNT) || 3;
const REFRESH_MS = 6 * 60 * 60 * 1000; // 6 hours

// Popularity/usage isn't exposed by the API, so bias the fallback toward
// families that have historically had durable free presence, then newest.
const FAMILY_PREFERENCE = [
  "deepseek",
  "llama",
  "qwen",
  "gpt-oss",
  "gemma",
  "mistral",
];
// Avoid preview/experimental tags for the fallback — those churn fastest
// (it's what kept breaking the old hardcoded setup).
const EXCLUDE = /preview|exp|alpha|beta|nightly/i;

let cachedFallbacks = [];

function familyRank(id) {
  const i = FAMILY_PREFERENCE.findIndex((f) => id.includes(f));
  return i === -1 ? FAMILY_PREFERENCE.length : i;
}

async function refreshModelCache() {
  try {
    const res = await axios.get(MODELS_API, { timeout: 10000 });
    const models = res.data && res.data.data ? res.data.data : [];

    const free = models.filter(
      (m) =>
        m &&
        typeof m.id === "string" &&
        m.pricing &&
        m.pricing.prompt === "0" &&
        m.pricing.completion === "0" &&
        !EXCLUDE.test(m.id) &&
        !m.id.startsWith("openrouter/") // skip routers/aliases for the fallback
    );

    free.sort((a, b) => {
      const fr = familyRank(a.id) - familyRank(b.id);
      if (fr !== 0) return fr;
      return (b.created || 0) - (a.created || 0);
    });

    const picked = free.slice(0, FALLBACK_COUNT).map((m) => m.id);

    if (picked.length) {
      cachedFallbacks = picked;
      console.log("✅ AI fallback models refreshed:", picked.join(", "));
    } else {
      console.warn(
        "⚠️ No free models matched the filter — keeping previous fallback list."
      );
    }
  } catch (err) {
    console.error(
      "❌ Failed to refresh OpenRouter model list:",
      err.message || err
    );
    // Keep whatever we had; the primary (openrouter/free) still works.
  }
}

// Ordered list the AI handler tries top-to-bottom until one answers.
function getModelCandidates() {
  return [PRIMARY_MODEL, ...cachedFallbacks];
}

// Warm the cache at startup and refresh on an interval. Non-blocking, and
// unref'd so it never holds the process open during graceful shutdown.
refreshModelCache();
const refreshTimer = setInterval(refreshModelCache, REFRESH_MS);
refreshTimer.unref();

module.exports = { getModelCandidates, refreshModelCache };
