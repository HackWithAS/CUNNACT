import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getFirestore, doc, getDoc, collection, query, where, orderBy, limit, onSnapshot, addDoc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

let currentUser = null;
let activeUser = null;
let unsubscribeMessages = null;

const $ = (id) => document.getElementById(id);
const avatar = (url) => url || "assets/images/avatar.svg";

onAuthStateChanged(auth, async (user) => {
  if (!user) { location.href = "login.html"; return; }
  currentUser = user;
  $("currentUserName").textContent = user.displayName || user.email;
  $("currentUserPhoto").src = avatar(user.photoURL);
  $("currentUserStatus").textContent = "Online";
  await setDoc(doc(db, "users", user.uid), { isOnline: true, lastSeen: serverTimestamp() }, { merge: true });
  loadSearch("");
});

$("logoutBtn").addEventListener("click", async () => {
  if (currentUser) await setDoc(doc(db, "users", currentUser.uid), { isOnline: false, lastSeen: serverTimestamp() }, { merge: true });
  await signOut(auth);
});

$("profileBtn").addEventListener("click", () => location.href = "profile.html");
$("backBtn").addEventListener("click", () => $("app").classList.remove("chat-open"));

$("userSearch").addEventListener("input", e => loadSearch(e.target.value.trim()));

async function loadSearch(term) {
  const box = $("searchResults");
  if (!term) { box.innerHTML = ""; return; }
  const snap = await getDocsSafe(query(collection(db, "users"), orderBy("name"), limit(30)));
  const matches = snap.filter(u => u.uid !== currentUser?.uid && `${u.name} ${u.email}`.toLowerCase().includes(term.toLowerCase()));
  box.innerHTML = matches.map(u => `<div class="search-user" data-uid="${u.uid}"><img src="${avatar(u.photoURL)}"><div><strong>${escapeHtml(u.name || u.email)}</strong><small>${escapeHtml(u.bio || "")}</small></div></div>`).join("");
  box.querySelectorAll(".search-user").forEach(el => el.addEventListener("click", () => openChat(el.dataset.uid)));
}

async function getDocsSafe(q) {
  const { getDocs } = await import("https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js");
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id:d.id, ...d.data() }));
}

function conversationId(a, b) { return [a,b].sort().join("_"); }

async function openChat(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  if (!snap.exists()) return;
  activeUser = { uid, ...snap.data() };
  $("chatName").textContent = activeUser.name || activeUser.email;
  $("chatPhoto").src = avatar(activeUser.photoURL);
  $("chatStatus").textContent = activeUser.isOnline ? "Online" : "Offline";
  $("messageInput").disabled = false;
  $("attachBtn").disabled = false;
  $("messageForm").querySelector("button[type=submit]").disabled = false;
  $("app").classList.add("chat-open");
  listenMessages();
}

function listenMessages() {
  if (unsubscribeMessages) unsubscribeMessages();
  const cid = conversationId(currentUser.uid, activeUser.uid);
  const messagesRef = collection(db, "conversations", cid, "messages");
  const q = query(messagesRef, orderBy("createdAt"), limit(200));
  unsubscribeMessages = onSnapshot(q, snap => {
    $("messages").innerHTML = "";
    snap.docs.forEach(d => renderMessage({ id:d.id, ...d.data() }));
    $("messages").scrollTop = $("messages").scrollHeight;
  }, () => {
    $("messages").innerHTML = '<div class="empty-state">Messages could not be loaded. Check your Firebase rules.</div>';
  });
}

function renderMessage(message) {
  const el = document.createElement("div");
  el.className = `message ${message.senderId === currentUser.uid ? "outgoing" : ""}`;
  const time = message.createdAt?.toDate ? message.createdAt.toDate().toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"}) : "";
  if (message.type === "image" && message.fileUrl) {
    el.innerHTML = `<img src="${message.fileUrl}" alt="Shared image"><small>${time}</small>`;
  } else if (message.type === "file" && message.fileUrl) {
    el.innerHTML = `<a href="${message.fileUrl}" target="_blank" rel="noopener">${escapeHtml(message.fileName || "Open file")}</a><small>${time}</small>`;
  } else {
    el.innerHTML = `<div>${escapeHtml(message.text || "")}</div><small>${time} ${message.senderId === currentUser.uid ? "✓" : ""}</small>`;
  }
  $("messages").appendChild(el);
}

$("messageForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!activeUser) return;
  const text = $("messageInput").value.trim();
  if (!text) return;
  const cid = conversationId(currentUser.uid, activeUser.uid);
  await setDoc(doc(db, "conversations", cid), {
    members: [currentUser.uid, activeUser.uid],
    lastMessage: text,
    lastMessageTime: serverTimestamp()
  }, { merge: true });
  await addDoc(collection(db, "conversations", cid, "messages"), {
    senderId: currentUser.uid,
    receiverId: activeUser.uid,
    text,
    type: "text",
    status: "sent",
    createdAt: serverTimestamp()
  });
  $("messageInput").value = "";
});

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
}
