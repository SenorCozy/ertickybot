const { SlashCommandBuilder } = require("discord.js");
const { db } = require("../database");
require("dotenv").config();

module.exports = {
  data: new SlashCommandBuilder()
    .setName("setaitokens")
    .setDescription("Set the token limit for AI Chat or Ticket AI responses")
    .addStringOption((option) =>
      option
        .setName("context")
        .setDescription("Choose the context to set the token limit for")
        .setRequired(true)
        .addChoices(
          { name: "AI Chat", value: "chat" },
          { name: "Ticket", value: "ticket" }
        )
    )
    .addIntegerOption((option) =>
      option
        .setName("tokens")
        .setDescription("Token limit (set to 0 to ignore limit)")
        .setRequired(true)
        .setMinValue(0)
        .setMaxValue(150000)
    )
    .addBooleanOption((option) =>
      option
        .setName("ignorelimit")
        .setDescription("Ignore token limit globally")
        .setRequired(false)
    ),

  async execute(interaction) {
    const guildMember = await interaction.guild.members.fetch(
      interaction.user.id
    );

    const allowedRoles = [
      process.env.ELDER_TICKET_MODERATOR_ROLE,
      process.env.ELDEN_MODERATOR,
      process.env.ELDEN_ENFORCER,
    ];

    const hasRequiredRole = guildMember.roles.cache.some((role) =>
      allowedRoles.includes(role.id)
    );

    if (!hasRequiredRole) {
      return interaction.reply({
        content: "❌ You do not have permission to use this command.",
        flags: 64,
      });
    }

    const context = interaction.options.getString("context");
    const tokenLimit = interaction.options.getInteger("tokens");
    const ignoreLimit = interaction.options.getBoolean("ignorelimit") || false;

    const tokenColumn =
      context === "chat" ? "ai_chat_max_tokens" : "ticket_ai_max_tokens";

    console.log(`🟢 Setting ${context} token limit to:`, tokenLimit);
    console.log("🟢 Ignore limit (global):", ignoreLimit);

    db.run(
      `
      INSERT INTO ai_settings (guild_id, ${tokenColumn}, ignore_token_limit)
      VALUES (?, ?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET 
        ${tokenColumn} = excluded.${tokenColumn}, 
        ignore_token_limit = excluded.ignore_token_limit
      `,
      [interaction.guild.id, tokenLimit, ignoreLimit],
      (err) => {
        if (err) {
          console.error("❌ Error updating AI token settings:", err);
          return interaction.reply({
            content: "❌ An error occurred while updating AI token settings.",
            flags: 64,
          });
        }

        const contextLabel = context === "chat" ? "AI Chat" : "Ticket AI";

        if (ignoreLimit) {
          interaction.reply({
            content: `✅ Token limit is now **ignored** globally. (${contextLabel} max still set to ${tokenLimit})`,
            flags: 64,
          });
        } else {
          interaction.reply({
            content: `✅ ${contextLabel} token limit has been updated to **${tokenLimit}**.`,
            flags: 64,
          });
        }
      }
    );
  },
};
