const { SlashCommandBuilder } = require("@discordjs/builders");
const { getStats } = require("../database");

require("dotenv").config();

module.exports = {
  data: new SlashCommandBuilder()
    .setName("stats")
    .setDescription("View ticket statistics (Active Helpers only)."),

  async execute(interaction) {
    // Fetch user information
    const guildMember = await interaction.guild.members.fetch(
      interaction.user.id
    );

    // ✅ Restrict access to users with the "Active Helper" role
    if (!guildMember.roles.cache.has(process.env.ACTIVE_HELPER_ROLE)) {
      return interaction.reply({
        content: "❌ You need the 'Active Helper' role to use this command.",
        flags: 64, // Ephemeral message
      });
    }

    await interaction.deferReply({ flags: 64 });

    getStats((err, stats) => {
      if (err) {
        console.error("❌ Error fetching stats:", err);
        return interaction.editReply("❌ Failed to fetch statistics.");
      }

      const { uniqueUserCount, platformStats, totalTicketCount } = stats;

      let platformText =
        platformStats.length > 0
          ? platformStats
              .map((ps) => `**${ps.platform}:** ${ps.ticket_count}`)
              .join("\n")
          : "No tickets recorded yet.";

      const embed = {
        color: 0x0099ff,
        title: "📊 Ticket Statistics",
        fields: [
          {
            name: "👥 Unique Ticket Creators",
            value: uniqueUserCount.toString(),
            inline: true,
          },
          {
            name: "📈 Total Tickets Created",
            value: totalTicketCount.toString(),
            inline: true,
          },
          {
            name: "🎮 Tickets per Platform",
            value: platformText,
            inline: false,
          },
        ],
        footer: { text: "Ticket bot statistics" },
      };

      interaction.editReply({ embeds: [embed] });
    });
  },
};
