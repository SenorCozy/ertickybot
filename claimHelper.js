const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");

// Track the latest "quick-unclaim" message by channel
const activeQuickUnclaimButtons = Object.create(null);

function buildQuickUnclaimRow(channelId, userId, disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`unclaim_ticket_${channelId}_${userId}_quick`)
      .setLabel("🔓 Unclaim Ticket")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!!disabled)
  );
}

async function disableQuickUnclaimIfAny(channel, channelId) {
  const quickId = activeQuickUnclaimButtons[channelId];
  if (!quickId) return;
  try {
    const quickMsg = await channel.messages.fetch(quickId);
    const disabledRow = buildQuickUnclaimRow(channelId, "0", true);
    await quickMsg.edit({ components: [disabledRow] });
  } catch {
    // Ignore if deleted or already gone
  }
  delete activeQuickUnclaimButtons[channelId];
}

function buildClaimRow(channelId, claimedBy) {
  const row = new ActionRowBuilder();

  if (claimedBy) {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`unclaim_ticket_${channelId}_${claimedBy}`)
        .setLabel("🔓 Unclaim Ticket")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`close_ticket_${channelId}`)
        .setLabel("❌ Close Ticket with Reason")
        .setStyle(ButtonStyle.Danger)
    );
  } else {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`claim_ticket_${channelId}`)
        .setLabel("✅ Claim Ticket")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`close_ticket_${channelId}`)
        .setLabel("❌ Close Ticket with Reason")
        .setStyle(ButtonStyle.Danger)
    );
  }

  return row;
}

module.exports = {
  buildClaimRow,
  buildQuickUnclaimRow,
  disableQuickUnclaimIfAny,
  activeQuickUnclaimButtons,
};
