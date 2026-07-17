const { SlashCommandBuilder } = require("discord.js");
const { cooldowns } = require("../events/aiMessageHandler");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("resetcooldowns")
    .setDescription("Reset AI cooldowns for all users."),

  async execute(interaction) {
    const guildMember = await interaction.guild.members.fetch(
      interaction.user.id
    );
    const allowedRoles = [
      process.env.ELDER_TICKET_MODERATOR_ROLE,
      process.env.ELDEN_MODERATOR,
      process.env.ELDEN_ENFORCER,
      process.env.TICKET_MODERATOR_ROLE,
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

    cooldowns.clear();
    await interaction.reply({
      content: "✅ AI cooldowns have been reset for all users.",
      flags: 64,
    });
  },
};
