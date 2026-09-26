/* CUNNACT Firebase Cloud Messaging service worker.
 * Firebase config values here are public client identifiers, not secrets.
 */
importScripts("https://www.gstatic.com/firebasejs/12.1.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/12.1.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyA_dapCcAP9w_66FacMlRns1NTwxZ-_wTQ",
  authDomain: "cunnact.firebaseapp.com",
  projectId: "cunnact",
  storageBucket: "cunnact.firebasestorage.app",
  messagingSenderId: "179918248368",
  appId: "1:179918248368:web:a188f5aafc096043a75e75",
  measurementId: "G-W7B6GVV3D9"
});

const messaging = firebase.messaging();
messaging.onBackgroundMessage(payload => {
  const title = payload?.notification?.title || "CUNNACT";
  const options = {
    body: payload?.notification?.body || "You have a new message.",
    icon: "/assets/icons/cunnact-192.png",
    badge: "/assets/icons/cunnact-32.png",
    data: payload?.data || {}
  };
  self.registration.showNotification(title, options);
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  const conversationId = event.notification?.data?.conversationId || "";
  const target = conversationId ? `/index.html?conversation=${encodeURIComponent(conversationId)}` : "/index.html";
  event.waitUntil(clients.matchAll({ type: "window", includeUncontrolled: true }).then(list => {
    const same = list.find(client => client.url.includes(location.origin));
    if (same) { same.focus(); return same.navigate(target); }
    return clients.openWindow(target);
  }));
});
