const { db } = require("./database.js");

function clearConversationHistory(ticketId) {
  return new Promise((resolve, reject) => {
    db.run(
      "DELETE FROM conversation_history WHERE ticket_id = ?",
      [ticketId],
      (err) => {
        if (err) {
          console.error(
            `❌ Error clearing history for ticket ${ticketId}:`,
            err
          );
          return reject(err);
        }
        console.log(`🧹 Conversation history cleared for ticket ${ticketId}`);
        resolve();
      }
    );
  });
}

module.exports = clearConversationHistory;
