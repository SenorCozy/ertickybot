const {
  SlashCommandBuilder,
  PermissionsBitField,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");
const { db } = require("../database");
const {
  buildClaimRow,
  buildQuickUnclaimRow,
  disableQuickUnclaimIfAny,
  activeQuickUnclaimButtons,
} = require("../claimHelper");

require("dotenv").config();

module.exports = {
  data: new SlashCommandBuilder()
    .setName("claim")
    .setDescription("Claim a ticket (mods can take over)")
    .addChannelOption((option) =>
      option
        .setName("ticket")
        .setDescription("The ticket you want to claim")
        .setRequired(true)
    ),

  async execute(interaction, client) {
    await interaction.deferReply({ flags: 64 }); // ack once

    const ticketChannel = interaction.options.getChannel("ticket");
    if (!ticketChannel) {
      return interaction.editReply({ content: "❌ Invalid channel." });
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

    const hasOverride = isTicketMod || isEldenMod || isEldenEnforcer;

    // Policy: Active Helper normally required, but override roles bypass this
    if (!isActiveHelper && !hasOverride) {
      return interaction.editReply({
        content: "❌ You need the 'Active Helper' role to claim tickets.",
      });
    }

    // Pull ticket
    db.get(
      "SELECT * FROM tickets WHERE channel_id = ?",
      [ticketChannel.id],
      async (err, ticket) => {
        if (err) {
          console.error("❌ DB error:", err);
          return interaction.editReply({ content: "❌ Database error." });
        }
        if (!ticket) {
          return interaction.editReply({
            content: "❌ This is not a valid ticket channel.",
          });
        }

        // Prevent creator claiming unless override
        if (user.id === ticket.user_id && !hasOverride) {
          return interaction.editReply({
            content:
              "❌ You cannot claim your own ticket unless you are a Ticket Moderator, Elden Moderator, or Elden Enforcer.",
          });
        }

        const previousClaimer = ticket.claimed_by || null;
        const alreadyYours = previousClaimer === user.id;

        // Decide SQL (mods can take over regardless of current claimer)
        const sql = hasOverride
          ? `UPDATE tickets SET claimed_by = ? WHERE channel_id = ?`
          : `UPDATE tickets SET claimed_by = ? WHERE channel_id = ? AND (claimed_by IS NULL OR claimed_by = '')`;

        db.run(sql, [user.id, ticketChannel.id], async function (uErr) {
          if (uErr) {
            console.error("❌ Claim update failed:", uErr);
            return interaction.editReply({ content: "❌ Failed to claim." });
          }

          // Non-override path: if no row updated, someone else has it
          if (!hasOverride && this.changes === 0) {
            db.get(
              "SELECT claimed_by FROM tickets WHERE channel_id = ?",
              [ticketChannel.id],
              async (_e2, row2) => {
                const who = row2?.claimed_by
                  ? `<@${row2.claimed_by}>`
                  : "unknown";
                return interaction.editReply({
                  content: `⚠️ Already claimed by ${who}.`,
                });
              }
            );
            return;
          }

          // Update channel permissions (replace overwrites)
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
                id: user.id, // new claimer
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
          } catch (permErr) {
            console.error("⚠️ Overwrites failed:", permErr);
          }

          // Flip the ORIGINAL top embed to "Unclaim + Close"
          try {
            if (ticket.message_id) {
              const msg = await ticketChannel.messages.fetch(ticket.message_id);
              const row = buildClaimRow(ticketChannel.id, user.id);
              await msg.edit({ components: [row] });
            }
          } catch (editErr) {
            console.error(
              "⚠️ Failed to edit original ticket message:",
              editErr
            );
          }

          // Disable any previous quick-unclaim message, then post a fresh one
          await disableQuickUnclaimIfAny(ticketChannel, ticketChannel.id);

          const quickRow = buildQuickUnclaimRow(ticketChannel.id, user.id);
          const quickMsg = await ticketChannel.send({
            content: !previousClaimer
              ? `🧰 <@${user.id}> claimed this ticket. Use the button below to unclaim when you're done:`
              : alreadyYours
              ? `🧰 <@${user.id}> is already the current helper for this ticket.`
              : `🧰 Ticket has been **reassigned** to <@${user.id}>.`,
            components: [quickRow],
          });
          activeQuickUnclaimButtons[ticketChannel.id] = quickMsg.id;

          // Finish with a clean, accurate confirmation
          if (!previousClaimer) {
            await interaction.editReply({
              content: `✅ You have **claimed** this ticket: <#${ticketChannel.id}>.`,
            });
            await ticketChannel.send(`🧰 Ticket claimed by <@${user.id}>`);
          } else if (alreadyYours) {
            await interaction.editReply({
              content: `ℹ️ You already own this ticket: <#${ticketChannel.id}>.`,
            });
          } else {
            await interaction.editReply({
              content: `✅ You have **taken over** this ticket: <#${ticketChannel.id}>.`,
            });
            await ticketChannel.send(
              `🧰 Ticket has been **reassigned** to <@${user.id}> by a moderator.`
            );
          }
        });
      }
    );
  },
};
