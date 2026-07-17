const { SlashCommandBuilder, PermissionsBitField } = require("discord.js");
const { db } = require("../database");

require("dotenv").config();

module.exports = {
  data: new SlashCommandBuilder()
    .setName("blacklist")
    .setDescription("Blacklist or remove users from the ticket system.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("add")
        .setDescription("Add a user to the blacklist")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("The user to blacklist")
            .setRequired(true)
        )
        .addStringOption((option) =>
          option
            .setName("reason")
            .setDescription("Reason for blacklisting (optional)")
            .setRequired(false)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("remove")
        .setDescription("Remove a user from the blacklist")
        .addUserOption((option) =>
          option
            .setName("user")
            .setDescription("The user to remove from the blacklist")
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    try {
      const guildMember = await interaction.guild.members.fetch(
        interaction.user.id
      );

      // ✅ Restrict command to Elder Ticket Moderators
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

      const subcommand = interaction.options.getSubcommand();
      const targetUser = interaction.options.getUser("user");

      if (subcommand === "add") {
        const reason =
          interaction.options.getString("reason") || "No reason provided.";

        db.get(
          "SELECT * FROM blacklist WHERE user_id = ?",
          [targetUser.id],
          (err, row) => {
            if (err) {
              console.error("❌ Database error checking blacklist:", err);
              return interaction.reply({
                content: "❌ An error occurred while checking the blacklist.",
                flags: 64,
              });
            }

            if (row) {
              return interaction.reply({
                content: `⚠️ <@${targetUser.id}> is already blacklisted.`,
                flags: 64,
              });
            }

            db.run(
              "INSERT INTO blacklist (user_id, username, reason) VALUES (?, ?, ?)",
              [targetUser.id, targetUser.username, reason],
              (err) => {
                if (err) {
                  console.error("❌ Database error adding to blacklist:", err);
                  return interaction.reply({
                    content: "❌ Failed to add user to the blacklist.",
                    flags: 64,
                  });
                }

                interaction.reply({
                  content: `✅ <@${targetUser.id}> has been blacklisted.\n**Reason:** ${reason}`,
                });
              }
            );
          }
        );
      } else if (subcommand === "remove") {
        db.get(
          "SELECT * FROM blacklist WHERE user_id = ?",
          [targetUser.id],
          (err, row) => {
            if (err) {
              console.error("❌ Database error checking blacklist:", err);
              return interaction.reply({
                content: "❌ An error occurred while checking the blacklist.",
                flags: 64,
              });
            }

            if (!row) {
              return interaction.reply({
                content: `⚠️ <@${targetUser.id}> is not on the blacklist.`,
                flags: 64,
              });
            }

            db.run(
              "DELETE FROM blacklist WHERE user_id = ?",
              [targetUser.id],
              (err) => {
                if (err) {
                  console.error(
                    "❌ Database error removing from blacklist:",
                    err
                  );
                  return interaction.reply({
                    content: "❌ Failed to remove user from the blacklist.",
                    flags: 64,
                  });
                }

                interaction.reply({
                  content: `✅ <@${targetUser.id}> has been removed from the blacklist.`,
                });
              }
            );
          }
        );
      }
    } catch (error) {
      console.error("❌ Unexpected error in /blacklist command:", error);
      return interaction.reply({
        content:
          "❌ An unexpected error occurred while processing your request.",
        flags: 64,
      });
    }
  },
};
