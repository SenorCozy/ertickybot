const { SlashCommandBuilder, PermissionsBitField } = require("discord.js");
const { db } = require("../database");
require("dotenv").config();

const {
  buildClaimRow,
  buildQuickUnclaimRow,
  disableQuickUnclaimIfAny,
  activeQuickUnclaimButtons,
} = require("../claimHelper");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("transfer")
    .setDescription(
      "Transfer ticket claim to another Active Helper (mods only)."
    )
    .addChannelOption((option) =>
      option
        .setName("ticket")
        .setDescription("The ticket to transfer")
        .setRequired(true)
    )
    .addUserOption((option) =>
      option
        .setName("new_helper")
        .setDescription("The new Active Helper who will take over")
        .setRequired(true)
    ),

  async execute(interaction) {
    await interaction.deferReply({ flags: 64 });

    const ticketChannel = interaction.options.getChannel("ticket");
    const newHelper = interaction.options.getUser("new_helper");

    if (!ticketChannel || !newHelper) {
      return interaction.editReply({
        content: "❌ Invalid ticket or helper selection.",
      });
    }

    // Must be a moderator-type role to transfer
    const invoker = await interaction.guild.members.fetch(interaction.user.id);
    const isTicketMod = invoker.roles.cache.has(
      process.env.TICKET_MODERATOR_ROLE
    );
    const isEldenMod = invoker.roles.cache.has(process.env.ELDEN_MODERATOR);
    const isEldenEnforcer = invoker.roles.cache.has(process.env.ELDEN_ENFORCER);
    const isModerator = isTicketMod || isEldenMod || isEldenEnforcer;

    if (!isModerator) {
      return interaction.editReply({
        content: "❌ You do not have permission to use /transfer.",
      });
    }

    // The assignee must have Active Helper
    const newHelperMember = await interaction.guild.members
      .fetch(newHelper.id)
      .catch(() => null);
    if (!newHelperMember) {
      return interaction.editReply({
        content: "❌ The selected user is not in this server.",
      });
    }

    const newHasActiveHelper = newHelperMember.roles.cache.has(
      process.env.ACTIVE_HELPER_ROLE
    );
    if (!newHasActiveHelper) {
      return interaction.editReply({
        content: "❌ The selected user must have the **Active Helper** role.",
      });
    }

    // Load ticket
    db.get(
      "SELECT * FROM tickets WHERE channel_id = ?",
      [ticketChannel.id],
      async (err, ticket) => {
        if (err) {
          console.error("❌ DB error on /transfer:", err);
          return interaction.editReply({ content: "❌ Database error." });
        }
        if (!ticket) {
          return interaction.editReply({
            content: "❌ This is not a valid ticket channel.",
          });
        }

        const previousHelperId = ticket.claimed_by || null;
        if (previousHelperId === newHelper.id) {
          return interaction.editReply({
            content: "ℹ️ The ticket is already assigned to that helper.",
          });
        }

        // Update DB: set the new claimer
        db.run(
          "UPDATE tickets SET claimed_by = ? WHERE channel_id = ?",
          [newHelper.id, ticketChannel.id],
          async function (uErr) {
            if (uErr) {
              console.error("❌ Failed to transfer claim:", uErr);
              return interaction.editReply({
                content: "❌ Failed to transfer the ticket.",
              });
            }

            // Replace channel overwrites to match your claim policy
            try {
              await ticketChannel.permissionOverwrites.set([
                {
                  id: interaction.guild.id,
                  deny: [PermissionsBitField.Flags.ViewChannel],
                },
                {
                  id: ticket.user_id, // ticket creator
                  allow: [
                    PermissionsBitField.Flags.ViewChannel,
                    PermissionsBitField.Flags.SendMessages,
                    PermissionsBitField.Flags.ReadMessageHistory,
                  ],
                },
                {
                  id: newHelper.id, // new claimer
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
              console.error(
                "⚠️ Failed to set overwrites on transfer:",
                permErr
              );
              // continue; UI will still be updated below
            }

            // Flip the ORIGINAL top embed to Unclaim + Close for the new helper
            try {
              if (ticket.message_id) {
                const topMsg = await ticketChannel.messages.fetch(
                  ticket.message_id
                );
                const row = buildClaimRow(ticketChannel.id, newHelper.id);
                await topMsg.edit({ components: [row] });
              }
            } catch (editErr) {
              console.error("⚠️ Could not edit top ticket message:", editErr);
            }

            // Disable any existing quick-unclaim row and post a new one for the new helper
            try {
              await disableQuickUnclaimIfAny(ticketChannel, ticketChannel.id);
            } catch {}

            try {
              const quickRow = buildQuickUnclaimRow(
                ticketChannel.id,
                newHelper.id
              );
              const quickMsg = await ticketChannel.send({
                content: previousHelperId
                  ? `🔁 Ticket **transferred** from <@${previousHelperId}> to <@${newHelper.id}>.\nUse the button below to unclaim when you're done:`
                  : `🧰 Ticket **assigned** to <@${newHelper.id}>.\nUse the button below to unclaim when you're done:`,
                components: [quickRow],
              });
              activeQuickUnclaimButtons[ticketChannel.id] = quickMsg.id;
            } catch (sendErr) {
              console.error("⚠️ Could not send quick-unclaim row:", sendErr);
            }

            // Final confirmations
            await interaction.editReply({
              content: previousHelperId
                ? `✅ Ticket transferred to <@${newHelper.id}>.`
                : `✅ Ticket assigned to <@${newHelper.id}>.`,
            });

            await ticketChannel.send(
              previousHelperId
                ? `🔁 Ticket has been **reassigned** to <@${newHelper.id}> by a moderator.`
                : `🧰 Ticket has been **assigned** to <@${newHelper.id}> by a moderator.`
            );
          }
        );
      }
    );
  },
};
