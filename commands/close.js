const {
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  PermissionsBitField,
} = require("discord.js");
const { db } = require("../database");

require("dotenv").config();

module.exports = {
  data: new SlashCommandBuilder()
    .setName("close")
    .setDescription("Close a ticket with a reason"),

  async execute(interaction) {
    try {
      console.log("🟢 Received /close command interaction.");

      const guildMember = await interaction.guild.members.fetch(
        interaction.user.id
      );

      // ✅ Restrict access to users with the "Active Helper" role
      if (!guildMember.roles.cache.has(process.env.ACTIVE_HELPER_ROLE)) {
        return interaction.reply({
          content: "❌ You need the 'Active Helper' role to close tickets.",
          flags: 64,
        });
      }

      // Check if this is a ticket channel
      const ticketChannel = interaction.channel;
      if (!ticketChannel) {
        console.warn("⚠️ Ticket channel not found during closure.");
        return interaction.reply({
          content: "Ticket channel not found.",
          flags: 64,
        });
      }

      // ✅ Create a modal for closure reason input
      const modal = new ModalBuilder()
        .setCustomId(`close_ticket_modal_${ticketChannel.id}`)
        .setTitle("Close Ticket");

      const reasonInput = new TextInputBuilder()
        .setCustomId("closure_reason")
        .setLabel("Enter a reason for closing the ticket")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false);

      const actionRow = new ActionRowBuilder().addComponents(reasonInput);
      modal.addComponents(actionRow);

      // ✅ Show the modal to the user
      await interaction.showModal(modal);
      console.log("🟢 Close ticket modal shown.");
    } catch (error) {
      console.error("❌ Error in /close command:", error);
      return interaction.reply({
        content: "An error occurred while attempting to close this ticket.",
        flags: 64,
      });
    }
  },
};
