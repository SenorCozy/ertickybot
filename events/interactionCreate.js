const { db, addUniqueUser, incrementTicketPlatform } = require("../database");
require("dotenv").config();
const marked = require("marked");
const he = require("he");
const { encryptText } = require("../crypto");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ChannelType,
  PermissionsBitField,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Client,
  Events,
} = require("discord.js");
const {
  buildClaimRow,
  buildQuickUnclaimRow,
  disableQuickUnclaimIfAny,
  activeQuickUnclaimButtons,
} = require("../claimHelper");

// Platform-specific helper role IDs
const PLATFORM_HELPER_ROLES = {
  platform_ps: process.env.PLATFORM_HELPER_PS,
  platform_pc: process.env.PLATFORM_HELPER_PC,
  platform_xbox: process.env.PLATFORM_HELPER_XBOX,
  platform_switch: process.env.PLATFORM_HELPER_SWITCH,
};

// Nintendo Switch is gated until the game's Switch release. The platform is
// only exposed when the flag is on AND both required role IDs are configured,
// so flipping the flag before the roles exist can't produce a broken button.
function isSwitchEnabled() {
  const enabled =
    String(process.env.SWITCH_ENABLED).toLowerCase() === "true";
  const ready =
    !!process.env.PLATFORM_HELPER_SWITCH && !!process.env.GENERAL_SWITCH_ROLE;
  if (enabled && !ready) {
    console.warn(
      "⚠️ SWITCH_ENABLED is true but PLATFORM_HELPER_SWITCH/GENERAL_SWITCH_ROLE are not set — hiding the Switch option."
    );
  }
  return enabled && ready;
}

// Ticket category ID
const TICKET_CATEGORY_ID = process.env.TICKET_CATEGORY_ID;

// helpers to ack fast and never throw on stale tokens
async function safeDeferReply(interaction, opts = { flags: 64 }) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply(opts); // ephemeral-style via flags
    }
  } catch (e) {
    // ignore Unknown interaction / already acknowledged
  }
}

async function safeEditReply(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply(payload);
    }
    return await interaction.reply(payload);
  } catch (e) {
    // fallback: if editReply failed (e.g. deferUpdate was used), try followUp
    try {
      return await interaction.followUp(payload);
    } catch {}
  }
}

async function safeFollowUp(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.followUp(payload);
    }
    return await interaction.reply(payload);
  } catch (e) {}
}

// simple duplicate-submit guard for a single interaction id
const inFlight = new Set();
function oncePerInteraction(interaction) {
  const k = interaction.id;
  if (inFlight.has(k)) return false;
  inFlight.add(k);
  setTimeout(() => inFlight.delete(k), 60_000);
  return true;
}

//event listeners
module.exports = {
  name: "interactionCreate",
  async execute(interaction, client) {
    try {
      // ✅ Ensure the interaction is only handled once
      if (!oncePerInteraction(interaction)) return;
      console.log(
        `🟢 Received interaction: ${interaction.type}, ID: ${interaction.id}`
      );

      // ✅ Handle Slash Commands
      if (interaction.isCommand()) {
        try {
          console.log(`🟡 Handling command: ${interaction.commandName}`);
          const command = client.commands.get(interaction.commandName);
          if (command) await command.execute(interaction);
        } catch (error) {
          console.error("❌ Error executing command:", error);
          return interaction.reply({
            content: "An error occurred while processing your command.",
            flags: 64,
          });
        }
      }

      // ✅ Handle Modal Submissions (Closing Ticket)
      else if (
        interaction.isModalSubmit() &&
        interaction.customId.startsWith("close_ticket_modal_")
      ) {
        try {
          // Ack NEW interaction immediately
          await interaction.deferReply({ flags: 64 }); // ok for modal submits

          // customId = close_ticket_modal_<channelId>
          const parts = interaction.customId.split("_");
          const ticketChannelId = parts[3];

          const ticketChannel =
            interaction.guild.channels.cache.get(ticketChannelId);
          if (!ticketChannel) {
            return interaction.editReply({
              content: "❌ Ticket channel not found.",
            });
          }

          const closureReason =
            (
              interaction.fields.getTextInputValue("closure_reason") || ""
            ).trim() || "No reason provided";

          const member = await interaction.guild.members.fetch(
            interaction.user.id
          );
          const isHelper = member.roles.cache.has(
            process.env.ACTIVE_HELPER_ROLE
          );
          const isTicketMod = member.roles.cache.has(
            process.env.TICKET_MODERATOR_ROLE
          );
          const isEldenMod = member.roles.cache.has(
            process.env.ELDEN_MODERATOR
          );
          const isEnforcer = member.roles.cache.has(process.env.ELDEN_ENFORCER);

          if (!isHelper && !isTicketMod && !isEldenMod && !isEnforcer) {
            return interaction.editReply({
              content:
                "❌ You don’t have permission to close this ticket directly.",
            });
          }

          // Load ticket by channel_id (fast DB hop)
          db.get(
            "SELECT * FROM tickets WHERE channel_id = ?",
            [ticketChannelId],
            async (err, ticket) => {
              if (err) {
                console.error("❌ DB error while closing the ticket:", err);
                return interaction.editReply({ content: "❌ Database error." });
              }
              if (!ticket) {
                return interaction.editReply({
                  content: "⚠️ Ticket not found in the database.",
                });
              }

              // Delegate to your unified helper (this will do transcript, logs, and delete)
              await closeTicket({
                interaction, // already deferred (deferReply)
                ticket,
                ticketChannel,
                closedBy: interaction.user,
                closureReason,
                // skipPermissionCheck not needed since we just checked roles
              });

              // ⛔ No further editReply/followUp here; closeTicket() already responded.
            }
          );
        } catch (modalError) {
          console.error("❌ Error handling ticket closure:", modalError);
          try {
            await interaction.editReply({
              content: "❌ Failed to close the ticket.",
            });
          } catch {}
        }
      }

      
      // ✅ Handle Buttons (create ticket button)
      else if (interaction.isButton()) {
        console.log(`🟡 Handling button interaction: ${interaction.customId}`);

        if (interaction.customId === "create_ticket") {
          // ACK right away; then render the platform picker with editReply
          await safeDeferReply(interaction, { flags: 64 });
          await promptPlatformSelection(interaction); // must use editReply inside
        } else if (
          ["platform_ps", "platform_pc", "platform_xbox", "platform_switch"].includes(
            interaction.customId
          )
        ) {
          try {
            // ACK first if not yet
            await safeDeferReply(interaction, { flags: 64 });
            await createPlatformTicket(interaction, client); // must use editReply/followUp inside
          } catch (error) {
            console.error("❌ Error executing createPlatformTicket:", error);
            await safeEditReply(interaction, {
              content: "❌ Failed to create ticket.",
            });
          }
        } else if (
          [
            "platformrole_pc",
            "platformrole_ps",
            "platformrole_xbox",
            "platformrole_switch",
          ].includes(interaction.customId)
        ) {
          const roleMap = {
            platformrole_pc: process.env.PLATFORM_HELPER_PC,
            platformrole_ps: process.env.PLATFORM_HELPER_PS,
            platformrole_xbox: process.env.PLATFORM_HELPER_XBOX,
            platformrole_switch: process.env.PLATFORM_HELPER_SWITCH,
          };

          const roleId = roleMap[interaction.customId];
          const member = interaction.guild.members.cache.get(
            interaction.user.id
          );

          if (!roleId || !member) {
            await safeDeferReply(interaction, { flags: 64 });
            return safeEditReply(interaction, {
              content: "❌ Something went wrong.",
            });
          }

          await safeDeferReply(interaction, { flags: 64 });

          try {
            if (member.roles.cache.has(roleId)) {
              await member.roles.remove(roleId);
              await safeEditReply(interaction, { content: "✅ Role removed!" });
            } else {
              await member.roles.add(roleId);
              await safeEditReply(interaction, { content: "✅ Role added!" });
            }
          } catch (err) {
            console.error("❌ Failed to toggle role:", err);
            await safeEditReply(interaction, {
              content: "⚠️ Unable to update your roles. Please try again.",
            });
          }
        }

        // ⏸️ Snooze Button Handler
        else if (interaction.customId.startsWith("snooze_ticket_")) {
          try {
            await interaction.deferUpdate(); // ACK immediately to prevent 10062

            const ticketId = interaction.customId.split("_").pop();

            db.get(
              "SELECT * FROM tickets WHERE id = ?",
              [ticketId],
              async (err, ticket) => {
                if (err || !ticket) {
                  console.error("❌ Failed to fetch ticket for snooze:", err);
                  return interaction.followUp({
                    content: "❌ Error: Could not find the ticket.",
                    flags: 64,
                  });
                }

                // 🔒 Ensure only the ticket creator can snooze
                if (interaction.user.id !== ticket.user_id) {
                  return interaction.followUp({
                    content: "❌ Only the ticket creator can snooze reminders.",
                    flags: 64,
                  });
                }

                // Snooze: pause the reminder machine for 60 minutes. Do NOT
                // touch last_activity — so when the snooze expires the ticket
                // is still idle and a fresh reminder fires (see checkIdleTickets).
                const snoozeUntil = new Date(
                  Date.now() + 60 * 60 * 1000
                ).toISOString();
                db.run(
                  "UPDATE tickets SET snooze_until = ?, reminder_stage = 'none', last_reminder_sent = NULL WHERE id = ?",
                  [snoozeUntil, ticketId],
                  async (updateErr) => {
                    if (updateErr) {
                      console.error(
                        "❌ Failed to snooze idle reminder:",
                        updateErr
                      );
                      return interaction.followUp({
                        content:
                          "❌ Something went wrong snoozing this reminder.",
                        flags: 64,
                      });
                    }

                    // Disable the two buttons on the reminder message (best-effort)
                    try {
                      const msg =
                        interaction.message ??
                        (await interaction.channel.messages.fetch(
                          interaction.message.id
                        ));
                      const disabledRow = new ActionRowBuilder().addComponents(
                        interaction.message.components[0].components.map(
                          (btn) => ButtonBuilder.from(btn).setDisabled(true)
                        )
                      );
                      await msg.edit({ components: [disabledRow] });
                    } catch (editErr) {
                      console.warn(
                        "⚠️ Could not disable snooze buttons:",
                        editErr?.message ?? editErr
                      );
                    }

                    return interaction.followUp({
                      content:
                        "✅ Got it — we’ll keep the ticket open and pause reminders for 60 minutes.",
                    });
                  }
                );
              }
            );
          } catch (e) {
            console.error("❌ snooze_ticket error:", e);
            try {
              await interaction.followUp({
                content: "❌ Error: could not snooze.",
                flags: 64,
              });
            } catch {}
          }
        }

        // 🛑 User-Initiated Close Button
        else if (interaction.customId.startsWith("user_close_ticket_")) {
          try {
            await interaction.deferUpdate(); // ACK immediately

            const ticketId = interaction.customId.split("_").pop();

            db.get(
              "SELECT * FROM tickets WHERE id = ?",
              [ticketId],
              async (err, ticket) => {
                if (err || !ticket) {
                  console.error(
                    "❌ Failed to fetch ticket for user-initiated close:",
                    err
                  );
                  return interaction.followUp({
                    content: "❌ Error closing ticket.",
                    flags: 64,
                  });
                }

                // Only the ticket creator can close from this reminder button
                if (interaction.user.id !== ticket.user_id) {
                  return interaction.followUp({
                    content:
                      "❌ Only the original ticket creator can use this button.",
                    flags: 64,
                  });
                }

                const ticketChannel = interaction.guild.channels.cache.get(
                  ticket.channel_id
                );
                if (!ticketChannel) {
                  return interaction.followUp({
                    content: "❌ Ticket channel no longer exists.",
                    flags: 64,
                  });
                }

                // No reminder-state write needed: closeTicket() sets
                // status='closed', which excludes this row from the idle check.

                // Disable the reminder message buttons (best-effort)
                try {
                  const msg =
                    interaction.message ??
                    (await interaction.channel.messages.fetch(
                      interaction.message.id
                    ));
                  const disabledRow = new ActionRowBuilder().addComponents(
                    interaction.message.components[0].components.map((btn) =>
                      ButtonBuilder.from(btn).setDisabled(true)
                    )
                  );
                  await msg.edit({ components: [disabledRow] });
                } catch (editErr) {
                  console.warn(
                    "⚠️ Could not disable reminder buttons on close:",
                    editErr?.message ?? editErr
                  );
                }

                const closureReason = "Closed by user via idle reminder button";

                // IMPORTANT: closeTicket must NOT call interaction.reply().
                // It can post in the channel or use interaction.followUp if it needs to message.
                await closeTicket({
                  interaction, // already deferred
                  ticket,
                  ticketChannel,
                  closedBy: interaction.user,
                  closureReason,
                  skipPermissionCheck: true,
                });
              }
            );
          } catch (e) {
            console.error("❌ user_close_ticket error:", e);
            try {
              await interaction.followUp({
                content: "❌ Error closing ticket.",
                flags: 64,
              });
            } catch {}
          }
        }

        // ✅ Handle "Claim Ticket" Button
        else if (interaction.customId.startsWith("claim_ticket_")) {
          try {
            console.log("🔵 Claim button clicked");

            // Acknowledge immediately (prevents 10062)
            await interaction.deferUpdate();

            const ticketChannelId = interaction.customId.split("_")[2];
            const ticketChannel =
              interaction.guild.channels.cache.get(ticketChannelId);

            if (!ticketChannel) {
              return interaction.followUp({
                content: "❌ Ticket channel not found.",
                flags: 64,
              });
            }

            const member = await interaction.guild.members.fetch(
              interaction.user.id
            );

            // Require Active Helper
            if (!member.roles.cache.has(process.env.ACTIVE_HELPER_ROLE)) {
              return interaction.followUp({
                content:
                  "❌ You need the 'Active Helper' role to claim tickets.",
                flags: 64,
              });
            }

            // Load ticket
            db.get(
              "SELECT * FROM tickets WHERE channel_id = ?",
              [ticketChannel.id],
              (err, ticket) => {
                if (err) {
                  console.error("❌ DB error:", err);
                  return interaction.followUp({
                    content: "❌ Error retrieving ticket.",
                    flags: 64,
                  });
                }
                if (!ticket) {
                  return interaction.followUp({
                    content: "⚠️ Ticket not found in database.",
                    flags: 64,
                  });
                }

                // Prevent creator claiming unless mod
                const isMod = member.roles.cache.has(
                  process.env.TICKET_MODERATOR_ROLE
                );
                if (interaction.user.id === ticket.user_id && !isMod) {
                  return interaction.followUp({
                    content:
                      "❌ You can’t claim your own ticket unless you’re a Ticket Moderator.",
                    flags: 64,
                  });
                }

                // Atomic claim
                db.run(
                  `UPDATE tickets
           SET claimed_by = ?
         WHERE channel_id = ?
           AND (claimed_by IS NULL OR claimed_by = '')`,
                  [interaction.user.id, ticketChannel.id],
                  async function (uErr) {
                    if (uErr) {
                      console.error("❌ Claim update failed:", uErr);
                      return interaction.followUp({
                        content: "❌ Failed to claim.",
                        flags: 64,
                      });
                    }

                    if (this.changes === 0) {
                      // Someone else already claimed; tell who
                      db.get(
                        "SELECT claimed_by FROM tickets WHERE channel_id = ?",
                        [ticketChannel.id],
                        (_e2, row2) => {
                          const who = row2?.claimed_by
                            ? `<@${row2.claimed_by}>`
                            : "unknown";
                          return interaction.followUp({
                            content: `⚠️ Already claimed by ${who}.`,
                            flags: 64,
                          });
                        }
                      );
                      return;
                    }

                    // Update channel permissions (best-effort; already deferred)
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
                          id: interaction.user.id,
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

                    // Flip the ORIGINAL embed’s buttons to Unclaim
                    try {
                      if (ticket.message_id) {
                        const msg = await ticketChannel.messages.fetch(
                          ticket.message_id
                        );
                        const row = buildClaimRow(
                          ticketChannel.id,
                          interaction.user.id
                        );
                        await msg.edit({ components: [row] });
                      }
                    } catch (editErr) {
                      console.error(
                        "⚠️ Failed to edit original ticket message:",
                        editErr
                      );
                    }

                    // 🔕 Disable any previous quick-unclaim message for this ticket
                    await disableQuickUnclaimIfAny(
                      ticketChannel,
                      ticketChannel.id
                    );

                    // 🆕 Send fresh quick Unclaim message (easy to reach at the bottom)
                    const quickRow = buildQuickUnclaimRow(
                      ticketChannel.id,
                      interaction.user.id
                    );
                    const quickMsg = await ticketChannel.send({
                      content: `🧰 <@${interaction.user.id}> claimed this ticket. Use the button below to unclaim when you're done:`,
                      components: [quickRow],
                    });
                    activeQuickUnclaimButtons[ticketChannel.id] = quickMsg.id;

                    await interaction.followUp({
                      content: "✅ You claimed this ticket.",
                      flags: 64,
                    });
                    await ticketChannel.send(
                      `🧰 Ticket claimed by <@${interaction.user.id}>`
                    );
                    console.log(
                      `✅ Ticket ${ticketChannel.id} claimed by ${interaction.user.id}`
                    );
                  }
                );
              }
            );
          } catch (err) {
            console.error("❌ Claim handler exception:", err);
            try {
              await interaction.followUp({
                content: "❌ Unexpected error during claim.",
                flags: 64,
              });
            } catch {}
          }
        }

        // ✅ Handle "Unclaim Ticket" Button
        else if (interaction.customId.startsWith("unclaim_ticket_")) {
          try {
            console.log("🔴 Unclaim button clicked");
            await interaction.deferUpdate();

            const parts = interaction.customId.split("_");
            const maybeQuick = parts[4] === "quick";
            const ticketChannelId = parts[2];
            const expectedClaimerId = parts[3]; // useful if you want to enforce the same user

            const ticketChannel =
              interaction.guild.channels.cache.get(ticketChannelId);
            if (!ticketChannel) {
              return interaction.followUp({
                content: "❌ Ticket channel not found.",
                flags: 64,
              });
            }

            db.get(
              "SELECT * FROM tickets WHERE channel_id = ?",
              [ticketChannel.id],
              async (err, ticket) => {
                if (err || !ticket) {
                  if (err) console.error("❌ DB error:", err);
                  return interaction.followUp({
                    content: "❌ Ticket not found.",
                    flags: 64,
                  });
                }

                const member = await interaction.guild.members.fetch(
                  interaction.user.id
                );

                const isClaimer = ticket.claimed_by === interaction.user.id;
                const hasBypassRole = [
                  process.env.ELDEN_MODERATOR,
                  process.env.ELDEN_ENFORCER,
                  process.env.TICKET_MODERATOR_ROLE,
                ].some((rid) => rid && member.roles.cache.has(rid));

                if (!isClaimer && !hasBypassRole) {
                  return interaction.followUp({
                    content:
                      "❌ Only the current claimer or a moderator can unclaim.",
                    flags: 64,
                  });
                }

                // Atomic unclaim (only if still claimed by the same user)
                db.run(
                  `UPDATE tickets
           SET claimed_by = NULL
         WHERE channel_id = ?
           AND claimed_by = ?`,
                  [ticketChannel.id, ticket.claimed_by || ""],
                  async function (uErr) {
                    if (uErr) {
                      console.error("❌ Unclaim update failed:", uErr);
                      return interaction.followUp({
                        content: "❌ Failed to unclaim.",
                        flags: 64,
                      });
                    }

                    if (this.changes === 0) {
                      return interaction.followUp({
                        content:
                          "⚠️ Ticket already unclaimed or changed just now.",
                        flags: 64,
                      });
                    }

                    // Restore/relax perms (adjust to your policy)
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
                      console.error("⚠️ Overwrite set failed:", owErr);
                    }

                    // Flip the ORIGINAL embed back to Claim
                    try {
                      if (ticket.message_id) {
                        const msg = await ticketChannel.messages.fetch(
                          ticket.message_id
                        );
                        const row = buildClaimRow(ticketChannel.id, null);
                        await msg.edit({ components: [row] });
                      }
                    } catch (editErr) {
                      console.error(
                        "⚠️ Failed to edit original ticket message:",
                        editErr
                      );
                    }

                    // 🔕 Disable quick-unclaim if it exists
                    await disableQuickUnclaimIfAny(
                      ticketChannel,
                      ticketChannel.id
                    );

                    await interaction.followUp({
                      content:
                        "✅ Ticket unclaimed. It’s now available for other helpers.",
                      flags: 64,
                    });
                    await ticketChannel.send(
                      `♻️ Ticket is now unclaimed. Anyone can now help with this ticket.`
                    );
                    console.log(
                      `🔴 Ticket ${ticketChannel.id} unclaimed by ${interaction.user.id}`
                    );
                  }
                );
              }
            );
          } catch (err) {
            console.error("❌ Unclaim handler exception:", err);
            try {
              await interaction.followUp({
                content: "❌ Unexpected error during unclaim.",
                flags: 64,
              });
            } catch {}
          }
        }

        // Handle undo rep/remove rep button
        else if (interaction.customId.startsWith("undo_rep_")) {
          console.log("🔴 Undo Rep button clicked");
          await interaction.deferReply();

          const messageId = interaction.customId.split("_")[2];
          const channel = interaction.channel;

          try {
            const targetMessage = await channel.messages.fetch(messageId);

            if (!targetMessage) {
              return interaction.editReply({
                content: "❌ The message could not be found.",
              });
            }

            // ✅ Allow override for these roles
            const bypassRoles = [
              process.env.TICKET_MODERATOR_ROLE,
              process.env.ELDEN_MODERATOR,
              process.env.ELDEN_ENFORCER,
            ];

            const hasBypass = interaction.member.roles.cache.some((role) =>
              bypassRoles.includes(role.id)
            );

            // ✅ Allow author, mentioned user, or bypass
            const mentionedUsers = targetMessage.mentions.users.map(
              (user) => user.id
            );
            const hasPermission =
              interaction.user.id === targetMessage.author.id ||
              mentionedUsers.includes(interaction.user.id) ||
              hasBypass;

            if (!hasPermission) {
              return interaction.followUp({
                content: "❌ You do not have permission to undo this rep.",
                flags: 64,
              });
            }

            // ✅ Delete the rep message
            await targetMessage.delete();

            // ✅ Disable the "Undo Rep" button on the original interaction message
            try {
              const originalMessage = interaction.message;
              if (originalMessage) {
                const components = originalMessage.components.map((row) => {
                  const newRow = ActionRowBuilder.from(row);
                  newRow.components = row.components.map((btn) =>
                    ButtonBuilder.from(btn).setDisabled(true)
                  );
                  return newRow;
                });

                await originalMessage.edit({ components });
              }
            } catch (editErr) {
              console.warn("⚠️ Could not disable undo rep button:", editErr);
            }

            await interaction.followUp({
              content: "🗑️ The rep message has been deleted.",
            });
          } catch (error) {
            console.error("❌ Error deleting message:", error);
            return interaction.editReply({
              content:
                "Failed to undo rep. Please tag ticket handlers for help.",
            });
          }
        }

        // ✅ Handle "Close Ticket" Button (Show Modal Immediately)
        else if (interaction.customId.startsWith("close_ticket_")) {
          console.log("🟢 Close ticket button clicked.");
          const ticketChannelId = interaction.customId.split("_")[2];
          const ticketChannel =
            interaction.guild.channels.cache.get(ticketChannelId);

          if (!ticketChannel) {
            console.warn("⚠️ Ticket channel not found.");
            return interaction.reply({
              content: "Ticket channel not found.",
              flags: 64,
            });
          }

          // ✅ Create and Show Modal
          try {
            console.log("🟡 Preparing close ticket modal...");
            const modal = new ModalBuilder()
              .setCustomId(`close_ticket_modal_${ticketChannel.id}`)
              .setTitle("Close Ticket");

            const reasonInput = new TextInputBuilder()
              .setCustomId("closure_reason")
              .setLabel("Enter reason for closing")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false);

            const actionRow = new ActionRowBuilder().addComponents(reasonInput);
            modal.addComponents(actionRow);

            console.log("🟢 Showing modal...");
            await interaction.showModal(modal);
            console.log("✅ Modal successfully displayed.");
          } catch (error) {
            console.error("❌ Error showing close modal:", error);
          }
        }
      }
    } catch (error) {
      console.error("❌ Error handling interaction:", error);
    }
  },
};

// Step 1: Ask for platform selection
async function promptPlatformSelection(interaction) {
  try {
    // Caller should have done safeDeferReply already, but make it safe here too:
    await safeDeferReply(interaction, { flags: 64 });

    const platformButtons = [
      new ButtonBuilder()
        .setCustomId("platform_ps")
        .setLabel("PlayStation")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("platform_pc")
        .setLabel("Steam (PC)")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("platform_xbox")
        .setLabel("Xbox")
        .setStyle(ButtonStyle.Primary),
    ];

    if (isSwitchEnabled()) {
      platformButtons.push(
        new ButtonBuilder()
          .setCustomId("platform_switch")
          .setLabel("Nintendo Switch")
          .setStyle(ButtonStyle.Primary)
      );
    }

    const row = new ActionRowBuilder().addComponents(...platformButtons);

    await safeEditReply(interaction, {
      content: "Which platform do you need help on?",
      components: [row],
      // no need to pass flags again on edit
    });
  } catch (error) {
    console.error("❌ Error displaying platform selection:", error);
    await safeEditReply(interaction, {
      content:
        "❌ An error occurred while showing platform options. Please try again.",
    });
  }
}

// Define general platform roles from .env
const GENERAL_PLATFORM_ROLES = {
  platform_ps: process.env.GENERAL_PS_ROLE,
  platform_pc: process.env.GENERAL_PC_ROLE,
  platform_xbox: process.env.GENERAL_XBOX_ROLE,
  platform_switch: process.env.GENERAL_SWITCH_ROLE,
};
// Step 2: Create a ticket channel based on platform selection
// Step 2: Create a ticket channel based on platform selection
async function createPlatformTicket(interaction, client) {
  try {
    // Ensure we’re ACKed once
    await safeDeferReply(interaction, { flags: 64 });

    const guild = interaction.guild;
    const ticketCreator = interaction.user;

    const member = await guild.members.fetch(ticketCreator.id).catch((err) => {
      console.error("❌ Failed to fetch user:", err);
      return null;
    });

    if (!member) {
      return safeEditReply(interaction, {
        content:
          "❌ An error occurred. You must be in the server to create a ticket.",
      });
    }

    // 🔍 Check blacklist
    db.get(
      "SELECT * FROM blacklist WHERE user_id = ?",
      [ticketCreator.id],
      async (err, row) => {
        if (err) {
          console.error("❌ Error checking blacklist:", err);
          return safeEditReply(interaction, {
            content:
              "❌ An error occurred while checking your ticket eligibility.",
          });
        }

        if (row) {
          return safeEditReply(interaction, {
            content: `❌ You are **blacklisted** from creating tickets.\n**Reason:** ${
              row.reason || "No reason provided."
            }`,
          });
        }

        const platform = interaction.customId;
        const generalRoleId = GENERAL_PLATFORM_ROLES[platform];
        const platformHelperRoleId = PLATFORM_HELPER_ROLES[platform];

        if (!generalRoleId || !platformHelperRoleId) {
          return safeEditReply(interaction, {
            content: "❌ Invalid platform selected.",
          });
        }

        // assign general platform role (best-effort)
        try {
          await assignGeneralPlatformRole(member, generalRoleId);
        } catch (assignErr) {
          console.warn("⚠️ Failed to assign general platform role:", assignErr);
        }

        // 🔍 Check DB for existing ticket
        let existingTicket;
        try {
          existingTicket = await getExistingTicket(ticketCreator.id);
        } catch (existErr) {
          console.error("❌ Error checking for existing ticket:", existErr);
          return safeEditReply(interaction, {
            content:
              "❌ An error occurred while checking for existing tickets.",
          });
        }

        if (existingTicket) {
          return safeEditReply(interaction, {
            content: `❗ You already have an open ticket: <#${existingTicket.channel_id}>`,
          });
        }

        // 🔍 Double-check a channel doesn’t already exist
        const potentialChannel = guild.channels.cache.find(
          (ch) =>
            ch.name === `ticket-${ticketCreator.username}` &&
            ch.parentId === TICKET_CATEGORY_ID
        );

        if (potentialChannel) {
          console.warn(
            `⚠️ Found existing channel with matching name: ${potentialChannel.id}`
          );
          return safeEditReply(interaction, {
            content: `❗ You already have a ticket channel that might be active: <#${potentialChannel.id}>`,
          });
        }

        // ✅ Create channel
        let ticketChannel;
        try {
          ticketChannel = await createTicketChannel(
            guild,
            ticketCreator,
            client,
            interaction
          );
          console.log(`✅ Ticket channel created: ${ticketChannel.id}`);
        } catch (channelErr) {
          console.error("❌ Error creating ticket channel:", channelErr);
          return safeEditReply(interaction, {
            content: "❌ An error occurred while creating your ticket channel.",
          });
        }

        // 💾 Store in DB
        try {
          await storeTicketInDatabase(
            ticketCreator,
            platform,
            ticketChannel.id
          );
        } catch (storeErr) {
          console.error("❌ Error storing ticket in DB:", storeErr);
          return safeEditReply(interaction, {
            content:
              "❌ An error occurred while saving your ticket in the database.",
          });
        }

        // 🕒 Update last activity (best-effort)
        db.run(
          "UPDATE tickets SET last_activity = ? WHERE channel_id = ?",
          [new Date().toISOString(), ticketChannel.id],
          (err) => {
            if (err) {
              console.error(
                "❌ Failed to update last_activity timestamp:",
                err
              );
            } else {
              console.log(
                `🕒 Set last_activity for ticket ${ticketChannel.id}`
              );
            }
          }
        );

        // 📩 Send embed and reminder
        try {
          await sendTicketEmbed(
            ticketChannel,
            ticketCreator,
            platformHelperRoleId
          );
        } catch (embedErr) {
          console.warn("⚠️ Failed to send ticket embed:", embedErr);
        }

        // small pause, then reminder
        await new Promise((r) => setTimeout(r, 3000));

        try {
          await ticketChannel.send({
            content:
              `💡 **Reminder:** Please remember to **thank your helper** after your request is complete!\n` +
              `Mention them using \`@username\` and include the word **"thank you"** in the same message. ` +
              `This helps them gain reputation and unlock new roles! 🎖️`,
          });
        } catch (reminderErr) {
          console.warn("⚠️ Failed to send reminder message:", reminderErr);
        }

        return safeEditReply(interaction, {
          content: `✅ Your ticket has been created: <#${ticketChannel.id}>`,
          components: [],
        });
      }
    );
  } catch (outerErr) {
    console.error("❌ Unexpected error in createPlatformTicket:", outerErr);
    return safeEditReply(interaction, {
      content: "❌ An unexpected error occurred while creating your ticket.",
    });
  }
}

// ✅ Helper function to fetch all messages in a channel
async function fetchAllMessages(channel) {
  try {
    let messages = [];
    let lastMessageId = null;

    while (true) {
      try {
        // ✅ Fetch messages in batches of 100 (Discord limit)
        const fetchedMessages = await channel.messages.fetch({
          limit: 100,
          ...(lastMessageId && { before: lastMessageId }),
        });

        if (fetchedMessages.size === 0) break; // ✅ Stop if no more messages

        messages.push(...fetchedMessages.values());
        lastMessageId = fetchedMessages.last()?.id;

        if (!lastMessageId) break; // ✅ Prevents infinite loop if there's an unexpected issue
      } catch (fetchError) {
        console.error("❌ Error fetching messages batch:", fetchError);
        break; // ✅ Stop fetching if there's an error
      }
    }

    return messages.reverse(); // ✅ Ensure chronological order
  } catch (error) {
    console.error("❌ Unexpected error in fetchAllMessages function:", error);
    return []; // ✅ Return an empty array in case of failure to prevent crashes
  }
}

async function assignGeneralPlatformRole(member, roleId) {
  if (!member.roles.cache.has(roleId)) {
    try {
      await member.roles.add(roleId);
      console.log(
        `✅ Assigned general platform role <@&${roleId}> to ${member.user.username}`
      );
    } catch (error) {
      console.error("❌ Failed to assign general platform role:", error);
    }
  } else {
    console.log(
      `ℹ️ User ${member.user.username} already has the general platform role.`
    );
  }
}

function getExistingTicket(userId) {
  return new Promise((resolve, reject) => {
    db.get(
      "SELECT * FROM tickets WHERE user_id = ? AND status = 'open'",
      [userId],
      (err, row) => {
        if (err) {
          console.error("❌ Database error checking existing tickets:", err);
          reject(err);
        } else {
          resolve(row);
        }
      }
    );
  });
}

function storeTicketInDatabase(user, platform, channelId) {
  return new Promise((resolve, reject) => {
    db.run(
      "INSERT INTO tickets (user_id, username, platform, channel_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        user.id,
        user.username,
        platform,
        channelId,
        "open",
        new Date().toISOString(),
      ],
      (dbErr) => {
        if (dbErr) {
          console.error("❌ Error inserting ticket into database:", dbErr);
          reject(dbErr);
        } else {
          console.log(`✅ Ticket for ${user.username} stored in the database.`);
          resolve();
        }
      }
    );
  });
}
async function sendTicketEmbed(ticketChannel, user, platformHelperRoleId) {
  try {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`claim_ticket_${ticketChannel.id}`)
        .setLabel("✅ Claim Ticket")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`close_ticket_${ticketChannel.id}`)
        .setLabel("❌ Close Ticket with Reason")
        .setStyle(ButtonStyle.Danger)
    );

    const ticketEmbed = new EmbedBuilder()
      .setColor(0xff0000)
      .setTitle("🛡️ Elden Ring Boss Help Ticket")
      .setDescription(
        `Hello <@${user.id}>, a <@&${platformHelperRoleId}> will assist you shortly. Please include the following:
      
      🔹 **What do you need help with?**  
      → Boss name, area, or type of assistance.
      
      🔹 **Game Info:**  
      • Region & Character Level  
      • Scadutree Blessing (for DLC help)  
      • NG+ Level
      
      🔹 **Multiplayer Setup:**  
      • Cross-Region: *Perform Matchmaking*  
      • In-Game Password (will be provided)  
      • Passwords are case-sensitive
      
      🔹 **After Help:**  
      Mention your helper **(@username)** in this ticket  
      and say **"thank you"** in the same message  
      → This gives them rep & unlocks new roles! 🎖️
      
      📌 **Example:**  
      \`\`\`
      Jhosenpai: PC, need help with Godskin Duo, level 118, Scadutree Blessing 4, NG+1.
      \`\`\`
      > After help:  
      Jhosenpai: thanks @helper_name.
      
      ⚠️ Please follow these steps for faster assistance.`
      )

      .setFooter({
        text: "🔹 The buttons below are for Active Helpers to manage this ticket.",
      });

    const sent = await ticketChannel.send({
      content: `<@${user.id}> <@&${platformHelperRoleId}>`,
      embeds: [ticketEmbed],
      components: [row],
    });

    // ⬇️ Save the message id on the ticket row (match by channel_id)
    db.run(
      "UPDATE tickets SET message_id = ? WHERE channel_id = ?",
      [sent.id, ticketChannel.id],
      (err) => {
        if (err) console.error("❌ Failed to store message_id:", err);
      }
    );

    console.log(`✅ Ticket embed successfully sent to ${ticketChannel.id}`);
  } catch (error) {
    console.error("❌ Error sending ticket embed:", error);
  }
}

async function createTicketChannel(guild, user, client, interaction) {
  const ticketChannel = await guild.channels.create({
    name: `ticket-${user.username}`,
    type: ChannelType.GuildText,
    parent: TICKET_CATEGORY_ID,
    permissionOverwrites: [
      {
        id: guild.id, // @everyone
        deny: [PermissionsBitField.Flags.ViewChannel],
      },
      {
        id: user.id, // Ticket creator
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
      {
        id: process.env.ACTIVE_HELPER_ROLE, // Active Helper role
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
      {
        id: process.env.TICKET_MODERATOR_ROLE, // Ticket Moderators
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageChannels,
        ],
      },
      {
        id: process.env.ELDEN_MODERATOR, // ✅ New role
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
      {
        id: process.env.ELDEN_ENFORCER, // ✅ New role
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
      {
        id: process.env.REPUTATION_BOT, // ✅ New role
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
      {
        id: process.env.BOTS, // ✅ New role
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
      {
        id: client.user.id, // The bot
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ManageChannels,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageMessages,
        ],
      },
    ],
  });

  // Update statistics after ticket channel creation
  // Record unique user creating the ticket
  addUniqueUser(user.id, (err) => {
    if (err) console.error("Error adding unique user:", err);
  });

  const platformMapping = {
    platform_ps: "PlayStation",
    platform_pc: "PC",
    platform_xbox: "Xbox",
    platform_switch: "Nintendo Switch",
  };

  const platformName = interaction?.customId
    ? platformMapping[interaction.customId] || "Unknown"
    : "Unknown";

  incrementTicketPlatform(platformName, (err) => {
    if (err) console.error("Error incrementing ticket platform count:", err);
  });

  return ticketChannel;
}

// Tracks channel IDs currently mid-close so a duplicate close (e.g. user
// clicks "I don't need help" the same instant a helper opens the close modal)
// doesn't race the channel delete + DB cleanup.
const closingChannelIds = new Set();

// Retry channel.delete() with backoff. Treats Discord 10003 ("Unknown Channel"
// — already deleted) as success, so a manually-deleted channel still finishes
// cleanup cleanly. Returns true on confirmed delete, false on exhaustion.
async function deleteChannelWithRetry(channel, ticketId) {
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    try {
      console.log(
        `🪦 Deleting ticket channel attempt #${i} (channel=${channel.id} ticketId=${ticketId})`
      );
      await channel.delete();
      console.log(
        `✅ Channel deleted (channel=${channel.id} ticketId=${ticketId}).`
      );
      return true;
    } catch (e) {
      const code = e && (e.code || (e.rawError && e.rawError.code));
      if (code === 10003) {
        console.log(
          `ℹ️ Channel already gone (channel=${channel.id} ticketId=${ticketId}) — treating as deleted.`
        );
        return true;
      }
      console.error(
        `⚠️ Channel delete attempt #${i} failed (channel=${channel.id} ticketId=${ticketId}): ${
          e.message || e
        }`
      );
      if (i < attempts) {
        await new Promise((r) => setTimeout(r, 1500 * i));
      }
    }
  }
  return false;
}

async function closeTicket({
  ticketChannel,
  closedBy,
  closureReason = "Closed by ticket opener (idle reminder button)",
  skipPermissionCheck = false,
  interaction, // may be undefined OR already deferred/replied
}) {
  // helper that safely responds exactly once for this interaction
  const respond = async (payload) => {
    try {
      if (!interaction) return;
      // If we already sent a reply: always follow up
      if (interaction.replied) return await interaction.followUp(payload);
      // If deferred (either deferReply or deferUpdate) but no reply yet,
      // prefer followUp() — editReply() is invalid for deferUpdate().
      if (interaction.deferred) return await interaction.followUp(payload);
      // Fresh interaction: first response
      return await interaction.reply(payload);
    } catch (_) {
      // swallow reply errors (expired token, channel deleted, etc.)
    }
  };

  const ticketChannelId = ticketChannel.id;
  const member = ticketChannel.guild.members.cache.get(closedBy.id);
  const isHelper = member?.roles.cache.has(process.env.ACTIVE_HELPER_ROLE);
  const isMod =
    member?.roles.cache.has(process.env.TICKET_MODERATOR_ROLE) ||
    member?.roles.cache.has(process.env.ELDEN_MODERATOR) ||
    member?.roles.cache.has(process.env.ELDEN_ENFORCER);

  if (!skipPermissionCheck && !isHelper && !isMod) {
    await respond({
      content: "❌ You don’t have permission to close this ticket directly.",
      flags: 64,
    });
    return;
  }

  // Category guard — refuse to act on anything outside TICKET_CATEGORY_ID so
  // we can NEVER accidentally close/delete a similarly-named `ticket-*`
  // channel from another category (e.g. a moderator-ticket channel).
  const expectedCategoryId = process.env.TICKET_CATEGORY_ID;
  if (!expectedCategoryId) {
    console.error(
      "❌ closeTicket refused: TICKET_CATEGORY_ID is not configured."
    );
    await respond({
      content:
        "❌ Server config missing TICKET_CATEGORY_ID — refusing to close.",
      flags: 64,
    });
    return;
  }
  if (ticketChannel.parentId !== expectedCategoryId) {
    console.error(
      `❌ closeTicket refused: channel=${ticketChannelId} name=${ticketChannel.name} parent=${ticketChannel.parentId} is NOT in ticket category ${expectedCategoryId}.`
    );
    await respond({
      content:
        "❌ This channel isn't in the ticket category — refusing to close to prevent accidental deletion of an unrelated ticket-named channel.",
      flags: 64,
    });
    return;
  }

  // Concurrency guard — block a duplicate close on the same channel.
  if (closingChannelIds.has(ticketChannelId)) {
    console.log(
      `↩️ closeTicket: already closing channel=${ticketChannelId} — duplicate ignored.`
    );
    await respond({
      content: "⌛ This ticket is already being closed — please wait.",
      flags: 64,
    });
    return;
  }
  closingChannelIds.add(ticketChannelId);

  try {
    await new Promise((resolveOuter) => {
      db.get(
        "SELECT * FROM tickets WHERE channel_id = ?",
        [ticketChannelId],
        async (err, ticket) => {
          try {
            if (err || !ticket) {
              console.error("❌ Error fetching ticket data:", err);
              await respond({
                content: "❌ This ticket is not registered in the database.",
                flags: 64,
              });
              return;
            }

            console.log(
              `🔻 Closing ticket id=${ticket.id} channel=${ticketChannelId} (closedBy=${closedBy.username}, reason="${closureReason}")`
            );

            // --- gather transcript (best-effort) ---
            let messages = [];
            try {
              messages = await fetchAllMessages(ticketChannel);
            } catch (fetchError) {
              console.error(
                "❌ Error fetching messages for transcript:",
                fetchError
              );
            }

            const formattedMessages = messages.map((msg) => ({
              user_id: msg.author.id,
              username: msg.author.username,
              avatar: msg.author.displayAvatarURL?.({ dynamic: true }),
              content:
                msg.content?.trim() ||
                (msg.attachments.size
                  ? "(Image/GIF attached)"
                  : "(No content)"),
              timestamp: msg.createdTimestamp,
              attachments: msg.attachments.size
                ? JSON.stringify(
                    [...msg.attachments.values()].map((a) => a.proxyURL)
                  )
                : null,
              embeds: msg.embeds.length
                ? JSON.stringify(msg.embeds.map((e) => e.toJSON()))
                : null,
              reactions: msg.reactions.cache.size
                ? JSON.stringify(
                    msg.reactions.cache.map((r) => ({
                      emoji: r.emoji.name,
                      count: r.count,
                    }))
                  )
                : null,
            }));

            const transcriptId = `transcript_${Date.now()}`;

            // --- write transcript header (with error logging) ---
            db.run(
              `INSERT INTO transcripts
               (id, ticket_id, user_id, username, closed_by, closed_by_username, closure_reason, created_at, closed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                transcriptId,
                ticket.id,
                ticket.user_id,
                ticket.username,
                closedBy.id,
                closedBy.username,
                closureReason,
                ticket.created_at,
                new Date().toISOString(),
              ],
              (e) => {
                if (e)
                  console.error("❌ Failed to write transcript header:", e);
              }
            );

            // --- write transcript messages (with error logging) ---
            for (const msg of formattedMessages) {
              db.run(
                `INSERT INTO transcript_messages
                 (transcript_id, user_id, username, avatar_url, message, timestamp, attachment_url, embed_data, reactions)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  transcriptId,
                  msg.user_id,
                  msg.username,
                  msg.avatar,
                  encryptText(msg.content),
                  msg.timestamp,
                  msg.attachments,
                  msg.embeds,
                  msg.reactions,
                ],
                (e) => {
                  if (e)
                    console.error(
                      "❌ Failed to write transcript message:",
                      e.message || e
                    );
                }
              );
            }
            console.log(
              `📜 Wrote transcript ${transcriptId} (${formattedMessages.length} messages) for ticket id=${ticket.id}.`
            );

            const transcriptUrl = `${process.env.TRANSCRIPT_BASE_URL}/${transcriptId}`;
            const formatTimestamp = (iso) =>
              `<t:${Math.floor(new Date(iso).getTime() / 1000)}:F>`;

            // --- log embed ---
            const embed = new EmbedBuilder()
              .setColor(0xff0000)
              .setTitle("🎟️ Ticket Closed")
              .addFields(
                { name: "📄 Ticket ID", value: `${ticket.id}`, inline: true },
                {
                  name: "✅ Opened By",
                  value: `<@${ticket.user_id}>`,
                  inline: true,
                },
                {
                  name: "🔴 Closed By",
                  value: `<@${closedBy.id}>`,
                  inline: true,
                },
                { name: "📝 Reason", value: closureReason },
                {
                  name: "📅 Date Created",
                  value: formatTimestamp(ticket.created_at),
                  inline: true,
                },
                {
                  name: "📅 Date Closed",
                  value: formatTimestamp(new Date().toISOString()),
                  inline: true,
                }
              );

            if (ticket.claimed_by) {
              embed.addFields({
                name: "🎯 Claimed By",
                value: `<@${ticket.claimed_by}>`,
                inline: true,
              });
            }

            const row = new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setLabel("📜 View Online Transcript")
                .setStyle(ButtonStyle.Link)
                .setURL(transcriptUrl)
            );

            // --- send to logs channel (best-effort) ---
            const logsChannel = ticketChannel.guild.channels.cache.get(
              process.env.TRANSCRIPT_CHANNEL_ID
            );
            try {
              if (logsChannel)
                await logsChannel.send({ embeds: [embed], components: [row] });
            } catch (e) {
              console.error("⚠️ Could not post transcript log:", e);
            }

            // Mark closed BEFORE attempting the channel delete, so the row is
            // out of `status='open'` queries (idle check, dashboard) even if
            // the channel delete fails and we have to leave the row behind.
            db.run(
              `UPDATE tickets SET status = 'closed' WHERE id = ?`,
              [ticket.id],
              (e) => {
                if (e)
                  console.error(
                    "❌ Failed to mark ticket closed before delete:",
                    e
                  );
              }
            );

            // Attempt channel delete with retries. ONLY remove the DB row
            // after a confirmed delete — this is what makes the "row gone,
            // channel orphaned" production bug impossible. On exhaustion the
            // row stays as status='closed' so `/delete` (or a future
            // reconciler) can finish the cleanup safely.
            const deleted = await deleteChannelWithRetry(
              ticketChannel,
              ticket.id
            );

            if (deleted) {
              db.run(
                `DELETE FROM tickets WHERE id = ?`,
                [ticket.id],
                (e) => {
                  if (e)
                    console.error(
                      "❌ Failed to delete ticket row after channel delete:",
                      e
                    );
                  else
                    console.log(
                      `🗑️ DB row removed for ticket id=${ticket.id}.`
                    );
                }
              );
              // No interaction reply on success: the channel was just deleted,
              // so the interaction's webhook target is gone and any followUp
              // would just error out (swallowed). The disappearing channel is
              // the user's confirmation; the embed sent to TRANSCRIPT_CHANNEL_ID
              // above is the staff-visible record.
              console.log(
                `✅ Ticket id=${ticket.id} closed; channel ${ticketChannelId} removed.`
              );
            } else {
              console.error(
                `❌ Channel ${ticketChannelId} could not be deleted after retries — DB row kept (status='closed') for recovery via /delete.`
              );
              await respond({
                content:
                  "⚠️ Transcript saved and ticket marked closed, but the channel could not be deleted automatically. Please run `/delete` to finish removing it.",
                flags: 64,
              });
            }
          } catch (innerErr) {
            console.error("❌ closeTicket flow error:", innerErr);
            try {
              await respond({
                content: "❌ Error during ticket close.",
                flags: 64,
              });
            } catch {}
          } finally {
            resolveOuter();
          }
        }
      );
    });
  } finally {
    closingChannelIds.delete(ticketChannelId);
  }
}
