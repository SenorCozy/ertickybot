const { Client, GatewayIntentBits, Collection } = require("discord.js");
require("dotenv").config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
});

// ✅ Initialize Collections
client.commands = new Collection();
client.buttons = new Collection();
client.modals = new Collection();

// ✅ Create a Promise That Resolves When the Bot is Fully Ready
let resolveReady;
const readyPromise = new Promise((resolve) => {
  resolveReady = resolve;
});

client.once("ready", () => {
  console.log("✅ Bot is ready!");
  resolveReady(true);
});

client.isBotReady = () => client.user !== null; // ✅ Checks if bot is actually logged in

module.exports = { client, readyPromise };
