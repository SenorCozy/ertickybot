const { SlashCommandBuilder, PermissionsBitField } = require("discord.js");
const { db } = require("../database");
require("dotenv").config();

const {
  buildClaimRow,
  disableQuickUnclaimIfAny,
  activeQuickUnclaimButtons,
} = require("../claimHelper");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("unclaim")
    .setDescription("Unclaim a ticket, making it available for other helpers.")
    .addChannelOption((option) =>
      option
        .setName("ticket")
        .setDescription("The ticket channel you want to unclaim.")
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: 64 });

    const ticketChannel = interaction.options.getChannel("ticket");
    if (!ticketChannel) {
      return interaction.editReply({ content: "❌ Invalid ticket channel." });
    }

    const user = interaction.user;
    const member = await interaction.guild.members.fetch(user.id);

    // Role checks
    const isActiveHelper = member.roles.cache.has(
      process.env.ACTIVE_HELPER_ROLE
    );
    const isTicketMod = member.roles.cache.has(
      process.env.TICKET_MODERATOR_ROLE
    );
    const isEldenMod = member.roles.cache.has(process.env.ELDEN_MODERATOR);
    const isEldenEnforcer = member.roles.cache.has(process.env.ELDEN_ENFORCER);
    const hasBypassRole = isTicketMod || isEldenMod || isEldenEnforcer;

    // Require Active Helper unless bypass role
    if (!isActiveHelper && !hasBypassRole) {
      return interaction.editReply({
        content: "❌ You need the 'Active Helper' role to unclaim tickets.",
      });
    }

    // Lookup ticket
    db.get(
      "SELECT * FROM tickets WHERE channel_id = ?",
      [ticketChannel.id],
      async (err, ticket) => {
        if (err) {
          console.error("❌ DB error while unclaiming:", err);
          return interaction.editReply({ content: "❌ Database error." });
        }
        if (!ticket) {
          return interaction.editReply({
            content: "❌ This is not a valid ticket channel.",
          });
        }

        if (!ticket.claimed_by) {
          return interaction.editReply({
            content: "❌ This ticket is not currently claimed.",
          });
        }

        const isClaimer = ticket.claimed_by === user.id;

        // Non-mods must be the claimer; mods can unclaim any ticket
        if (!isClaimer && !hasBypassRole) {
          return interaction.editReply({
            content:
              "❌ Only the current claimer or a moderator can unclaim this ticket.",
          });
        }

        // Perform the unclaim — moderators can always clear
        const sql = hasBypassRole
          ? `UPDATE tickets SET claimed_by = NULL WHERE channel_id = ?`
          : `UPDATE tickets SET claimed_by = NULL WHERE channel_id = ? AND claimed_by = ?`;

        const params = hasBypassRole
          ? [ticketChannel.id]
          : [ticketChannel.id, user.id];

        db.run(sql, params, async function (uErr) {
          if (uErr) {
            console.error("❌ DB update failed:", uErr);
            return interaction.editReply({
              content: "❌ Failed to unclaim the ticket.",
            });
          }

          if (this.changes === 0) {
            return interaction.editReply({
              content: "⚠️ Ticket already unclaimed or modified just now.",
            });
          }

          // Restore baseline permissions
          try {
            await ticketChannel.permissionOverwrites.set([
              {
                id: interaction.guild.id,
                deny: [PermissionsBitField.Flags.ViewChannel],
              },
              {
                id: ticket.user_id,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.SendMessages,
                  PermissionsBitField.Flags.ReadMessageHistory,
                ],
              },
              {
                id: process.env.ACTIVE_HELPER_ROLE,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.SendMessages,
                  PermissionsBitField.Flags.ReadMessageHistory,
                ],
              },
              {
                id: process.env.TICKET_MODERATOR_ROLE,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.SendMessages,
                  PermissionsBitField.Flags.ReadMessageHistory,
                ],
              },
              {
                id: process.env.ELDEN_MODERATOR,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.SendMessages,
                  PermissionsBitField.Flags.ReadMessageHistory,
                ],
              },
              {
                id: process.env.ELDEN_ENFORCER,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.SendMessages,
                  PermissionsBitField.Flags.ReadMessageHistory,
                ],
              },
              {
                id: process.env.REPUTATION_BOT,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.SendMessages,
                  PermissionsBitField.Flags.ReadMessageHistory,
                ],
              },
              {
                id: process.env.BOTS,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.SendMessages,
                  PermissionsBitField.Flags.ReadMessageHistory,
                ],
              },
              {
                id: interaction.client.user.id,
                allow: [
                  PermissionsBitField.Flags.ViewChannel,
                  PermissionsBitField.Flags.SendMessages,
                  PermissionsBitField.Flags.ManageChannels,
                  PermissionsBitField.Flags.ReadMessageHistory,
                  PermissionsBitField.Flags.ManageMessages,
                ],
              },
            ]);
          } catch (owErr) {
            console.error("⚠️ Failed to reset overwrites:", owErr);
          }

          // Flip top message buttons back to Claim + Close
          try {
            if (ticket.message_id) {
              const msg = await ticketChannel.messages.fetch(ticket.message_id);
              const row = buildClaimRow(ticketChannel.id, null);
              await msg.edit({ components: [row] });
            }
          } catch (editErr) {
            console.error("⚠️ Could not edit top ticket message:", editErr);
          }

          // Disable quick-unclaim row
          try {
            await disableQuickUnclaimIfAny(ticketChannel, ticketChannel.id);
          } catch {}

          await interaction.editReply({
            content:
              "✅ Ticket successfully unclaimed and now open for other helpers.",
          });

          await ticketChannel.send(
            "♻️ Ticket is now unclaimed. Anyone can now help with this ticket."
          );
        });
      }
    );
  },
};
