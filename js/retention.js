// Account-level message retention settings. Saved messages survive cleanup.
import { db, doc, getDoc, updateDoc, serverTimestamp, writeBatch, arrayUnion } from "./firebase.js";

const RETENTION_KEY = "cunnact_retention_mode";
const DEFAULT_RETENTION = "24hours";
let retentionMode = localStorage.getItem(RETENTION_KEY) || DEFAULT_RETENTION;
const validMode = (m) => m === "off" || m === "seen" || m === "24hours";

export function getRetentionMode() { return validMode(retentionMode) ? retentionMode : DEFAULT_RETENTION; }

export async function loadRetentionMode(uid) {
  if (!uid) return getRetentionMode();
  try {
    const snap = await getDoc(doc(db, "userSettings", uid));
    const remote = snap.exists() ? snap.data()?.retentionMode : null;
    if (validMode(remote)) retentionMode = remote;
  } catch (e) { console.warn("Could not load retention mode", e); }
  localStorage.setItem(RETENTION_KEY, getRetentionMode());
  return getRetentionMode();
}

export async function setRetentionMode(mode, uid = null) {
  if (!validMode(mode)) throw new Error("Invalid retention mode");
  retentionMode = mode;
  localStorage.setItem(RETENTION_KEY, mode);
  if (uid) await setUserSetting(uid, { retentionMode: mode });
}

export async function setUserSetting(uid, fields) {
  if (!uid) return;
  await updateDoc(doc(db, "userSettings", uid), { ...fields, updatedAt: serverTimestamp() }).catch(async (e) => {
    if (e?.code === "not-found") {
      const ref = doc(db, "userSettings", uid);
      const { setDoc } = await import("./firebase.js");
      await setDoc(ref, { ...fields, updatedAt: serverTimestamp() }, { merge: true });
    } else throw e;
  });
}

export function isSavedByUser(message, uid) {
  const s = message?.savedBy;
  if (Array.isArray(s)) return s.includes(uid);
  if (s && typeof s === "object") return s[uid] === true;
  return false;
}
export function isDeletedForUser(message, uid) {
  const d = message?.deletedFor;
  if (Array.isArray(d)) return d.includes(uid);
  if (d && typeof d === "object") return d[uid] === true;
  return false;
}
export function shouldExpireMessage(message, uid) {
  if (!message || isDeletedForUser(message, uid) || isSavedByUser(message, uid)) return false;
  const explicitExpiry = message.expiresAt?.toDate?.() || (message.expiresAt instanceof Date ? message.expiresAt : null);
  if (explicitExpiry && Date.now() >= explicitExpiry.getTime()) return true;
  if (getRetentionMode() === "off") return false;
  if (getRetentionMode() === "24hours") {
    const created = message.createdAt?.toDate?.();
    return !!created && (Date.now() - created.getTime() >= 24 * 60 * 60 * 1000);
  }
  const readBy = message.readBy;
  return !!(readBy && typeof readBy === "object" && readBy[uid]);
}
export async function cleanupExpiredMessages(dbArg, conversationId, messages, uid) {
  const expired = messages.filter(m => shouldExpireMessage(m, uid));
  for (let i=0;i<expired.length;i+=450) {
    const batch = writeBatch(dbArg);
    expired.slice(i,i+450).forEach(m => batch.update(doc(dbArg,"conversations",conversationId,"messages",m.id), { deletedFor: arrayUnion(uid) }));
    try { await batch.commit(); } catch (e) { console.warn("Retention cleanup failed", e); }
  }
  return expired.length;
}
export function startPeriodicCleanup(dbArg, conversationId, getMessages, uid) {
  const interval = setInterval(() => { const messages=getMessages?.()||[]; if(messages.length) cleanupExpiredMessages(dbArg,conversationId,messages,uid).catch(()=>{}); }, 5*60*1000);
  return () => clearInterval(interval);
}
export function calculateExpirationTime(createdAt){const d=createdAt?.toDate?.();return d?new Date(d.getTime()+86400000):null;}
export function formatTimeRemaining(date){if(!date)return null;const diff=date.getTime()-Date.now();if(diff<=0)return "Expired";const h=Math.floor(diff/3600000),m=Math.floor(diff%3600000/60000);return h?`${h}h ${m}m`:`${m}m`;}
