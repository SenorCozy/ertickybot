const { SlashCommandBuilder, PermissionsBitField } = require("discord.js");

require("dotenv").config();

module.exports = {
  data: new SlashCommandBuilder()
    .setName("delete")
    .setDescription(
      "Deletes a ticket channel if it starts with 'ticket-' (Ticket Moderators only)"
    )
    .addChannelOption((option) =>
      option
        .setName("channel")
        .setDescription("Select the ticket channel to delete")
        .setRequired(true)
    ),

  async execute(interaction) {
    try {
      const guildMember = await interaction.guild.members.fetch(
        interaction.user.id
      );

      const allowedRoles = [
        process.env.ELDER_TICKET_MODERATOR_ROLE,
        process.env.TICKET_MODERATOR_ROLE,
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

      const channel = interaction.options.getChannel("channel");

      if (!channel || !channel.name.startsWith("ticket-")) {
        return interaction.reply({
          content: "❌ The selected channel is not a valid ticket channel.",
          flags: 64,
        });
      }

      // Category guard — other categories in this server use the same
      // `ticket-*` naming pattern (e.g. moderator-ticket channels). The name
      // prefix alone is NOT enough; only act on channels inside the configured
      // bot-tickets category.
      const expectedCategoryId = process.env.TICKET_CATEGORY_ID;
      if (!expectedCategoryId) {
        console.error(
          "❌ /delete refused: TICKET_CATEGORY_ID is not configured."
        );
        return interaction.reply({
          content:
            "❌ Server config missing TICKET_CATEGORY_ID — refusing to delete.",
          flags: 64,
        });
      }
      if (channel.parentId !== expectedCategoryId) {
        console.error(
          `❌ /delete refused: channel=${channel.id} name=${channel.name} parent=${channel.parentId} is NOT in ticket category ${expectedCategoryId}.`
        );
        return interaction.reply({
          content:
            "❌ That channel is ticket-named but isn't in this bot's ticket category — refusing (likely a moderator/other ticket channel).",
          flags: 64,
        });
      }

      try {
        await channel.delete();
      } catch (deleteErr) {
        console.error("❌ Error deleting ticket channel:", deleteErr);
        return interaction.reply({
          content: "❌ Failed to delete the ticket channel.",
          flags: 64,
        });
      }
    } catch (err) {
      console.error("❌ Unexpected error in /delete command:", err);
      if (!interaction.replied && !interaction.deferred) {
        return interaction.reply({
          content:
            "❌ An unexpected error occurred while processing your request.",
          flags: 64,
        });
      }
    }
  },
};
