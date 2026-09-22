// Account-level message retention settings + per-user cleanup.
// Expired/seen messages are hidden only for the user whose copy has expired.
// Saved messages remain visible to the user who saved them.

import { db, doc, getDoc, updateDoc, serverTimestamp, writeBatch, arrayUnion } from "./firebase.js";

const RETENTION_KEY = "cunnact_retention_mode";
const DEFAULT_RETENTION = "24hours";
let retentionMode = localStorage.getItem(RETENTION_KEY) || DEFAULT_RETENTION;

function validMode(mode) {
  return mode === "seen" || mode === "24hours";
}

export function getRetentionMode() {
  return validMode(retentionMode) ? retentionMode : DEFAULT_RETENTION;
}

export async function loadRetentionMode(uid) {
  if (!uid) return getRetentionMode();
  try {
    const snap = await getDoc(doc(db, "users", uid));
    const remote = snap.exists() ? snap.data().retentionMode : null;
    if (validMode(remote)) retentionMode = remote;
  } catch (error) {
    console.warn("Could not load retention mode:", error);
  }
  localStorage.setItem(RETENTION_KEY, getRetentionMode());
  return getRetentionMode();
}

export async function setRetentionMode(mode, uid = null) {
  if (!validMode(mode)) throw new Error("Invalid retention mode");
  retentionMode = mode;
  localStorage.setItem(RETENTION_KEY, mode);

  if (uid) {
    await updateDoc(doc(db, "users", uid), {
      retentionMode: mode,
      updatedAt: serverTimestamp()
    });
  }
}

export function isSavedByUser(message, currentUserId) {
  const savedBy = message?.savedBy;
  if (Array.isArray(savedBy)) return savedBy.includes(currentUserId);
  if (savedBy && typeof savedBy === "object") return savedBy[currentUserId] === true;
  return false;
}

export function isDeletedForUser(message, currentUserId) {
  const deletedFor = message?.deletedFor;
  if (Array.isArray(deletedFor)) return deletedFor.includes(currentUserId);
  if (deletedFor && typeof deletedFor === "object") return deletedFor[currentUserId] === true;
  return false;
}

export function shouldExpireMessage(message, currentUserId) {
  if (!message || isDeletedForUser(message, currentUserId)) return false;
  if (isSavedByUser(message, currentUserId)) return false;

  if (getRetentionMode() === "24hours") {
    const created = message.createdAt?.toDate ? message.createdAt.toDate() : null;
    if (!created) return false;
    return Date.now() - created.getTime() >= 24 * 60 * 60 * 1000;
  }

  if (getRetentionMode() === "seen") {
    const readBy = message.readBy;
    return !!(readBy && typeof readBy === "object" && readBy[currentUserId]);
  }

  return false;
}

export async function cleanupExpiredMessages(dbArg, conversationId, messages, currentUserId, updateDocArg) {
  const toExpire = messages.filter((msg) =>
    shouldExpireMessage(msg, currentUserId) && !isDeletedForUser(msg, currentUserId)
  );
  if (!toExpire.length) return 0;

  let count = 0;
  for (let i = 0; i < toExpire.length; i += 450) {
    const chunk = toExpire.slice(i, i + 450);
    try {
      const batch = writeBatch(dbArg);
      chunk.forEach((msg) => {
        batch.update(
          doc(dbArg, "conversations", conversationId, "messages", msg.id),
          { deletedFor: arrayUnion(currentUserId) }
        );
      });
      await batch.commit();
      count += chunk.length;
    } catch (error) {
      console.warn("Failed to expire a batch of messages:", error);
    }
  }
  return count;
}

export function calculateExpirationTime(createdAt) {
  if (!createdAt?.toDate) return null;
  return new Date(createdAt.toDate().getTime() + 24 * 60 * 60 * 1000);
}

export function formatTimeRemaining(expiryDate) {
  if (!expiryDate) return null;
  const diff = expiryDate.getTime() - Date.now();
  if (diff <= 0) return "Expired";
  const hours = Math.floor(diff / 3600000);
  const minutes = Math.floor((diff % 3600000) / 60000);
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

export function startPeriodicCleanup(dbArg, conversationId, getMessages, currentUserId, updateDocArg) {
  const interval = setInterval(async () => {
    try {
      const messages = getMessages?.() || [];
      if (messages.length) {
        await cleanupExpiredMessages(dbArg, conversationId, messages, currentUserId, updateDocArg);
      }
    } catch (error) {
      console.warn("Periodic cleanup failed:", error);
    }
  }, 5 * 60 * 1000);

  return () => clearInterval(interval);
}
