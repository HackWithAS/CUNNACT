import { app, db, doc, updateDoc, arrayUnion, arrayRemove } from "./firebase.js";
import { firebaseConfig } from "./firebase-config.js";
import { showToast } from "./toast.js";

let messaging = null;
let serviceWorkerRegistration = null;
let foregroundUnsub = null;

async function supported() {
  if (!window.isSecureContext || !('serviceWorker' in navigator) || !('Notification' in window)) return false;
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
  if (!('serviceWorker' in navigator)) throw new Error("Service workers are not supported by this browser.");
  serviceWorkerRegistration = await navigator.serviceWorker.register("/firebase-messaging-sw.js", { scope: "/" });
  return serviceWorkerRegistration;
}

export async function enablePushNotifications(user) {
  if (!user?.uid) throw new Error("Sign in first.");
  if (!(await supported())) throw new Error("Push notifications are not supported in this browser.");
  if (!firebaseConfig.messagingVapidKey || firebaseConfig.messagingVapidKey.startsWith("YOUR_")) {
    throw new Error("CUNNACT web push needs the Firebase Web Push public VAPID key in js/firebase-config.js.");
  }
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notification permission was not granted.");
  const registration = await registerServiceWorker();
  const client = await getMessagingClient();
  const { getToken, onMessage } = await import("https://www.gstatic.com/firebasejs/12.1.0/firebase-messaging.js");
  const token = await getToken(client, { vapidKey: firebaseConfig.messagingVapidKey, serviceWorkerRegistration: registration });
  if (!token) throw new Error("Firebase did not return a push registration token.");
  await updateDoc(doc(db, "users", user.uid), { fcmTokens: arrayUnion(token), pushNotificationsEnabled: true, pushUpdatedAt: new Date() });
  foregroundUnsub?.();
  foregroundUnsub = onMessage(client, payload => {
    const title = payload?.notification?.title || "CUNNACT";
    const body = payload?.notification?.body || "You have a new notification.";
    showToast(`${title}: ${body}`, "info", 5200);
    if (document.visibilityState !== "visible" && Notification.permission === "granted") {
      try { new Notification(title, { body, icon: "/assets/icons/cunnact-192.png" }); } catch {}
    }
  });
  localStorage.setItem("cunnact_push_enabled", "true");
  return token;
}

export async function disablePushNotifications(user) {
  if (!user?.uid) return;
  const { deleteToken } = await import("https://www.gstatic.com/firebasejs/12.1.0/firebase-messaging.js").catch(() => ({}));
  try {
    const client = await getMessagingClient();
    const registration = serviceWorkerRegistration || await registerServiceWorker();
    const { getToken } = await import("https://www.gstatic.com/firebasejs/12.1.0/firebase-messaging.js");
    const token = await getToken(client, { vapidKey: firebaseConfig.messagingVapidKey, serviceWorkerRegistration: registration }).catch(() => "");
    if (token) await updateDoc(doc(db, "users", user.uid), { fcmTokens: arrayRemove(token), pushNotificationsEnabled: false, pushUpdatedAt: new Date() });
    if (deleteToken) await deleteToken(client).catch(() => {});
  } catch {}
  foregroundUnsub?.(); foregroundUnsub = null;
  localStorage.removeItem("cunnact_push_enabled");
}

export function notificationsAreEnabled() {
  return ("Notification" in window) && Notification.permission === "granted" && localStorage.getItem("cunnact_push_enabled") === "true";
}

export async function initNotificationForeground(user) {
  if (!user?.uid || !notificationsAreEnabled()) return false;
  try { await enablePushNotifications(user); return true; } catch { return false; }
}
