const axios = require("axios");
const { Events } = require("discord.js");
const { db } = require("../database");
const { getModelCandidates } = require("../aiModels");

const cooldowns = new Map();
const apiRateLimiter = new Map(); // Track API call timestamps

// Function to format responses
function formatResponse(content) {
  // Use Markdown for structured responses
  const formattedContent = content
    .replace(/### (.*)/g, "**$1**") // Bold headings
    .replace(/- (.*)/g, "• $1"); // Bullet points

  return formattedContent;
}

// Function to check if a message is relevant
function isRelevant(content) {
  // Implement logic to determine relevance
  return !content.includes("irrelevant keyword");
}

module.exports = {
  name: Events.MessageCreate,
  async execute(message) {
    const client = message.client;

    try {
      if (message.author.bot) return;

      console.log("🟢 Message received from:", message.author.username);

      // Only proceed if it's a reply to the bot or a mention
      const isReplyToBot =
        message.reference &&
        (await message.channel.messages
          .fetch(message.reference.messageId)
          .then((msg) => msg.author.id === client.user.id)
          .catch(() => false));

      const isMentioningBot = message.mentions.has(message.client.user.id);

      if (!isReplyToBot && !isMentioningBot) {
        console.log("🔴 Not a bot reply or mention.");
        return;
      }

      // ✅ Already validated it's a relevant AI message, now check DB and channel
      db.get(
        `SELECT ticket_ai_enabled, ai_chat_enabled FROM ai_settings WHERE guild_id = ?`,
        [message.guild.id],
        async (err, settings) => {
          if (err) {
            console.error("❌ DB error checking AI settings:", err);
            return;
          }

          if (!settings) {
            console.log("⚠️ No AI settings found for this guild.");
            return;
          }

          if (!settings.ticket_ai_enabled && !settings.ai_chat_enabled) {
            console.log("🔴 Both AI Chat and Ticket AI are disabled.");
            return;
          }

          const isAllowedAIChannel =
            message.channel.id === process.env.AI_CHAT_CHANNEL_ID;

          db.get(
            "SELECT * FROM tickets WHERE channel_id = ? AND status = 'open'",
            [message.channel.id],
            async (err, ticket) => {
              if (err) {
                console.error(
                  "❌ DB error checking ticket for AI response:",
                  err
                );
                return;
              }

              const isValidTicket = Boolean(ticket);
              if (!isAllowedAIChannel && !isValidTicket) {
                console.log(
                  "🔴 Message is not in a valid ticket or AI channel."
                );
                return;
              }

              console.log("🟢 Valid AI interaction channel detected.");

              // **Cooldown: 10 seconds per user**
              const cooldownKey = `${message.author.id}`;
              const lastUsed = cooldowns.get(cooldownKey);
              const now = Date.now();

              if (lastUsed && now - lastUsed < 10_000) {
                console.log(`⏳ Cooldown active for ${cooldownKey}`);
                await message.reply(
                  "⏳ Please wait a moment before asking another question."
                );
                return;
              }
              cooldowns.set(cooldownKey, now);

              // **API Rate Limiting: 5 seconds between API calls**
              const lastApiCall = apiRateLimiter.get("global");
              if (lastApiCall && now - lastApiCall < 2000) {
                await message.reply(
                  "⚠️ The AI is processing too many requests. Please wait a moment."
                );
                return;
              }
              apiRateLimiter.set("global", now);

              // Send an immediate "thinking" message
              const thinkingMessage = await message.reply({
                content: "💭 Thinking...",
              });

              // Fetch AI settings for both chat and ticket AI modes
              db.get(
                `SELECT 
                  ticket_ai_enabled, ticket_ai_mode, ticket_ai_max_tokens,
                  ai_chat_enabled, ai_chat_mode, ai_chat_max_tokens,
                  ignore_token_limit
                FROM ai_settings WHERE guild_id = ?`,
                [message.guild.id],
                async (settingsErr, settings) => {
                  if (settingsErr) {
                    console.error("❌ DB error:", settingsErr);
                    return await thinkingMessage.edit(
                      "⚠️ Error loading AI settings."
                    );
                  }

                  const isChat = isAllowedAIChannel && !isValidTicket;
                  const isTicket = isValidTicket;

                  if (isChat && !settings.ai_chat_enabled) {
                    console.log("🔴 AI chat disabled.");
                    await thinkingMessage.edit(
                      "⚠️ AI chat is currently disabled."
                    );
                    return;
                  }
                  if (isTicket && !settings.ticket_ai_enabled) {
                    console.log("🔴 Ticket AI disabled.");
                    await thinkingMessage.edit(
                      "⚠️ Ticket AI is currently disabled."
                    );
                    return;
                  }

                  const aiMode = isChat
                    ? settings.ai_chat_mode || "casual"
                    : settings.ticket_ai_mode || "casual";

                  const maxTokens = settings.ignore_token_limit
                    ? null
                    : isChat
                    ? settings.ai_chat_max_tokens || 50000
                    : settings.ticket_ai_max_tokens || 50000;

                  console.log(
                    `🧠 Context: ${
                      isChat ? "AI Chat" : "Ticket"
                    } | Mode: ${aiMode} | Tokens: ${maxTokens}`
                  );

                  const aiPrompts = {
                    professional:
                      "You are a helpful and professional assistant in a Discord server dedicated to Elden Ring. Please try to prioritize up to date information consistent with the latest game patch. Your primary role is to provide concise and clear advice for defeating bosses, navigating areas, and solving challenges in the game. Do not provide explanations, rationales, or meta-commentary about your response. Just provide the answer or advice directly. If the question is unrelated to Elden Ring, respond appropriately.",
                    casual:
                      "You're a friendly and casual bot in a Discord server for Elden Ring players. Please try to prioritize up to date information consistent with the latest game patch. Your main job is to help users with boss strategies, area navigation, and game tips. Keep your responses engaging and fun! Do not provide explanations, rationales, or meta-commentary about your response. Just provide the answer or advice directly. If the question is unrelated to Elden Ring, keep it light and fun but still answer the questions!",
                    meme: "You're a meme-loving jokester in an Elden Ring Discord server. Please try to prioritize up to date information consistent with the latest game patch. Your goal is to help users with boss fights, area tips, and game challenges, but make it funny and relevant! Do not provide explanations, rationales, or meta-commentary about your response. Just provide the answer or advice directly, but feel free to sprinkle in some humor. If the question is unrelated to Elden Ring, respond appropriately but with a meme or joke!",
                    strict:
                      "You are a strict, no-nonsense assistant in an Elden Ring Discord server. Please try to prioritize up to date information consistent with the latest game patch. Your focus is on providing precise, to-the-point advice for defeating bosses, navigating areas, and overcoming challenges in the game. Do not provide explanations, rationales, or meta-commentary about your response. Just provide the answer or advice directly. If the question is unrelated to Elden Ring, respond politely and move on.",
                    unrestricted: "",
                  };

                  const personality =
                    aiPrompts[aiMode] || aiPrompts.professional;

                  let prompt = message.content.replace(/<@!?(\d+)>/, "").trim();
                  if (isReplyToBot) {
                    const repliedTo = await message.channel.messages.fetch(
                      message.reference.messageId
                    );
                    prompt = `Replying to: "${repliedTo.content}"\n\nUser: ${prompt}`;
                  }

                  if (!prompt) {
                    console.log("🔴 No prompt found.");
                    return;
                  }

                  console.log("🟢 Prompt:", prompt);

                  //ai health tracking variables
                  const promptLength = prompt.length;
                  const estimatedTokens = Math.round(promptLength / 4);
                  const startTime = Date.now();
                  // 🧠 Dual-memory fetch block: per-user vs per-thread
                  const ticketId =
                    ticket?.id || `ai_channel_${message.channel.id}`;
                  const userId = message.author.id;

                  // Keyword-based toggle for user memory (fallbacks to ticket memory)
                  const isUserScope = prompt
                    .toLowerCase()
                    .includes("you and i");

                  const historyQuery = isUserScope
                    ? "SELECT role, content FROM conversation_history WHERE user_id = ? ORDER BY timestamp DESC LIMIT 20"
                    : "SELECT role, content FROM conversation_history WHERE ticket_id = ? ORDER BY timestamp DESC LIMIT 20";

                  const historyParam = isUserScope ? userId : ticketId;
                  const historyContextLabel = isUserScope
                    ? "Here's what you and this user have previously discussed:"
                    : "Here's recent discussion in this thread:";

                  const history = await new Promise((resolve, reject) => {
                    db.all(historyQuery, [historyParam], (err, rows) => {
                      if (err) reject(err);
                      else {
                        const validRoles = new Set(["user", "assistant"]);
                        const relevantHistory = rows
                          .filter((row) => row.content?.trim().length > 0)
                          .filter((row) => isRelevant(row.content))
                          .filter((row) => validRoles.has(row.role));
                        resolve(relevantHistory.reverse());
                      }
                    });
                  });

                  // Token-aware trimming (estimates 4 chars = 1 token)
                  let totalTokens = Math.round(prompt.length / 4);
                  const maxTokensAllowed = 160000 - 5000;
                  const trimmedHistory = [];

                  for (const msg of history.reverse()) {
                    const estimated = Math.round(msg.content.length / 4);
                    if (totalTokens + estimated > maxTokensAllowed) break;
                    trimmedHistory.unshift(msg);
                    totalTokens += estimated;
                  }

                  // ✅ Debug
                  console.log(
                    "🧠 Memory Scope:",
                    isUserScope ? "Per-User" : "Per-Ticket"
                  );
                  console.log("📜 History Context:\n", trimmedHistory);

                  // 👇 Build final message payload for the model
                  const finalMessages = [
                    { role: "system", content: personality },
                    { role: "system", content: historyContextLabel },
                    ...trimmedHistory,
                    { role: "user", content: prompt },
                  ];

                  // Try each candidate model in order until one answers.
                  // candidates[0] is openrouter/free (OpenRouter's own router);
                  // the rest are live free models pulled from /api/v1/models.
                  const candidates = getModelCandidates();
                  let answered = false;

                  for (let i = 0; i < candidates.length; i++) {
                    const modelId = candidates[i];
                    const attemptStart = Date.now();
                    try {
                      if (i > 0)
                        console.log(`🔄 Trying fallback model: ${modelId}`);

                      const response = await axios.post(
                        "https://openrouter.ai/api/v1/chat/completions",
                        {
                          model: modelId,
                          messages: finalMessages,
                          max_tokens: maxTokens,
                        },
                        {
                          headers: {
                            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
                            "HTTP-Referer": "http://localhost",
                            "X-Title": "TicketBot",
                          },
                          timeout: 10000, // 10-second timeout
                        }
                      );

                      const reply =
                        response.data &&
                        response.data.choices &&
                        response.data.choices[0] &&
                        response.data.choices[0].message
                          ? response.data.choices[0].message.content
                          : null;
                      const responseTime = Date.now() - attemptStart;

                      if (!reply || reply.trim().length === 0) {
                        console.error(
                          `❌ Empty response from ${modelId} — trying next.`
                        );
                        continue;
                      }

                      const formattedReply = formatResponse(reply);
                      const truncatedReply =
                        formattedReply.length > 2000
                          ? formattedReply.slice(0, 1997) + "..."
                          : formattedReply;

                      db.run(
                        "INSERT INTO conversation_history (ticket_id, role, content, user_id) VALUES (?, ?, ?, ?)",
                        [ticketId, "assistant", truncatedReply, userId],
                        (err) => {
                          if (err)
                            console.error(
                              "❌ Failed to save AI reply to history:",
                              err.message
                            );
                        }
                      );
                      db.run(
                        `INSERT INTO ai_logs (
                          user_id, guild_id, ticket_id, prompt_length, model_used,
                          fallback_used, tokens_estimated, response_time_ms, success, error_message
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                        [
                          message.author.id,
                          message.guild.id,
                          ticketId,
                          promptLength,
                          modelId,
                          i > 0 ? 1 : 0,
                          estimatedTokens,
                          responseTime,
                          1,
                          null,
                        ],
                        (err) => {
                          if (err)
                            console.error(
                              "❌ Failed to insert AI log:",
                              err.message
                            );
                        }
                      );

                      answered = true;
                      await thinkingMessage.edit({ content: truncatedReply });
                      break;
                    } catch (apiError) {
                      console.error(
                        `❌ OpenRouter error on ${modelId}:`,
                        apiError.message || apiError
                      );
                      if (apiError.response) {
                        console.error(
                          "❌ API status/data:",
                          apiError.response.status,
                          apiError.response.data
                        );
                      }
                      // fall through to the next candidate
                    }
                  }

                  if (!answered) {
                    await thinkingMessage.edit(
                      "⚠️ AI is struggling to reply right now."
                    );

                    const totalTime = Date.now() - startTime;
                    db.run(
                      `INSERT INTO ai_logs (
                        user_id, guild_id, ticket_id, prompt_length, model_used,
                        fallback_used, tokens_estimated, response_time_ms, success, error_message
                      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                      [
                        message.author.id,
                        message.guild.id,
                        ticketId,
                        promptLength,
                        candidates.join(","),
                        1,
                        estimatedTokens,
                        totalTime,
                        0,
                        "All candidate models failed",
                      ],
                      (err) => {
                        if (err)
                          console.error(
                            "❌ Failed to insert fallback AI log:",
                            err.message
                          );
                      }
                    );
                  }
                }
              );
            }
          );
        }
      );
    } catch (err) {
      console.error("❌ Error in AI chat handler:", err);
    }
  },
  cooldowns,
};
