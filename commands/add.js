const { SlashCommandBuilder, PermissionsBitField } = require("discord.js");
const { db } = require("../database");

require("dotenv").config();

module.exports = {
  data: new SlashCommandBuilder()
    .setName("add")
    .setDescription("Add another Active Helper to a claimed ticket")
    .addChannelOption((option) =>
      option
        .setName("ticket")
        .setDescription("The ticket channel where you want to add a helper")
        .setRequired(true)
    )
    .addUserOption((option) =>
      option
        .setName("helper")
        .setDescription("The Active Helper to add")
        .setRequired(true)
    ),

  async execute(interaction) {
    try {
      const ticketChannel = interaction.options.getChannel("ticket");
      const newHelper = interaction.options.getUser("helper");
      const user = interaction.user;
      const guildMember = await interaction.guild.members.fetch(user.id);

      if (!ticketChannel || !newHelper) {
        return interaction.reply({
          content: "Invalid ticket channel or helper selection.",
          flags: 64,
        });
      }

      // ✅ Ensure the user has the "Active Helper" role
      if (!guildMember.roles.cache.has(process.env.ACTIVE_HELPER_ROLE)) {
        return interaction.reply({
          content: "❌ You need the 'Active Helper' role to add helpers.",
          flags: 64,
        });
      }

      // Check if the ticket exists
      db.get(
        "SELECT * FROM tickets WHERE channel_id = ?",
        [ticketChannel.id],
        async (err, ticket) => {
          try {
            if (err) throw new Error(`Database error: ${err.message}`);

            if (!ticket) {
              return interaction.reply({
                content: "This is not a valid ticket channel.",
                flags: 64,
              });
            }

            // Check if the ticket is claimed
            if (!ticket.claimed_by) {
              return interaction.reply({
                content: "This ticket has not been claimed yet.",
                flags: 64,
              });
            }

            // Check if the user adding the helper is the ticket claimer
            if (ticket.claimed_by !== user.id) {
              return interaction.reply({
                content:
                  "❌ Only the Active Helper who claimed this ticket can add another helper.",
                flags: 64,
              });
            }

            // ✅ Ensure the new helper has the "Active Helper" role
            const helperMember = await interaction.guild.members.fetch(
              newHelper.id
            );
            if (!helperMember.roles.cache.has(process.env.ACTIVE_HELPER_ROLE)) {
              return interaction.reply({
                content:
                  "❌ The user you're trying to add must be an 'Active Helper'.",
                flags: 64,
              });
            }
            //Check if they already have access
            const perms = ticketChannel.permissionsFor(newHelper.id);
            if (perms?.has(PermissionsBitField.Flags.ViewChannel)) {
              return interaction.reply({
                content: "⚠️ This user already has access to the ticket.",
                flags: 64,
              });
            }
            try {
              // Add the new helper to the ticket
              await ticketChannel.permissionOverwrites.edit(newHelper.id, {
                ViewChannel: true,
                SendMessages: true,
                ReadMessageHistory: true,
              });

              await interaction.reply({
                content: `✅ <@${newHelper.id}> has been added to this claimed ticket.`,
              });
              await ticketChannel.send(
                `👋 Welcome <@${newHelper.id}>! You’ve been added to this claimed ticket.`
              );
            } catch (permError) {
              console.error("❌ Error updating permissions:", permError);
              return interaction.reply({
                content:
                  "❌ Failed to update ticket permissions. Please check my role settings.",
                flags: 64,
              });
            }
          } catch (queryError) {
            console.error("❌ Database query error:", queryError);
            return interaction.reply({
              content:
                "❌ An error occurred while retrieving ticket information. Please try again later.",
              flags: 64,
            });
          }
        }
      );
    } catch (error) {
      console.error("❌ Unexpected error in /add command:", error);
      return interaction.reply({
        content:
          "❌ An unexpected error occurred while processing your request.",
        flags: 64,
      });
    }
  },
};
