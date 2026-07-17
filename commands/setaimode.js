const { SlashCommandBuilder } = require("discord.js");
const { db } = require("../database");
require("dotenv").config();

module.exports = {
  data: new SlashCommandBuilder()
    .setName("setaimode")
    .setDescription("Change the AI personality mode for tickets or chat.")
    .addStringOption((option) =>
      option
        .setName("context")
        .setDescription("Select where to apply the AI mode")
        .setRequired(true)
        .addChoices(
          { name: "Ticket", value: "ticket" },
          { name: "AI Chat", value: "chat" }
        )
    )
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("Select the AI mode")
        .setRequired(true)
        .addChoices(
          { name: "Professional", value: "professional" },
          { name: "Casual", value: "casual" },
          { name: "Meme", value: "meme" },
          { name: "Strict", value: "strict" },
          { name: "Unrestricted", value: "unrestricted" }
        )
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

    const selectedMode = interaction.options.getString("mode");
    const context = interaction.options.getString("context");
    const column = context === "chat" ? "ai_chat_mode" : "ticket_ai_mode";
    const formattedMode =
      selectedMode.charAt(0).toUpperCase() + selectedMode.slice(1);

    db.run(
      `INSERT INTO ai_settings (guild_id, ${column}) VALUES (?, ?)
       ON CONFLICT(guild_id) DO UPDATE SET ${column} = excluded.${column}`,
      [interaction.guild.id, selectedMode],
      (err) => {
        if (err) {
          console.error("❌ Error updating AI mode:", err);
          return interaction.reply({
            content: "❌ An error occurred while updating AI settings.",
            flags: 64,
          });
        }

        interaction.reply({
          content: `✅ ${
            context === "chat" ? "AI Chat" : "Ticket AI"
          } personality mode has been set to **${formattedMode}**.`,
          flags: 64,
        });
      }
    );
  },
};
