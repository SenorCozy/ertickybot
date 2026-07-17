const {
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require("discord.js");

require("dotenv").config();

module.exports = {
  data: new SlashCommandBuilder()
    .setName("start")
    .setDescription(
      "Starts the ticket creation process (Ticket Moderators only)."
    ),

  async execute(interaction) {
    const guildMember = await interaction.guild.members.fetch(
      interaction.user.id
    );

    // ✅ Restrict access to specific roles
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

    // ✅ Embed with enhanced formatting and emojis
    const embed = new EmbedBuilder()
      .setColor(0x5865f2) // Discord blurple
      .setTitle("🎮 Need Help With a Boss or an Area?")
      .setDescription(
        "**Click the button below** to open a game request ticket.\n" +
          "Our **Elden Ring Helpers** can assist with:\n\n" +
          "• 🧱 Area navigation\n" +
          "• 👑 Boss fights\n" +
          "• ❓ General in-game help"
      )
      .setFooter({ text: "Your journey awaits, Tarnished." })
      .setTimestamp();

    const createTicketButton = new ButtonBuilder()
      .setCustomId("create_ticket")
      .setLabel("📝 Open Game Help Ticket")
      .setStyle(ButtonStyle.Success);

    const row = new ActionRowBuilder().addComponents(createTicketButton);

    await interaction.reply({
      embeds: [embed],
      components: [row],
    });
  },
};
