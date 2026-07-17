const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");
const { db } = require("../database");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("remove")
    .setDescription("Remove a helper from the current ticket.")
    .addUserOption((option) =>
      option
        .setName("user")
        .setDescription("The helper to remove")
        .setRequired(true)
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageChannels),

  async execute(interaction) {
    const remover = interaction.member;
    const target = interaction.options.getMember("user");
    const channel = interaction.channel;

    // ✅ Check channel type
    if (
      channel.type !== ChannelType.GuildText ||
      !channel.name.startsWith("ticket-")
    ) {
      return interaction.reply({
        content: "❌ This command can only be used inside a ticket channel.",
        ephemeral: true,
      });
    }

    // ✅ Check for role permissions (adjust role IDs as needed)
    const hasPermission =
      remover.roles.cache.has(process.env.ELDEN_MODERATOR) ||
      remover.roles.cache.has(process.env.TICKET_MODERATOR_ROLE);

    if (!hasPermission) {
      return interaction.reply({
        content: "❌ You don't have permission to remove members from tickets.",
        ephemeral: true,
      });
    }

    // ✅ Check if target is actually in the channel
    const member = await interaction.guild.members
      .fetch(target.id)
      .catch(() => null);
    if (!member) {
      return interaction.reply({
        content: "❌ Could not find that member in the server.",
        ephemeral: true,
      });
    }

    const ticketId = channel.id;

    try {
      await channel.permissionOverwrites.edit(target.id, {
        ViewChannel: false,
        SendMessages: false,
        ReadMessageHistory: false,
      });

      await interaction.reply({
        content: `✅ <@${target.id}> has been removed from this ticket.`,
      });

      // Optional: log this to a modlog or database
      console.log(
        `🔻 ${target.user.tag} removed from ${channel.name} by ${remover.user.tag}`
      );
    } catch (err) {
      console.error("❌ Error removing user from ticket:", err);
      await interaction.reply({
        content:
          "❌ Failed to update permissions. Check bot permissions or role hierarchy.",
        ephemeral: true,
      });
    }
  },
};
