const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

require("dotenv").config();

module.exports = {
  data: new SlashCommandBuilder()
    .setName("platformroles")
    .setDescription("Send the platform helper role embed (Admin only)"),

  async execute(interaction) {
    const guildMember = await interaction.guild.members.fetch(
      interaction.user.id
    );

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

    // Nintendo Switch is only offered when the flag is on AND its helper role
    // ID is configured (mirrors the gating used in the ticket flow).
    const switchEnabled =
      String(process.env.SWITCH_ENABLED).toLowerCase() === "true" &&
      !!process.env.PLATFORM_HELPER_SWITCH &&
      !!process.env.GENERAL_SWITCH_ROLE;

    let rolesLine =
      `\n\n**Roles Available:**\n<:pc:1221674297194168321> <@&${process.env.PLATFORM_HELPER_PC}>  |  ` +
      `<:ps:1221674284870463539> <@&${process.env.PLATFORM_HELPER_PS}>  |  ` +
      `<:xbox:1221674292757325824> <@&${process.env.PLATFORM_HELPER_XBOX}>`;
    if (switchEnabled) {
      rolesLine += `  |  Switch <@&${process.env.PLATFORM_HELPER_SWITCH}>`;
    }

    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("🎮 Platform Helper Ping Roles")
      .setDescription(
        `Want to get notified when a platform-specific help ticket is created?\n\n` +
          `Click the buttons below to **toggle your platform helper roles**.\nYou'll get pinged when a ticket for that platform is opened.` +
          rolesLine
      )
      .setFooter({
        text: "Click again to remove the role and stop receiving notifications.",
      });

    const roleButtons = [
      new ButtonBuilder()
        .setCustomId("platformrole_pc")
        .setEmoji("<:steam_pr:958049880188805220>")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("platformrole_ps")
        .setEmoji("<:ps:972112725448724480>")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId("platformrole_xbox")
        .setEmoji("<:xbox_round:972112725352276018>")
        .setStyle(ButtonStyle.Primary),
    ];

    if (switchEnabled) {
      roleButtons.push(
        new ButtonBuilder()
          .setCustomId("platformrole_switch")
          .setLabel("Switch")
          .setEmoji("<:Switch:1505721877044396052>")
          .setStyle(ButtonStyle.Primary)
      );
    }

    const row = new ActionRowBuilder().addComponents(...roleButtons);

    await interaction.reply({ embeds: [embed], components: [row] });
  },
};
