import { app, db, doc, getDoc, setDoc, updateDoc, arrayUnion, arrayRemove, serverTimestamp } from "./firebase.js";
import { firebaseConfig } from "./firebase-config.js";
import { showToast } from "./toast.js";

const STORAGE_KEY = "cunnact_notification_settings";
const ENABLED_KEY = "cunnact_browser_notifications";
export const DEFAULT_NOTIFICATION_SETTINGS = Object.freeze({
  banner: true,
  badge: true,
  messages: true,
  groups: true,
  status: true,
  calls: true,
  previews: true,
  outgoingSound: false
});

let settings = { ...DEFAULT_NOTIFICATION_SETTINGS };
let messaging = null;
let serviceWorkerRegistration = null;
let foregroundUnsub = null;
let currentUid = null;

function sanitizeSettings(value = {}) {
  const next = { ...DEFAULT_NOTIFICATION_SETTINGS };
  Object.keys(next).forEach(key => {
    if (typeof value?.[key] === "boolean") next[key] = value[key];
  });
  return next;
}

export function getNotificationSettings() { return { ...settings }; }

export function applyNotificationSettings(value = {}) {
  settings = sanitizeSettings(value);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  return getNotificationSettings();
}

export async function loadNotificationSettings(uid) {
  let remote = {};
  if (uid) {
    try {
      const snap = await getDoc(doc(db, "userSettings", uid));
      remote = snap.exists() ? (snap.data()?.notificationSettings || {}) : {};
    } catch (e) { console.warn("Could not load notification settings", e); }
  }
  let local = {};
  try { local = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}"); } catch {}
  applyNotificationSettings({ ...local, ...remote });
  currentUid = uid || currentUid;
  return getNotificationSettings();
}

export async function saveNotificationSettings(uid, patch = {}) {
  const next = applyNotificationSettings({ ...settings, ...patch });
  if (uid) {
    await setDoc(doc(db, "userSettings", uid), {
      notificationSettings: next,
      updatedAt: serverTimestamp()
    }, { merge: true });
    currentUid = uid;
  }
  return next;
}

export function notificationsSupported() {
  return window.isSecureContext && "Notification" in window;
}

export function browserNotificationsAreEnabled() {
  return notificationsSupported() && Notification.permission === "granted" && localStorage.getItem(ENABLED_KEY) === "true";
}

export async function requestBrowserNotifications(user) {
  if (!notificationsSupported()) throw new Error("Browser notifications are not supported here. Use HTTPS in a supported browser.");
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "Browser notification permission is blocked. Allow notifications for CUNNACT in your browser settings." : "Notification permission was not granted.");
  localStorage.setItem(ENABLED_KEY, "true");
  currentUid = user?.uid || currentUid;
  if (user?.uid) await setDoc(doc(db, "users", user.uid), { browserNotificationsEnabled: true, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
  await attachOptionalFcm(user).catch(() => {});
  return true;
}

export async function disableBrowserNotifications(user) {
  localStorage.removeItem(ENABLED_KEY);
  foregroundUnsub?.(); foregroundUnsub = null;
  if (user?.uid) await setDoc(doc(db, "users", user.uid), { browserNotificationsEnabled: false, updatedAt: serverTimestamp() }, { merge: true }).catch(() => {});
  try {
    const client = await getMessagingClient();
    const registration = serviceWorkerRegistration || await registerServiceWorker();
    const { getToken, deleteToken } = await import("https://www.gstatic.com/firebasejs/12.1.0/firebase-messaging.js");
    if (firebaseConfig.messagingVapidKey && !firebaseConfig.messagingVapidKey.startsWith("YOUR_")) {
      const token = await getToken(client, { vapidKey: firebaseConfig.messagingVapidKey, serviceWorkerRegistration: registration }).catch(() => "");
      if (token && user?.uid) await updateDoc(doc(db, "users", user.uid), { fcmTokens: arrayRemove(token) }).catch(() => {});
      await deleteToken(client).catch(() => {});
    }
  } catch {}
}

async function supportedFcm() {
  if (!window.isSecureContext || !("serviceWorker" in navigator) || !("Notification" in window)) return false;
  try {
    const { isSupported } = await import("https://www.gstatic.com/firebasejs/12.1.0/firebase-messaging.js");
    return await isSupported();
  } catch { return false; }
}

async function getMessagingClient() {
  if (messaging) return messaging;
  const { getMessaging } = await import("https://www.gstatic.com/firebasejs/12.1.0/firebase-messaging.js");
  messaging = getMessaging(app);
  return messaging;
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) throw new Error("Service workers are not supported by this browser.");
  serviceWorkerRegistration = await navigator.serviceWorker.register("/firebase-messaging-sw.js", { scope: "/" });
  return serviceWorkerRegistration;
}

async function attachOptionalFcm(user) {
  if (!user?.uid || !browserNotificationsAreEnabled()) return false;
  if (!firebaseConfig.messagingVapidKey || firebaseConfig.messagingVapidKey.startsWith("YOUR_")) return false;
  if (!(await supportedFcm())) return false;
  try {
    const registration = await registerServiceWorker();
    const client = await getMessagingClient();
    const { getToken, onMessage } = await import("https://www.gstatic.com/firebasejs/12.1.0/firebase-messaging.js");
    const token = await getToken(client, { vapidKey: firebaseConfig.messagingVapidKey, serviceWorkerRegistration: registration });
    if (!token) return false;
    await setDoc(doc(db, "users", user.uid), { fcmTokens: arrayUnion(token), pushNotificationsEnabled: true, pushUpdatedAt: serverTimestamp() }, { merge: true });
    foregroundUnsub?.();
    foregroundUnsub = onMessage(client, payload => {
      const data = payload?.data || {};
      notifyBrowser({
        category: data.category || "messages",
        title: payload?.notification?.title || "CUNNACT",
        body: payload?.notification?.body || "You have a new notification.",
        conversationId: data.conversationId || "",
        force: true
      });
      showToast(`${payload?.notification?.title || "CUNNACT"}: ${payload?.notification?.body || "You have a new notification."}`, "info", 5200);
    });
    return true;
  } catch (e) {
    console.warn("Optional Firebase web push setup skipped:", e);
    return false;
  }
}

export async function enablePushNotifications(user) {
  await requestBrowserNotifications(user);
  return true;
}

export async function disablePushNotifications(user) {
  await disableBrowserNotifications(user);
}

export function notificationsAreEnabled() {
  return browserNotificationsAreEnabled();
}

export async function initNotificationForeground(user) {
  if (!user?.uid) return false;
  await loadNotificationSettings(user.uid);
  if (browserNotificationsAreEnabled()) await attachOptionalFcm(user);
  return browserNotificationsAreEnabled();
}

function categoryEnabled(category) {
  if (category === "groups") return settings.groups;
  if (category === "status") return settings.status;
  if (category === "calls") return settings.calls;
  return settings.messages;
}

function previewBody(body) {
  if (!settings.previews) return "You have a new notification.";
  return String(body || "You have a new notification.").slice(0, 180);
}

export async function notifyBrowser({ category = "messages", title = "CUNNACT", body = "You have a new notification.", conversationId = "", force = false } = {}) {
  if (!settings.banner || !categoryEnabled(category) || !browserNotificationsAreEnabled()) return false;
  if (!force && document.visibilityState === "visible" && conversationId && window.__cunnactActiveConversationId === conversationId) return false;
  const options = {
    body: previewBody(body),
    icon: "/assets/icons/cunnact-192.png",
    badge: "/assets/icons/cunnact-32.png",
    tag: conversationId ? `cunnact-${conversationId}` : `cunnact-${category}`,
    renotify: true,
    data: { conversationId, category }
  };
  try {
    if (serviceWorkerRegistration) {
      await serviceWorkerRegistration.showNotification(title, options);
    } else {
      const notification = new Notification(title, options);
      notification.onclick = () => {
        try { window.focus(); } catch {}
        if (conversationId) window.location.href = `/index.html?conversation=${encodeURIComponent(conversationId)}`;
        notification.close();
      };
    }
    return true;
  } catch (e) { console.warn("Browser notification failed", e); return false; }
}

export async function updateBrowserBadge(count = 0) {
  try {
    if (!settings.badge || !browserNotificationsAreEnabled()) {
      if ("clearAppBadge" in navigator) await navigator.clearAppBadge();
      return;
    }
    if (count > 0 && "setAppBadge" in navigator) await navigator.setAppBadge(Math.min(99, Number(count) || 0));
    else if ("clearAppBadge" in navigator) await navigator.clearAppBadge();
  } catch {}
}
