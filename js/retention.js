// Message retention system for CUNNACT
// Handles message expiration and saved messages

const RETENTION_KEY = "cunnact_retention_mode";
const DEFAULT_RETENTION = "24hours"; // "seen" or "24hours"

export function getRetentionMode() {
  return localStorage.getItem(RETENTION_KEY) || DEFAULT_RETENTION;
}

export function setRetentionMode(mode) {
  if (mode !== "seen" && mode !== "24hours") {
    throw new Error("Invalid retention mode");
  }
  localStorage.setItem(RETENTION_KEY, mode);
}

export function shouldExpireMessage(message, currentUserId) {
  // Never expire saved messages
  if (message.savedBy && message.savedBy.includes(currentUserId)) {
    return false;
  }
  
  const mode = getRetentionMode();
  const now = new Date();
  
  if (mode === "24hours") {
    // Expire if 24 hours have passed since creation
    if (message.createdAt && message.createdAt.toDate) {
      const createdDate = message.createdAt.toDate();
      const hoursPassed = (now - createdDate) / (1000 * 60 * 60);
      return hoursPassed >= 24;
    }
  } else if (mode === "seen") {
    // Expire if the recipient has read it
    if (message.readBy && message.readBy[currentUserId]) {
      return true;
    }
  }
  
  return false;
}

export async function cleanupExpiredMessages(db, conversationId, messages, currentUserId, deleteDoc) {
  const toDelete = [];
  
  for (const msg of messages) {
    if (shouldExpireMessage(msg, currentUserId)) {
      toDelete.push(msg.id);
    }
  }
  
  // Delete expired messages
  for (const msgId of toDelete) {
    try {
      const { doc } = await import("./firebase.js");
      await deleteDoc(doc(db, "conversations", conversationId, "messages", msgId));
    } catch (error) {
      console.warn("Failed to delete expired message:", msgId, error);
    }
  }
  
  return toDelete.length;
}

export function calculateExpirationTime(createdAt) {
  if (!createdAt || !createdAt.toDate) return null;
  
  const created = createdAt.toDate();
  const expiry = new Date(created.getTime() + 24 * 60 * 60 * 1000);
  return expiry;
}

export function formatTimeRemaining(expiryDate) {
  if (!expiryDate) return null;
  
  const now = new Date();
  const diff = expiryDate - now;
  
  if (diff <= 0) return "Expired";
  
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

// Periodic cleanup - runs every 5 minutes
export function startPeriodicCleanup(db, conversationId, getMessages, currentUserId, deleteDoc) {
  const interval = setInterval(async () => {
    try {
      const messages = getMessages();
      if (messages && messages.length > 0) {
        await cleanupExpiredMessages(db, conversationId, messages, currentUserId, deleteDoc);
      }
    } catch (error) {
      console.warn("Periodic cleanup failed:", error);
    }
  }, 5 * 60 * 1000); // Every 5 minutes
  
  return () => clearInterval(interval);
}
