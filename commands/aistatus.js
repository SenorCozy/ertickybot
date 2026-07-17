const { SlashCommandBuilder } = require("discord.js");
const { db } = require("../database");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("aistatus")
    .setDescription("Check the current AI settings for both ticket and chat."),

  async execute(interaction) {
    db.get(
      `SELECT 
        ai_chat_enabled, ai_chat_mode, ai_chat_max_tokens,
        ticket_ai_enabled, ticket_ai_mode, ticket_ai_max_tokens,
        ignore_token_limit
      FROM ai_settings WHERE guild_id = ?`,
      [interaction.guild.id],
      (err, settings) => {
        if (err) {
          console.error("❌ Error fetching AI settings:", err);
          return interaction.reply({
            content: "❌ An error occurred while fetching AI settings.",
            flags: 64,
          });
        }

        if (!settings) {
          return interaction.reply({
            content: "⚠️ No AI settings found for this guild.",
            flags: 64,
          });
        }

        const ticketStatus = settings.ticket_ai_enabled
          ? "✅ Enabled"
          : "❌ Disabled";
        const chatStatus = settings.ai_chat_enabled
          ? "✅ Enabled"
          : "❌ Disabled";

        const ticketMode = settings.ticket_ai_mode || "professional";
        const chatMode = settings.ai_chat_mode || "professional";

        const ticketTokens = settings.ticket_ai_max_tokens || 50000;
        const chatTokens = settings.ai_chat_max_tokens || 50000;

        const ignoreLimit = settings.ignore_token_limit;

        const response = `
🎟️ **Ticket AI**
• Status: ${ticketStatus}
• Mode: **${ticketMode}**
• Max Tokens: **${ticketTokens}**

💬 **AI Chat**
• Status: ${chatStatus}
• Mode: **${chatMode}**
• Max Tokens: **${chatTokens}**

🔧 **Global Settings**
• Ignore Token Limit: **${ignoreLimit ? "Yes" : "No"}**
        `.trim();

        interaction.reply({
          content: response,
          flags: 64,
        });
      }
    );
  },
};
