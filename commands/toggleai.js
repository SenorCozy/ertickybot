const { SlashCommandBuilder } = require("discord.js");
const { db } = require("../database");
require("dotenv").config(); // Load .env for role ID

module.exports = {
  data: new SlashCommandBuilder()
    .setName("toggleai")
    .setDescription("Enable or disable AI responses for tickets or AI chat")
    .addStringOption((option) =>
      option
        .setName("context")
        .setDescription("Which AI context to toggle")
        .setRequired(true)
        .addChoices(
          { name: "ticket", value: "ticket" },
          { name: "chat", value: "chat" }
        )
    )
    .addBooleanOption((option) =>
      option
        .setName("enabled")
        .setDescription("Enable or disable the selected AI context")
        .setRequired(true)
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

    const context = interaction.options.getString("context"); // "ticket" or "chat"
    const enabled = interaction.options.getBoolean("enabled");

    const column = context === "chat" ? "ai_chat_enabled" : "ticket_ai_enabled";

    // Insert or update the correct field
    db.run(
      `
      INSERT INTO ai_settings (guild_id, ${column})
      VALUES (?, ?)
      ON CONFLICT(guild_id) DO UPDATE SET ${column} = excluded.${column}
      `,
      [interaction.guild.id, enabled],
      (err) => {
        if (err) {
          console.error("❌ Error updating AI settings:", err);
          return interaction.reply({
            content: "❌ An error occurred while updating AI settings.",
            flags: 64,
          });
        }

        interaction.reply({
          content: `✅ ${
            context === "chat" ? "AI Chat" : "Ticket AI"
          } has been **${enabled ? "enabled" : "disabled"}**.`,
          flags: 64,
        });
      }
    );
  },
};
