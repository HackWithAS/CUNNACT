import {
  auth, db, onAuthStateChanged, signOut, sendEmailVerification, reload,
  doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection,
  query, where, orderBy, startAt, endAt, limit, onSnapshot,
  serverTimestamp, increment, writeBatch, runTransaction, arrayUnion, arrayRemove
} from "./firebase.js";
import { uploadImageToCloudinary, uploadFileToCloudinary, validateImageFile, validateMediaFile, mediaKind, UploadError, MESSAGES as UPLOAD_MESSAGES, isTrustedImageUrl, isTrustedCloudinaryUrl, imageUrl } from "./cloudinary.js";
import { paintAvatar, avatarHtml } from "./avatar.js";
import { openLightbox } from "./lightbox.js";
import { showToast } from "./toast.js";
import { formatTime, formatWhen, formatLastSeen, escapeHtml, debounce } from "./ui.js";
import { buildConversationId, previewText } from "./chat.js";
import { createCallController } from "./calls.js";
import { normalizeSearch, isSearchValid } from "./users.js";
import { listenMessageRequests, sendMessageRequest, acceptMessageRequest, declineMessageRequest, cancelMessageRequest, getOutgoingPendingRequest } from "./requests.js";
import { playClick, playSend, playReceive, playSave, playDelete, isSoundEnabled, toggleSound } from "./sound.js";
import { loadRetentionMode, getRetentionMode, shouldExpireMessage, cleanupExpiredMessages, startPeriodicCleanup, isSavedByUser, isDeletedForUser, setUserSetting } from "./retention.js";
import { initSocialFeatures } from "./social.js";
import { initGlobalSearch } from "./search.js";
import { registerDeviceSession, listenCurrentDevice, touchCurrentDevice, writeSecurityEvent, getUserSettings, isAppLockEnabled, verifyPin, createPinHash } from "./security.js";
import { initNotificationForeground } from "./notifications.js";

let currentUser = null;
let currentUserData = {};
let currentBlockedUsers = new Set();
let activeUser = null;
let activeConversationId = null;
let activeConversation = null;
let activeGroupMembers = new Map();
let unsubscribeMessages = null;
let unsubscribeTyping = null;
let unsubscribeConversations = null;
let cleanupInterval = null;
let presenceHeartbeat = null;
let presenceUiTimer = null;
let conversations = [];
let chatSearchTerm = "";
let currentMessages = [];
let activeMessageMap = new Map();
let userListeners = new Map();
let lastMessageCount = 0;
let pendingImageFile = null;
let pendingImageUrl = null;
let pendingMediaItems = [];
let mediaQuality = "optimized";
let uploadController = null;
let sendingMessage = false;
let staticBound = false;
let messageListenerToken = 0;
let confirmDialogResolver = null;
let replyTarget = null;
let editTarget = null;
let selectionMode = false;
let selectedMessageIds = new Set();
let chatSelectionMode = false;
let selectedConversationIds = new Set();
let voiceRecorder = null;
let newChatRenderToken = 0;
let voiceChunks = [];
let callLinkConsumed = false;
let readObserver = null;
let queuedReadIds = new Set();
let readFlushTimer = null;
let deliveredFlushTimer = null;
const queuedDeliveredIds = new Set();
let ownHeartbeatAt = 0;
const localHiddenLatest = new Set();
const ONLINE_WINDOW_MS = 90 * 1000;
const USERNAME_PATTERN = /^[a-z0-9_]{3,24}$/;

const callController = createCallController({
  getCurrentUser: () => currentUser,
  getConversations: () => conversations,
  getActiveConversation: () => activeConversation,
  getActiveUser: () => activeUser
});

const socialFeatures = initSocialFeatures({ getCurrentUser: () => currentUser });

let currentUserSettings = {};
let securitySessionUnsub = null;
let deviceTouchTimer = null;
let swRegistration = null;
let globalSearch = null;
let appLockUnlocked = true;
async function loadSecuritySettings(){ try{ currentUserSettings=await getUserSettings(currentUser?.uid); }catch{ currentUserSettings={}; } return currentUserSettings; }
function showAppLock(){
  const modal=$id("appLockModal"); if(!modal)return;
  modal.hidden=false; modal.setAttribute("aria-hidden","false"); document.body.classList.add("modal-open");
  const input=$id("appLockPinInput"); if(input)input.value=""; if($id("appLockError"))$id("appLockError").textContent=""; setTimeout(()=>input?.focus(),30);
}
function closeAppLock(){ const modal=$id("appLockModal");if(!modal)return;modal.hidden=true;modal.setAttribute("aria-hidden","true");if(!document.querySelector(".modal:not([hidden])"))document.body.classList.remove("modal-open");appLockUnlocked=true; }
async function requireAppUnlock(){ await loadSecuritySettings(); if(!isAppLockEnabled(currentUserSettings))return true; if(appLockUnlocked)return true; showAppLock(); return false; }

const $id = (id) => document.getElementById(id);
const ICONS = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m5 12 4 4L19 6"/></svg>',
  block: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="m7 7 10 10"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M7 10V7a5 5 0 0 1 9.7-1.6"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="m19 21-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3"/></svg>',
  reply: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M9 17 4 12l5-5"/><path d="M4 12h10a6 6 0 0 1 6 6v1"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  profile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="7" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="m4 16 10-10 4 4L8 20l-4 1 1-5Z"/><path d="m13 7 4 4"/></svg>',
  forward: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M14 5l7 7-7 7"/><path d="M3 12h18"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M8 3h8l-1 6 3 3-6 2v7l-2-2v-5l-6-2 3-3-1-6Z"/></svg>',
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M12 10v6M12 7h.01"/></svg>',
  mic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M8 21h8"/></svg>',
  smile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M8 14c1 2 7 2 8 0M9 9h.01M15 9h.01"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>'
};

function timestampDate(value) {
  return value?.toDate?.() || (value instanceof Date ? value : null);
}
function isUserOnline(user) {
  const heartbeat = timestampDate(user?.lastHeartbeat);
  if (!heartbeat) return false;
  const age = Date.now() - heartbeat.getTime();
  return age >= -5000 && age <= ONLINE_WINDOW_MS && user?.isOnline !== false;
}
function setStatusDot(el, online) { el?.classList.toggle("online", !!online); }
function ownPresencePayload(online) {
  return online ? { isOnline: true, lastHeartbeat: serverTimestamp() } : { isOnline: false, lastSeen: serverTimestamp() };
}
async function setOwnPresence(online) {
  if (!currentUser) return;
  try {
    await updateDoc(doc(db, "users", currentUser.uid), ownPresencePayload(online));
    if (online) {
      ownHeartbeatAt = Date.now();
      currentUserData = { ...currentUserData, isOnline: true, lastHeartbeat: new Date(ownHeartbeatAt) };
    } else {
      currentUserData = { ...currentUserData, isOnline: false, lastSeen: new Date() };
    }
    refreshPresenceUI();
  } catch (e) { console.warn("Presence update failed", e); }
}
function refreshPresenceUI() {
  const ownOnline = document.visibilityState === "visible" && ownHeartbeatAt > 0 && (Date.now() - ownHeartbeatAt) <= ONLINE_WINDOW_MS;
  const ownStatus = $id("currentUserStatus");
  if (ownStatus) ownStatus.textContent = ownOnline ? "Online" : "Offline";
  setStatusDot($id("currentUserAvatar")?.querySelector(".status-dot"), ownOnline);
  renderChatList();
  refreshChatHeader();
}
function startPresence() {
  clearInterval(presenceHeartbeat);
  clearInterval(presenceUiTimer);
  ownHeartbeatAt = Date.now();
  setOwnPresence(true);
  presenceHeartbeat = setInterval(() => {
    if (document.visibilityState === "visible" && navigator.onLine !== false) setOwnPresence(true);
  }, 30000);
  presenceUiTimer = setInterval(refreshPresenceUI, 15000);
}

function openModal(id) {
  const modal = $id(id); if (!modal) return;
  document.querySelectorAll(".dropdown-menu:not([hidden])").forEach((m) => m.hidden = true);
  modal.hidden = false; modal.setAttribute("aria-hidden", "false"); document.body.classList.add("modal-open");
}
function closeModal(id) {
  const modal = $id(id); if (!modal) return;
  modal.hidden = true; modal.setAttribute("aria-hidden", "true");
  if (!document.querySelector(".modal:not([hidden])")) document.body.classList.remove("modal-open");
}
function showConfirmDialog({ title, message, confirmText = "Confirm", cancelText = "Cancel", danger = false } = {}) {
  return new Promise((resolve) => {
    const modal = $id("confirmModal"); if (!modal) return resolve(false);
    confirmDialogResolver = resolve;
    $id("confirmTitle").textContent = title || "Are you sure?";
    $id("confirmMessage").textContent = message || "This action cannot be undone.";
    const confirmBtn = $id("confirmActionBtn");
    confirmBtn.textContent = confirmText;
    confirmBtn.classList.toggle("danger-confirm", danger);
    openModal("confirmModal");
    setTimeout(() => confirmBtn.focus(), 20);
  });
}
function finishConfirmDialog(result) {
  const resolve = confirmDialogResolver; confirmDialogResolver = null;
  closeModal("confirmModal"); resolve?.(!!result);
}
let systemThemeMedia = null;
function resolveTheme(pref) {
  if (pref === "dark") return "dark";
  if (pref === "system") return (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light";
  return "light";
}
function watchSystemTheme(enable) {
  if (!window.matchMedia) return;
  if (!systemThemeMedia) systemThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  systemThemeMedia.onchange = enable ? () => applyTheme("system", false) : null;
}
function applyTheme(theme, persist = true) {
  const pref = (theme === "dark" || theme === "system") ? theme : "light";
  const resolved = resolveTheme(pref);
  document.documentElement.dataset.theme = resolved;
  localStorage.setItem("cunnact_theme", pref);
  $id("themeToggleLabel") && ($id("themeToggleLabel").textContent = resolved === "dark" ? "Light mode" : "Dark mode");
  document.querySelectorAll('input[name="themeMode"]').forEach(r => { r.checked = (r.value === pref); });
  watchSystemTheme(pref === "system");
  if (persist && currentUser) setUserSetting(currentUser.uid, { theme: pref }).catch(() => {});
}
function updateSoundToggle() {
  const btn = $id("soundToggle"); if (!btn) return;
  btn.innerHTML = isSoundEnabled()
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M5 9v6h4l5 4V5L9 9H5Z"/><path d="M17 9.5a4 4 0 0 1 0 5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="m5 9 4 6h4l5 4V5l-5 4H9L5 3"/></svg>';
  btn.title = isSoundEnabled() ? "Sound on" : "Sound off";
  btn.setAttribute("aria-label", btn.title);
}
function toggleDropdown(id, buttonId) {
  const menu = $id(id), button = $id(buttonId); if (!menu) return;
  const nextOpen = menu.hidden;
  document.querySelectorAll(".dropdown-menu").forEach((m) => { if (m !== menu) m.hidden = true; });
  menu.hidden = !nextOpen; button?.setAttribute("aria-expanded", String(nextOpen));
}

async function registerAppServiceWorker(){
  if(!("serviceWorker" in navigator))return null;
  try{ swRegistration=await navigator.serviceWorker.register("/sw.js",{scope:"/"}); return swRegistration; }catch(e){ console.warn("App service worker registration failed",e); return null; }
}
function updateOfflineUI(){ const bar=$id("offlineBar"); if(bar){ const offline=navigator.onLine===false; bar.hidden=!offline; bar.textContent=offline?"You’re offline. CUNNACT will retry when the connection returns.":""; } }
function enableDesktopShortcuts(){
  document.addEventListener("keydown",e=>{
    const mod=e.ctrlKey||e.metaKey;
    if(mod&&e.key.toLowerCase()==="k"){e.preventDefault();globalSearch?.open?.();}
    if(mod&&e.key.toLowerCase()==="n"&&(!/input|textarea|select/i.test(e.target?.tagName||""))){e.preventDefault();$id("newChatBtn")?.click();}
    if(mod&&e.key.toLowerCase()==="b"&&!/input|textarea|select/i.test(e.target?.tagName||"")){e.preventDefault();toggleDropdown("accountMenu","accountMenuBtn");}
  },{passive:false});
}
function bindDesktopSharing(){
  const messages=$id("messages"),input=$id("messageInput");
  const acceptFiles=(files)=>{ if(!files?.length||!activeConversationId)return; try{const dt=new DataTransfer();[...files].slice(0,8).forEach(f=>dt.items.add(f));const el=$id("fileInput");if(el){el.files=dt.files;handleMediaSelection();}}catch(e){console.warn("Drop/paste media failed",e);} };
  messages?.addEventListener("dragover",e=>{if(!activeConversationId)return;e.preventDefault();messages.classList.add("drop-target");});
  messages?.addEventListener("dragleave",()=>messages.classList.remove("drop-target"));
  messages?.addEventListener("drop",e=>{e.preventDefault();messages.classList.remove("drop-target");acceptFiles(e.dataTransfer?.files);});
  input?.addEventListener("paste",e=>{const files=[...(e.clipboardData?.files||[])].filter(f=>/^image\//i.test(f.type));if(files.length){e.preventDefault();acceptFiles(files);}});
}
function maybeOpenConversationFromUrl(){
  const id=new URLSearchParams(location.search).get("conversation"); if(!id)return;
  setTimeout(async()=>{try{await openChatById(id); }catch(e){console.warn("Conversation deep link failed",e);}},250);
}
function setPopupMode(){
  if(new URLSearchParams(location.search).get("popup")==="1")document.body.classList.add("popup-mode");
}
/* Auth bootstrap */
applyTheme(localStorage.getItem("cunnact_theme") || "light", false);
onAuthStateChanged(auth, async (user) => {
  if (!user) { location.replace("login.html"); return; }
  if (!user.emailVerified) { currentUser = user; showVerifyGate(user); return; }
  currentUser = user;
  try {
    const ref = doc(db, "users", user.uid);
    const snap = await getDoc(ref);
    currentUserData = snap.exists() ? snap.data() : {};
    const settingsSnap = await getDoc(doc(db, "userSettings", user.uid)).catch(() => null);
    const accountSettings = settingsSnap?.exists?.() ? settingsSnap.data() : {};
    const theme = accountSettings.theme || localStorage.getItem("cunnact_theme") || "light";
    applyTheme(theme, false);
    if (typeof accountSettings.soundEnabled === "boolean") {
      const { setSoundEnabled } = await import("./sound.js");
      setSoundEnabled(accountSettings.soundEnabled);
    }
    await setDoc(ref, {
      uid: user.uid,
      name: currentUserData.name || user.displayName || user.email || "User",
      email: currentUserData.email || user.email || "",
      emailLower: String(currentUserData.email || user.email || "").toLowerCase(),
      photoURL: currentUserData.photoURL || user.photoURL || "",
      bio: currentUserData.bio || "",
      username: currentUserData.username || "",
      usernameLower: currentUserData.usernameLower || "",
      retentionMode: currentUserData.retentionMode || "24hours",
      theme,
      hideLastSeen: currentUserData.hideLastSeen === true,
      showReadReceipts: currentUserData.showReadReceipts !== false,
      showTypingIndicators: currentUserData.showTypingIndicators !== false,
      profileVisibility: currentUserData.profileVisibility || "public",
      discoverable: currentUserData.discoverable !== false,
      isOnline: true,
      lastHeartbeat: serverTimestamp()
    }, { merge: true });
    currentUserData = { ...currentUserData, isOnline: true, lastHeartbeat: new Date() };
    await ensurePublicProfile();
    await loadRetentionMode(user.uid);
    await loadBlockedUsers();
    await loadSecuritySettings();
    try {
      const sid=await registerDeviceSession(currentUser,{label:location.hostname.includes("vercel.app")?"CUNNACT Web":"CUNNACT Web"});
      securitySessionUnsub=listenCurrentDevice(currentUser,()=>{showToast("This CUNNACT session was signed out from another device.","info");signOut(auth);});
      if(sid) await writeSecurityEvent(currentUser,{type:"session_started",deviceId:sid,details:"New CUNNACT session opened"});
    } catch(e){ console.warn("Security session setup failed",e); }
    hydrateCurrentUserUI();
    bindStaticControls();
    globalSearch = initGlobalSearch({
      getCurrentUser:()=>currentUser,
      getConversations:()=>conversations,
      getUserById:(uid)=>userListeners.get(uid)?.data || null,
      onOpenChat:async(id,uid,messageId)=>{if(id)await openChatById(id,uid);if(messageId)setTimeout(()=>scrollToMessage(messageId),350);},
      onOpenProfile:(u)=>{ if(u?.uid===currentUser.uid) location.href="profile.html"; else if(u?.username) location.href=`/u/${encodeURIComponent(u.username)}`; },
      onOpenSocial:(kind,data)=>{ if(kind==="community") socialFeatures?.openCommunity?.(data?.id); else if(kind==="channel") socialFeatures?.openChannel?.(data?.id); else socialFeatures?.refresh?.(); }
    });
    if(isAppLockEnabled(currentUserSettings)){appLockUnlocked=false;showAppLock();}
    startPresence();
    listenMessageRequests(currentUser, (requests) => { updateRequestsBadge(requests.length); renderMessageRequests(requests); }, () => { refreshNewChatRequestButtons(); });
    listenConversations();
    socialFeatures?.refresh?.();
    const newChatUsername = new URLSearchParams(location.search).get("newChat");
    if (newChatUsername) setTimeout(() => openNewChatWithQuery(newChatUsername), 120);
    const gate = $id("authGate"); if (gate) gate.hidden = true;
    maybeOpenConversationFromUrl();
  } catch (error) {
    console.error("CUNNACT startup failed:", error);
    const gate = $id("authGate");
    if (gate) {
      gate.hidden = false;
      gate.innerHTML = `<div class="auth-gate-card"><strong>Couldn’t load CUNNACT</strong><span>${escapeHtml(error?.code || "Startup error")}</span><button id="retryBtn" class="btn btn-primary">Refresh</button></div>`;
      $id("retryBtn")?.addEventListener("click", () => location.reload());
    }
  }
});
function showVerifyGate(user){
  const gate=$id("authGate"); if(!gate) return;
  gate.hidden=false;
  gate.innerHTML=`<div class="auth-gate-card">
    <strong>Verify your email</strong>
    <span>We sent a confirmation link to ${escapeHtml(user.email||"your email")}.</span>
    <span class="verify-spam-note">Don't see it? Check your <strong>Spam / Promotions</strong> folder — verification emails sometimes land there.</span>
    <button id="resendVerifyBtn" class="btn btn-primary">Resend email</button>
    <button id="checkVerifyBtn" class="btn btn-soft">I've verified — continue</button>
    <button id="verifyLogoutBtn" class="btn btn-soft danger-item">Log out</button>
  </div>`;
  let cooldown=false;
  $id("resendVerifyBtn")?.addEventListener("click", async ()=>{
    if(cooldown){ showToast("Please wait a minute before resending.","info"); return; }
    try{
      await sendEmailVerification(user);
      cooldown=true; setTimeout(()=>{cooldown=false;},60000);
      showToast("Verification email sent — check Spam/Promotions too.","success");
    }catch(e){
      console.error("Resend verification failed",e);
      showToast(e?.code==="auth/too-many-requests"?"Too many attempts. Wait a few minutes.":"Could not send email. Try again shortly.","error");
    }
  });
  $id("checkVerifyBtn")?.addEventListener("click", async ()=>{
    try{ await reload(user); if(user.emailVerified){ location.reload(); } else { showToast("Still not verified. Check Spam/Promotions, or resend the link.","info"); } }
    catch(e){ showToast("Could not refresh status.","error"); }
  });
  $id("verifyLogoutBtn")?.addEventListener("click", ()=> signOut(auth));
}
async function ensurePublicProfile() {
  if (!currentUser) return;
  const data = currentUserData || {};
  if (!data.username) return;
  await setDoc(doc(db, "publicProfiles", currentUser.uid), {
    uid: currentUser.uid, username: data.username, usernameLower: data.usernameLower || data.username,
    displayName: data.name || currentUser.displayName || currentUser.email || "CUNNACT user",
    displayNameLower: String(data.name || currentUser.displayName || currentUser.email || "CUNNACT user").toLowerCase(),
    username: data.username, usernameLower: data.usernameLower || data.username,
    profileVisibility: data.profileVisibility || "public", discoverable: data.discoverable !== false,
    photoURL: data.photoURL || currentUser.photoURL || "", bio: data.bio || "", updatedAt: serverTimestamp()
  }, { merge: true }).catch(() => {});
}
function hydrateCurrentUserUI() {
  const name = currentUserData.name || currentUser.displayName || currentUser.email || "User";
  const email = currentUserData.email || currentUser.email || "";
  $id("currentUserName") && ($id("currentUserName").textContent = name);
  $id("currentUserEmail") && ($id("currentUserEmail").textContent = email);
  paintAvatar($id("currentUserAvatar"), { photoURL: currentUserData.photoURL || currentUser.photoURL || "", name, email });
  paintAvatar($id("navProfileAvatar"), { photoURL: currentUserData.photoURL || currentUser.photoURL || "", name, email, preset: "avatarSm" });
  paintAvatar($id("menuUserAvatar"), { photoURL: currentUserData.photoURL || currentUser.photoURL || "", name, email, preset: "avatarSm" });
  $id("menuUserName") && ($id("menuUserName").textContent = name);
  $id("menuUserEmail") && ($id("menuUserEmail").textContent = email);
}

/* Lifecycle */
updateOfflineUI();
window.addEventListener("online", updateOfflineUI);
window.addEventListener("offline", updateOfflineUI);
setPopupMode();

document.addEventListener("visibilitychange", () => {
  if (!currentUser) return;
  setOwnPresence(document.visibilityState === "visible");
  if (document.visibilityState === "visible") {
    flushQueuedReads();
    refreshPresenceUI();
    if (activeConversationId) cleanupExpiredMessages(db, activeConversationId, currentMessages, currentUser.uid, updateDoc).catch(() => {});
  }
});
window.addEventListener("pagehide", () => { securitySessionUnsub?.(); clearInterval(deviceTouchTimer); clearInterval(presenceHeartbeat); clearInterval(presenceUiTimer); setOwnPresence(false); });
window.addEventListener("beforeunload", () => { if (currentUser) setOwnPresence(false); });
window.addEventListener("online", () => { if (currentUser && document.visibilityState === "visible") setOwnPresence(true); });
window.addEventListener("offline", () => { if (currentUser) { currentUserData = { ...currentUserData, isOnline:false }; refreshPresenceUI(); } });

/* Calls page — dedicated WhatsApp-style calls workspace */
let callsPageRows = [];
let callsPageSearch = "";

function closeCallsPage() {
  const app = $id("app");
  $id("callsView")?.setAttribute("hidden", "true");
  $id("callsPanel")?.setAttribute("hidden", "true");
  $id("sidebarDefaultView")?.removeAttribute("hidden");
  $id("newChatView")?.setAttribute("hidden", "true");
  app?.classList.remove("calls-open");
}
window.closeCallsPage = closeCallsPage;

function callRowDirection(call) {
  if (call?.status === "declined" || call?.status === "missed") return "Missed";
  return call?.initiatorId === currentUser?.uid ? "Outgoing" : "Incoming";
}
function callRowType(call) {
  return call?.callType === "video" ? "Video call" : "Voice call";
}
function callRowTime(value) {
  const dt = value?.toDate?.() || (value instanceof Date ? value : (value ? new Date(value) : null));
  if (!dt || Number.isNaN(dt.getTime())) return "";
  const now = new Date();
  return dt.toDateString() === now.toDateString() ? formatTime(dt) : formatWhen(dt);
}

async function loadCallsPageHistory() {
  const box = $id("callsRecentList");
  if (!box || !currentUser) return;
  box.innerHTML = '<div class="calls-list-empty">Loading call history…</div>';
  const recentConversations = conversations.slice(0, 24);
  try {
    const all = [];
    for (const conv of recentConversations) {
      try {
        const snap = await getDocs(query(collection(db, "conversations", conv.id, "calls"), limit(20)));
        snap.docs.forEach(d => all.push({ id:d.id, conversationId:conv.id, ...d.data() }));
      } catch (error) {
        console.warn("Calls history query skipped", conv.id, error);
      }
    }
    callsPageRows = all.sort((a,b)=>(b.createdAt?.toMillis?.()||0)-(a.createdAt?.toMillis?.()||0)).slice(0, 80);
    renderCallsPageHistory();
  } catch (error) {
    console.error("Calls history failed", error);
    box.innerHTML = '<div class="calls-list-empty"><strong>Call history could not be loaded.</strong><span>Check your Firebase connection and rules.</span></div>';
  }
}

function getCallContactMeta(row) {
  const conv = conversations.find(c => c.id === row.conversationId);
  if (!conv) return { name: row.title || "CUNNACT call", username:"", photoURL:"", isGroup:false };
  if (conv.type === "group") return { name: conv.groupName || row.title || "Group call", username:"", photoURL:conv.groupPhotoURL || "", isGroup:true };
  const uid = otherUid(conv);
  const data = userListeners.get(uid)?.data;
  return { name:data?.name || row.title || "CUNNACT user", username:data?.username || "", photoURL:data?.photoURL || "", uid, isGroup:false };
}

function renderCallsPageHistory() {
  const box = $id("callsRecentList");
  if (!box) return;
  const term = callsPageSearch.trim().toLowerCase();
  const filtered = callsPageRows.filter(row => {
    const meta = getCallContactMeta(row);
    const hay = `${meta.name||""} ${meta.username||""} ${row.title||""} ${callRowType(row)} ${callRowDirection(row)}`.toLowerCase();
    return !term || hay.includes(term);
  }).slice(0, 50);
  if (!filtered.length) {
    box.innerHTML = '<div class="calls-list-empty"><strong>No recent calls</strong><span>Your call history will appear here.</span></div>';
    return;
  }
  box.innerHTML = filtered.map((row, index) => {
    const meta = getCallContactMeta(row);
    const dir = callRowDirection(row);
    const type = callRowType(row);
    const danger = dir === "Missed" ? " missed" : "";
    const icon = type === "Video call"
      ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="6" width="12.5" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/></svg>'
      : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 16.8v3a2 2 0 0 1-2.2 2A19.6 19.6 0 0 1 3.2 5.2 2 2 0 0 1 5.2 3h3a2 2 0 0 1 2 1.7c.1.8.3 1.6.6 2.4a2 2 0 0 1-.4 2.1L9.1 10.7a15.4 15.4 0 0 0 4.2 4.2l1.5-1.3a2 2 0 0 1 2.1-.4c.8.3 1.6.5 2.4.6A2 2 0 0 1 22 16.8Z"/></svg>';
    return `<div class="call-history-page-row${danger}" data-call-row-index="${index}">
      <span class="call-history-page-avatar">${meta.photoURL ? `<img src="${escapeHtml(meta.photoURL)}" alt="">` : `<span>${escapeHtml((meta.name||"C").slice(0,1).toUpperCase())}</span>`}</span>
      <span class="call-history-page-copy"><strong>${escapeHtml(meta.name||"CUNNACT user")}</strong><small><span class="call-history-direction ${dir === "Missed" ? "missed" : ""}">${escapeHtml(dir)}</span> · ${escapeHtml(type)}</small></span>
      <span class="call-history-page-meta"><time>${escapeHtml(callRowTime(row.createdAt))}</time><button type="button" class="call-history-call-btn" data-call-back-index="${index}" aria-label="Call ${escapeHtml(meta.name||"contact")}" title="Call back">${icon}</button></span>
    </div>`;
  }).join("");
  box.querySelectorAll("[data-call-back-index]").forEach(btn => {
    btn.addEventListener("click", async e => {
      e.stopPropagation();
      const idx = Number(btn.dataset.callBackIndex);
      const row = filtered[idx];
      if (!row) return;
      await startCallFromCallRow(row, row.callType === "video" ? "video" : "voice");
    });
  });
}

async function startCallFromConversation(conv, callType="voice") {
  if (!conv?.id || !currentUser) return;
  try {
    await openChatById(conv.id);
    if (!activeConversationId || activeConversationId !== conv.id || !activeUser) return;
    await startActiveCall(callType);
  } catch (error) {
    console.error("Start call from calls page failed", error);
    showToast("Could not start the call.", "error");
  }
}
async function startCallFromCallRow(row, callType="voice") {
  const conv = conversations.find(c => c.id === row?.conversationId);
  if (!conv) { showToast("This conversation is no longer available.", "error"); return; }
  await startCallFromConversation(conv, callType);
}

function renderCallPicker(filter="") {
  const box = $id("callPickerList");
  if (!box) return;
  const term = String(filter||"").trim().toLowerCase();
  const rows = conversations.filter(c => {
    const meta = conversationDisplay(c);
    const hay = `${meta?.name||""} ${meta?.username||""} ${meta?.email||""}`.toLowerCase();
    return !term || hay.includes(term);
  }).slice(0, 30);
  if (!rows.length) { box.innerHTML='<div class="empty-state">No connected contacts found.</div>'; return; }
  box.innerHTML = rows.map((c,i) => {
    const meta = conversationDisplay(c);
    const photo = meta.photoURL || "";
    const name = meta.name || "Contact";
    return `<div class="call-picker-row" data-call-picker-index="${i}">
      <span class="call-picker-avatar">${photo ? `<img src="${escapeHtml(photo)}" alt="">` : `<span>${escapeHtml(name.slice(0,1).toUpperCase())}</span>`}</span>
      <span class="call-picker-meta"><strong>${escapeHtml(name)}</strong><small>${meta.isGroup ? `${Number(meta.memberCount||c.members?.length||0)} members` : (meta.username ? `@${escapeHtml(meta.username)}` : "Connected contact")}</small></span>
      <span class="call-picker-actions"><button type="button" data-picker-call="voice" aria-label="Voice call"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M22 16.8v3a2 2 0 0 1-2.2 2A19.6 19.6 0 0 1 3.2 5.2 2 2 0 0 1 5.2 3h3a2 2 0 0 1 2 1.7c.1.8.3 1.6.6 2.4a2 2 0 0 1-.4 2.1L9.1 10.7a15.4 15.4 0 0 0 4.2 4.2l1.5-1.3a2 2 0 0 1 2.1-.4c.8.3 1.6.5 2.4.6A2 2 0 0 1 22 16.8Z"/></svg></button><button type="button" data-picker-call="video" aria-label="Video call"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3.5" y="6" width="12.5" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/></svg></button></span>
    </div>`;
  }).join("");
  box.querySelectorAll(".call-picker-row").forEach((row,index) => {
    const conv = rows[index];
    row.querySelectorAll("[data-picker-call]").forEach(btn => btn.addEventListener("click", async e => {
      e.stopPropagation();
      closeModal("startCallModal");
      await startCallFromConversation(conv, btn.dataset.pickerCall);
    }));
  });
}
function openStartCallPicker() {
  if (!currentUser) return;
  openModal("startCallModal");
  const input = $id("callPickerSearch");
  if (input) { input.value=""; renderCallPicker(""); setTimeout(()=>input.focus(), 30); }
}

async function openCallsPage() {
  const app=$id("app"), base=$id("sidebarDefaultView"), newChat=$id("newChatView"), status=$id("statusView"), channels=$id("channelsView"), statusPanel=$id("statusPanel"), channelsPanel=$id("channelsPanel"), view=$id("callsView"), panel=$id("callsPanel"), chat=document.querySelector(".chat-panel");
  if(!app||!view||!panel)return;
  base?.setAttribute("hidden","");newChat?.setAttribute("hidden","");status?.setAttribute("hidden","");channels?.setAttribute("hidden","");statusPanel?.setAttribute("hidden","");channelsPanel?.setAttribute("hidden","");chat?.setAttribute("hidden","");
  view.hidden=false;panel.hidden=false;
  app.classList.add("calls-open");app.classList.remove("chat-open","status-open","channels-open");
  document.querySelectorAll(".nav-rail-btn").forEach(b=>b.classList.remove("active"));
  $id("navCallsBtn")?.classList.add("active");
  await loadCallsPageHistory();
}

/* Static controls */
function bindStaticControls() {
  if (staticBound) return; staticBound = true;
  $id("appLockUnlockBtn")?.addEventListener("click",async()=>{const pin=$id("appLockPinInput")?.value||"";const ok=await verifyPin(pin,currentUserSettings.appLockSalt,currentUserSettings.appLockHash);if(ok){closeAppLock();}else{$id("appLockError").textContent="Incorrect PIN.";}});
  $id("appLockPinInput")?.addEventListener("keydown",e=>{if(e.key==="Enter")$id("appLockUnlockBtn")?.click();});
  $id("appLockLockBtn")?.addEventListener("click",()=>showAppLock());

  updateSoundToggle();
  $id("logoutBtn")?.addEventListener("click", logout);
  $id("navThemeBtn")?.addEventListener("click", () => { playClick(); applyTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark"); });
  $id("navProfileBtn")?.addEventListener("click", () => { playClick(); location.href = "profile.html"; });
  $id("accountMenuBtn")?.addEventListener("click", (e) => { e.stopPropagation(); playClick(); toggleDropdown("accountMenu", "accountMenuBtn"); });
  $id("dashboardNewGroupBtn")?.addEventListener("click", () => { playClick(); $id("accountMenu").hidden=true; openNewGroupModal(); });
  $id("dashboardStarredBtn")?.addEventListener("click", async () => { playClick(); $id("accountMenu").hidden=true; openModal("savedModal"); await renderSavedMessages(); });
  $id("dashboardSelectChatsBtn")?.addEventListener("click", () => { playClick(); $id("accountMenu").hidden=true; setChatSelectionMode(true); });
  $id("dashboardMarkAllReadBtn")?.addEventListener("click", async () => { playClick(); $id("accountMenu").hidden=true; await markAllChatsRead(); });
  $id("appLockMenuBtn")?.addEventListener("click", async () => {
    playClick(); $id("accountMenu").hidden=true; await loadSecuritySettings();
    if (isAppLockEnabled(currentUserSettings)) { appLockUnlocked=false; showAppLock(); }
    else { location.href="profile.html#securitySection"; showToast("App lock is not enabled yet. Open Security to enable it.","info"); }
  });
  $id("chatSelectionCancelBtn")?.addEventListener("click", () => setChatSelectionMode(false));
  $id("chatSelectionMarkReadBtn")?.addEventListener("click", async () => { await markSelectedChatsRead(); });
  $id("soundToggle")?.addEventListener("click", () => { const enabled = toggleSound(); updateSoundToggle(); if (currentUser) setUserSetting(currentUser.uid,{soundEnabled:enabled}).catch(()=>{}); if (enabled) playClick(); });
  $id("backBtn")?.addEventListener("click", () => { playClick(); $id("app")?.classList.remove("chat-open"); closeProfileDrawer(); });
  $id("chatAvatar")?.addEventListener("click", () => { if (activeUser?.uid === currentUser?.uid) return; openProfileDrawer(); });
  $id("chatName")?.addEventListener("click", () => { if (activeUser?.uid === currentUser?.uid) return; openProfileDrawer(); });
  $id("drawerEditBtn")?.addEventListener("click", () => { if (activeUser?.username) location.href=`/u/${encodeURIComponent(activeUser.username)}`; else showToast("This contact has no public profile link yet.","info"); });
  $id("drawerVoiceBtn")?.addEventListener("click", () => { closeProfileDrawer(); startActiveCall("voice"); });
  $id("drawerVideoBtn")?.addEventListener("click", () => { closeProfileDrawer(); startActiveCall("video"); });
  $id("drawerSearchBtn")?.addEventListener("click", () => { closeProfileDrawer(); openModal("conversationSearchModal"); setTimeout(()=>$id("conversationSearchInput")?.focus(),30); });
  $id("drawerMediaBtn")?.addEventListener("click", () => { $id("sharedMediaGrid")?.scrollIntoView({behavior:"smooth",block:"start"}); });
  $id("drawerStarredBtn")?.addEventListener("click", async () => { closeProfileDrawer(); openModal("savedModal"); await renderSavedMessages(); });
  $id("drawerKeptBtn")?.addEventListener("click", async () => { closeProfileDrawer(); openModal("savedModal"); await renderSavedMessages(); });
  $id("drawerNotificationsBtn")?.addEventListener("click", () => { location.href="profile.html#securitySection"; });
  $id("drawerDisappearingBtn")?.addEventListener("click", () => { setDisappearingMessages(); renderProfileDrawer(); });
  $id("drawerBlockBtn")?.addEventListener("click", async () => {
    if(!activeUser?.uid) return;
    const blocked=currentBlockedUsers.has(activeUser.uid);
    if(!blocked){
      const ok=await showConfirmDialog({title:"Block this user?",message:"They won't be able to send you messages until you unblock them.",confirmText:"Block user",cancelText:"Cancel",danger:true});
      if(!ok)return;
    }
    await toggleBlockUser(activeUser.uid,!blocked);
    renderProfileDrawer();
  });
  $id("groupChangesBtn")?.addEventListener("click", () => openGroupChangesModal());
  $id("groupFavouriteBtn")?.addEventListener("click", async () => { if(!activeUser?.isGroup||!activeConversationId)return; await toggleConversationFavourite(); renderProfileDrawer(); });
  $id("groupListBtn")?.addEventListener("click", async () => { if(!activeUser?.isGroup)return; await addConversationToList(); });
  $id("groupExportBtn")?.addEventListener("click", () => { if(activeUser?.isGroup) exportCurrentChat(); });
  $id("groupClearBtn")?.addEventListener("click", async () => { if(activeUser?.isGroup) await clearChatForMe(); });
  $id("groupExitBtn")?.addEventListener("click", async () => { if(activeUser?.isGroup) await leaveGroupChat(); });
  $id("groupReportBtn")?.addEventListener("click", async () => { if(activeUser?.isGroup) await reportActiveGroup(); });
  $id("chatMoreBtn")?.addEventListener("click", (e) => { e.stopPropagation(); if (!activeUser) return; playClick(); renderChatMoreMenu(); toggleDropdown("chatMoreMenu", "chatMoreBtn"); });
  const closeNewChatView = () => {
    const view = $id("newChatView");
    const base = $id("sidebarDefaultView");
    if (view) view.hidden = true;
    if (base) base.hidden = false;
    $id("newChatSearch")?.blur();
  };
  window.closeNewChatView = closeNewChatView;
  const newChat = async () => {
    playClick(); closeCallsPage();
    const base = $id("sidebarDefaultView");
    const view = $id("newChatView");
    if (!base || !view) return;
    base.hidden = true;
    view.hidden = false;
    const input = $id("newChatSearch");
    if (input) input.value = "";
    renderConnectedContacts();
    requestAnimationFrame(() => input?.focus());
  };
  // The reference uses a dedicated in-sidebar New chat screen rather than a modal.
  // Keep the existing dropdown DOM only as a legacy fallback, but don't open it.
  $id("newChatBtn")?.addEventListener("click", newChat);
  $id("newChatMenuMessage")?.addEventListener("click", () => { newChat(); });
  $id("newChatMenuGroup")?.addEventListener("click", () => { playClick(); openNewGroupModal(); });
  $id("navNewChatBtn")?.addEventListener("click", newChat);
  $id("newChatBackBtn")?.addEventListener("click", () => { playClick(); closeNewChatView(); });
  $id("newChatNewGroupBtn")?.addEventListener("click", () => { playClick(); openNewGroupModal(); });
  $id("newChatNewContactBtn")?.addEventListener("click", () => {
    playClick();
    const input = $id("newChatSearch");
    if (!input) return;
    input.focus();
    showToast("Search a CUNNACT username or email to find a contact.", "info");
  });
  $id("newChatNewCommunityBtn")?.addEventListener("click", () => {
    playClick();
    const composer = $id("communityComposerModal");
    if (composer) openModal("communityComposerModal");
    else $id("navCommunitiesBtn")?.click();
  });
  $id("newChatContactsBtn")?.addEventListener("click", () => {
    playClick();
    $id("newChatSearch")?.focus();
  });
  $id("newGroupBtn")?.addEventListener("click", () => { playClick(); openNewGroupModal(); });
  $id("createGroupBtn")?.addEventListener("click", createGroup);
  $id("sendGroupPollBtn")?.addEventListener("click", sendGroupPoll);
  $id("sendGroupEventBtn")?.addEventListener("click", sendGroupEvent);
  $id("addGroupMembersBtn")?.addEventListener("click", addGroupMembers);
  $id("leaveGroupBtn")?.addEventListener("click", leaveGroupChat);
  $id("requestsBtn")?.addEventListener("click", () => { playClick(); openModal("requestsModal"); });
  $id("navRequestsBtn")?.addEventListener("click", () => { playClick(); openModal("requestsModal"); });
  $id("navCallsBtn")?.addEventListener("click", () => { playClick(); closeProfileDrawer(); openCallsPage(); });
  $id("callsStartBtn")?.addEventListener("click", () => { playClick(); openStartCallPicker(); });
  $id("callsAddBtn")?.addEventListener("click", () => { playClick(); openStartCallPicker(); });
  $id("callsDialBtn")?.addEventListener("click", () => { playClick(); openStartCallPicker(); });
  $id("callsNumberBtn")?.addEventListener("click", () => { playClick(); openStartCallPicker(); });
  $id("callsLinkBtn")?.addEventListener("click", () => { playClick(); showToast("Choose a contact first; the active call can then be shared with its call link.", "info"); openStartCallPicker(); });
  $id("callsScheduleBtn")?.addEventListener("click", () => { playClick(); showToast("Call scheduling is not enabled in the current CUNNACT backend.", "info"); });
  $id("callsAddFavouriteBtn")?.addEventListener("click", () => { playClick(); showToast("Select a recent contact, then add favourites from contact settings.", "info"); });
  $id("callsSearch")?.addEventListener("input", debounce(e => { callsPageSearch=String(e.target.value||""); renderCallsPageHistory(); }, 140));
  $id("callPickerSearch")?.addEventListener("input", debounce(e => renderCallPicker(e.target.value), 120));

  $id("savedBtn")?.addEventListener("click", async () => { playClick(); openModal("savedModal"); await renderSavedMessages(); });
  $id("navSavedBtn")?.addEventListener("click", async () => { playClick(); openModal("savedModal"); await renderSavedMessages(); });
  $id("navChatsBtn")?.addEventListener("click", () => { playClick(); closeCallsPage(); $id("app")?.classList.remove("chat-open","status-open","channels-open"); $id("statusView")?.setAttribute("hidden", "true"); $id("statusPanel")?.setAttribute("hidden", "true"); $id("channelsView")?.setAttribute("hidden", "true"); $id("channelsPanel")?.setAttribute("hidden", "true"); $id("sidebarDefaultView")?.removeAttribute("hidden"); });
  $id("userSearch")?.addEventListener("input", debounce((e) => { chatSearchTerm = normalizeSearch(e.target.value); renderChatList(); }, 120));
  $id("newChatSearch")?.addEventListener("input", debounce((e) => loadNewChatSearch(e.target.value), 320));
  $id("messageForm")?.addEventListener("submit", handleMessageSubmit);
  $id("messageInput")?.addEventListener("input", () => { autoGrowComposer(); handleTypingInput(); });
  $id("messageInput")?.addEventListener("blur", stopTyping);
  $id("emojiBtn")?.addEventListener("click",()=>toggleComposerPanel("emojiPanel"));
  $id("stickerBtn")?.addEventListener("click",()=>toggleComposerPanel("stickerPanel"));
  $id("voiceNoteBtn")?.addEventListener("click",recordVoiceNote);
  $id("chatSearchBtn")?.addEventListener("click",()=>{openModal("conversationSearchModal");setTimeout(()=> $id("conversationSearchInput")?.focus(),20);});
  $id("selectionCancelBtn")?.addEventListener("click",()=>setSelectionMode(false));
  $id("selectionDeleteBtn")?.addEventListener("click",deleteSelectedForMe);
  $id("selectionSaveBtn")?.addEventListener("click",saveSelectedMessages);
  $id("selectionForwardBtn")?.addEventListener("click",()=>openForwardModal([...selectedMessageIds].map(id=>currentMessages.find(m=>m.id===id)).filter(Boolean)));
  $id("editMessageCancelBtn")?.addEventListener("click",cancelEdit);
  $id("editMessageSaveBtn")?.addEventListener("click",saveEdit);
  $id("conversationSearchInput")?.addEventListener("input",debounce(e=>searchCurrentConversation(e.target.value),160));
  document.querySelectorAll("#stickerPanel button[data-sticker]").forEach(b=>b.addEventListener("click",()=>sendSticker(b.dataset.sticker)));
  $id("attachBtn")?.addEventListener("click", () => { playClick(); toggleComposerPanel("attachmentPanel"); });
  document.querySelectorAll("[data-attach-action]").forEach(btn=>btn.addEventListener("click",()=>{
    const action=btn.dataset.attachAction; const input=$id("fileInput"); const panel=$id("attachmentPanel"); if(panel)panel.hidden=true;
    if(action==="contact") return $id("contactBtn")?.click();
    if(action==="location") return $id("locationBtn")?.click();
    if(action==="poll") return $id("pollBtn")?.click();
    if(action==="event") return $id("eventBtn")?.click();
    if(action==="sticker") return $id("stickerBtn")?.click();
    if(!input)return;
    const originalAccept=input.getAttribute("accept")||"";
    if(action==="document") input.setAttribute("accept","application/pdf,text/plain,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx");
    else if(action==="audio") input.setAttribute("accept","audio/*");
    else if(action==="camera") { input.setAttribute("accept","image/*,video/*"); input.setAttribute("capture","environment"); }
    else input.setAttribute("accept","image/*,video/*");
    input.click();
    const restore=()=>{input.setAttribute("accept",originalAccept);input.removeAttribute("capture");input.removeEventListener("change",restore);};
    input.addEventListener("change",restore,{once:true});
  }));
  $id("fileInput")?.addEventListener("change", handleMediaSelection);
  $id("imagePreviewCancel")?.addEventListener("click", cancelImagePreview);
  $id("imagePreviewSend")?.addEventListener("click", sendPendingMedia);
  $id("mediaQuality")?.addEventListener("change", e => { mediaQuality = e.target.value; renderMediaPreview(); });
  $id("gifBtn")?.addEventListener("click", openGifModal);
  $id("gifSendBtn")?.addEventListener("click", sendGifFromModal);
  $id("contactBtn")?.addEventListener("click", openContactShareModal);
  $id("locationBtn")?.addEventListener("click", shareCurrentLocation);
  $id("pollBtn")?.addEventListener("click", openGroupPollModal);
  $id("eventBtn")?.addEventListener("click", openGroupEventModal);
  $id("chatVoiceCallBtn")?.addEventListener("click", () => startActiveCall("voice"));
  $id("chatVideoCallBtn")?.addEventListener("click", () => startActiveCall("video"));
  $id("groupCallBtn")?.addEventListener("click", () => startActiveCall("video"));
  $id("callHistoryBtn")?.addEventListener("click", () => activeConversationId && callController.showHistory(activeConversationId));
  $id("groupInviteBtn")?.addEventListener("click", openGroupInviteModal);
  $id("groupJoinRequestsBtn")?.addEventListener("click", openGroupJoinRequestsModal);
  $id("groupSettingsBtn")?.addEventListener("click", openGroupSettingsModal);
  $id("saveGroupSettingsBtn")?.addEventListener("click", saveGroupSettings);
  $id("saveGroupPhotoBtn")?.addEventListener("click", uploadGroupPhoto);
  $id("copyGroupInviteBtn")?.addEventListener("click", copyGroupInvite);
  $id("closeGroupInviteBtn")?.addEventListener("click", () => closeModal("groupInviteModal"));
  $id("cancelReplyBtn")?.addEventListener("click", clearReply);
  $id("closeProfileDrawer")?.addEventListener("click", closeProfileDrawer);
  $id("drawerViewProfile")?.addEventListener("click", () => { if (activeUser?.uid === currentUser?.uid) return; if (activeUser?.username) location.href=`/u/${encodeURIComponent(activeUser.username)}`; });
  document.querySelectorAll(".close-modal").forEach((button) => button.addEventListener("click", () => { playClick(); closeModal(button.closest(".modal")?.id); }));
  document.querySelectorAll(".modal").forEach((modal) => modal.addEventListener("click", (e) => { if (e.target === modal) modal.id === "confirmModal" ? finishConfirmDialog(false) : closeModal(modal.id); }));
  $id("confirmActionBtn")?.addEventListener("click", () => { playClick(); finishConfirmDialog(true); });
  $id("confirmCancelBtn")?.addEventListener("click", () => { playClick(); finishConfirmDialog(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$id("confirmModal")?.hidden) finishConfirmDialog(false);
      else document.querySelectorAll(".modal:not([hidden])").forEach((m) => closeModal(m.id));
      closeMessageActionMenus(); closeProfileDrawer();
    }
    if (e.key === "Enter" && !e.shiftKey && document.activeElement === $id("messageInput")) { e.preventDefault(); $id("messageForm")?.requestSubmit(); }
  });
  document.addEventListener("click", (e) => {
    ["accountMenu", "chatMoreMenu"].forEach((id) => { const m=$id(id); if (!m || m.hidden) return; if (!m.parentElement?.contains(e.target)) { m.hidden=true; } });
    if (!e.target.closest(".message-action-menu") && !e.target.closest(".message-more")) closeMessageActionMenus();
  });
  $id("messages")?.addEventListener("scroll", () => { if ($id("messages").scrollTop < 80) $id("messages").classList.add("near-top"); else $id("messages").classList.remove("near-top"); });
  $id("chatPopoutBtn")?.addEventListener("click",()=>{if(!activeConversationId)return;const url=`${location.origin}${location.pathname}?conversation=${encodeURIComponent(activeConversationId)}&popup=1`;window.open(url,"cunnact-chat","popup,width=980,height=760,resizable=yes,scrollbars=yes");});
  enableDesktopShortcuts();
  bindDesktopSharing();
}
async function logout() {
  try { await callController.leaveCall().catch(() => {}); await setOwnPresence(false); await signOut(auth); } catch (e) { console.error(e); showToast("Could not log out.", "error"); }
}

/* Requests */
function updateRequestsBadge(count) {
  [$id("requestsBadge"), $id("navRequestsBadge")].forEach((badge) => {
    if (!badge) return;
    badge.textContent=count>99?"99+":String(count);
    badge.hidden=count<=0;
  });
}
function renderMessageRequests(requests) {
  const container=$id("requestsList"); if(!container) return;
  if(!requests.length){container.innerHTML='<div class="empty-state">No new requests.<br><span>New connection requests will appear here.</span></div>';return;}
  container.innerHTML=requests.map(req=>`<div class="request-item" data-request-id="${escapeHtml(req.id)}">${avatarHtml({name:req.senderName,email:req.senderEmail},{dot:false})}<div class="meta"><strong>${escapeHtml(req.senderName||req.senderUsername||"User")}</strong>${req.senderUsername?`<span class="email">@${escapeHtml(req.senderUsername)}</span>`:""}<span class="subtitle">Wants to start a conversation</span></div><div class="actions"><button class="btn btn-sm btn-primary accept-request" type="button">Accept</button><button class="btn btn-sm btn-soft decline-request" type="button">Decline</button></div></div>`).join("");
  requests.forEach((req,index)=>{const row=container.querySelectorAll(".request-item")[index];paintAvatar(row?.querySelector(".avatar"),{photoURL:req.senderPhotoURL||"",name:req.senderName,email:req.senderEmail});});
  container.querySelectorAll(".request-item").forEach(row=>{
    const req=requests.find(r=>r.id===row.dataset.requestId); if(!req)return;
    row.querySelector(".accept-request")?.addEventListener("click",async()=>{const btn=row.querySelector(".accept-request");btn.disabled=true;btn.textContent="Accepting…";const id=await acceptMessageRequest(req.id,req,currentUser);if(id){closeModal("requestsModal");await openChatById(id,req.senderId);}else{btn.disabled=false;btn.textContent="Accept";}});
    row.querySelector(".decline-request")?.addEventListener("click",async()=>{const btn=row.querySelector(".decline-request");btn.disabled=true;btn.textContent="Declining…";const ok=await declineMessageRequest(req.id);if(!ok){btn.disabled=false;btn.textContent="Decline";}});
  });
}

/* Search */
function matchesChat(user, term){
  if(!term)return true;
  const n=String(user?.name||"").toLowerCase(),e=String(user?.email||"").toLowerCase(),u=String(user?.username||"").toLowerCase();
  return n.includes(term)||e.includes(term)||u.includes(term);
}
function directConversations(){
  const byUid=new Map();
  conversations.forEach(c=>{
    if(c?.type === "group") return;
    const uid=otherUid(c);
    if(!uid || byUid.has(uid)) return;
    byUid.set(uid,c);
  });
  return [...byUid.values()];
}
async function renderConnectedContacts(){
  const renderToken=++newChatRenderToken;
  const box=$id("newChatResults"); if(!box)return;
  const direct=directConversations();
  if(!direct.length){
    const selfName = currentUserData?.name || currentUser?.displayName || "You";
    box.innerHTML = `<div class="new-chat-side-empty-wrap"><button class="new-person-row self-chat-row" type="button" id="newChatSelfRow">${avatarHtml({...currentUserData,uid:currentUser.uid,name:selfName},{dot:false})}<span class="meta"><strong>${escapeHtml(selfName)} (You)</strong><span>Message yourself</span></span></button><div class="new-chat-side-note">Search by @CUNNACT ID or email to start a conversation.</div></div>`;
    paintAvatar($id("newChatSelfRow")?.querySelector('.avatar'),{...currentUserData,uid:currentUser.uid,name:selfName});
    $id("newChatSelfRow")?.addEventListener("click",()=>showToast("Self-chat is not enabled in this CUNNACT build yet.","info"));
    return;
  }
  box.innerHTML='<div class="new-chat-section"><div class="new-chat-section-title">Your contacts</div><div class="new-chat-contact-list" id="connectedContactsList"><div class="empty-state">Loading contacts…</div></div><div class="new-chat-hint">Search above to find someone new.</div></div>';
  const list=$id("connectedContactsList");
  const contacts=[];
  for(const c of direct){
    const uid=otherUid(c);
    if(!uid)continue;
    let user=userListeners.get(uid)?.data;
    if(!user){
      try{const snap=await getDoc(doc(db,"users",uid));user=snap.exists()?{uid,...snap.data()}:{uid,name:"User"};}
      catch{user={uid,name:"User"};}
    }
    contacts.push({user,conversation:c});
  }
  contacts.sort((a,b)=>{
    const ap=a.conversation?.pinned?.[currentUser.uid]?1:0, bp=b.conversation?.pinned?.[currentUser.uid]?1:0;
    if(ap!==bp)return bp-ap;
    const at=a.conversation?.lastMessageTime?.toMillis?.()??a.conversation?.createdAt?.toMillis?.()??0;
    const bt=b.conversation?.lastMessageTime?.toMillis?.()??b.conversation?.createdAt?.toMillis?.()??0;
    if(at!==bt)return bt-at;
    return String(a.user?.name||a.user?.username||"").localeCompare(String(b.user?.name||b.user?.username||""));
  });
  if(!list || renderToken!==newChatRenderToken || String($id("newChatSearch")?.value||"").trim())return;
  const selfName = currentUserData?.name || currentUser?.displayName || "You";
  const selfRow = `<button class="new-person-row self-chat-row" type="button" id="newChatSelfRow">${avatarHtml({...currentUserData,uid:currentUser.uid,name:selfName},{dot:false})}<span class="meta"><strong>${escapeHtml(selfName)} (You)</strong><span>Message yourself</span></span></button>`;
  const sorted = contacts.slice().sort(({user:a},{user:b})=>String(a?.name||a?.displayName||a?.username||"").localeCompare(String(b?.name||b?.displayName||b?.username||""),undefined,{sensitivity:"base"}));
  const groups = {};
  sorted.forEach(({user,conversation})=>{const name=String(user?.name||user?.displayName||user?.username||"User");const letter=name.trim().charAt(0).toUpperCase().match(/[A-Z]/)?.[0]||"#";(groups[letter] ||= []).push({user,conversation});});
  const letters=Object.keys(groups).sort();
  list.innerHTML = selfRow + (letters.length ? letters.map(letter=>`<div class="new-chat-letter" aria-hidden="true">${letter}</div>${groups[letter].map(({user,conversation})=>`<button class="new-person-row connected-contact-row" data-uid="${escapeHtml(user.uid)}" type="button">${avatarHtml(user,{dot:true})}<span class="meta"><strong>${escapeHtml(user.name||user.displayName||"User")}</strong><span>${user.username?`@${escapeHtml(user.username)}`:(user.email?escapeHtml(user.email):"Available")}</span></span></button>`).join("")}`).join("") : "") + `<div class="new-chat-side-note">Search above to find anyone on CUNNACT.</div>`;
  paintAvatar($id("newChatSelfRow")?.querySelector('.avatar'),{...currentUserData,uid:currentUser.uid,name:selfName});
  $id("newChatSelfRow")?.addEventListener("click",()=>showToast("Self-chat is not enabled in this CUNNACT build yet.","info"));
  contacts.forEach(({user,conversation})=>{
    const row=list.querySelector(`.connected-contact-row[data-uid="${CSS.escape(user.uid)}"]`);
    paintAvatar(row?.querySelector('.avatar'),user);
    row?.addEventListener('click',async()=>{closeNewChatView();await openChatById(conversation.id,user.uid);});
  });
}
async function loadNewChatSearch(value){
  const renderToken=++newChatRenderToken;
  const box=$id("newChatResults"); if(!box)return;
  const raw=String(value||"").trim();
  if(!raw){renderConnectedContacts();return;}
  const username=raw.replace(/^@/i,"").toLowerCase();
  if((raw.startsWith("@") || (!raw.includes("@") && USERNAME_PATTERN.test(username))) && username.length>=3){
    box.innerHTML='<div class="empty-state">Searching CUNNACT ID…</div>';
    try{const map=await getDoc(doc(db,"usernames",username));if(!map.exists()){box.innerHTML='<div class="empty-state">No CUNNACT account found.</div>';return;}const uid=map.data()?.uid;if(!uid||uid===currentUser.uid){box.innerHTML='<div class="empty-state">No other account found.</div>';return;}const snap=await getDoc(doc(db,"publicProfiles",uid));if(!snap.exists()){box.innerHTML='<div class="empty-state">Public profile is unavailable.</div>';return;}const profile=snap.data();if(renderToken!==newChatRenderToken)return;renderNewChatResults([{uid,...profile,email:""}],box);}catch(e){console.error(e);if(renderToken===newChatRenderToken)box.innerHTML='<div class="empty-state">Could not search right now.</div>';}return;
  }
  if(!isSearchValid(raw)){box.innerHTML='<div class="empty-state">Enter at least 6 characters of an email address, or use @username.</div>';return;}
  box.innerHTML='<div class="empty-state">Searching email…</div>';
  try{const term=raw.toLowerCase();const snap=await getDocs(query(collection(db,"users"),orderBy("emailLower"),startAt(term),endAt(`${term}\uf8ff`),limit(20)));if(renderToken!==newChatRenderToken)return;renderNewChatResults(snap.docs.map(d=>({uid:d.id,...d.data()})).filter(u=>u.uid!==currentUser.uid),box);}catch(e){console.error(e);if(renderToken===newChatRenderToken)box.innerHTML=`<div class="empty-state">Search unavailable.<br><span>${escapeHtml(e?.code||"Try again")}</span></div>`;}
}
function requestActionState(user){
  const connected=conversations.some(c=>c.type!="group" && c.members?.includes(user.uid));
  const blocked=currentBlockedUsers.has(user.uid);
  const outgoing=getOutgoingPendingRequest(user.uid);
  if(blocked) return {label:"Blocked",disabled:true,kind:"blocked",requestId:""};
  if(connected) return {label:"Open chat",disabled:false,kind:"connected",requestId:""};
  if(outgoing) return {label:"Cancel request",disabled:false,kind:"cancel",requestId:outgoing.id};
  return {label:"Send request",disabled:false,kind:"send",requestId:""};
}
function refreshNewChatRequestButtons(){
  document.querySelectorAll(".new-person-row").forEach(row=>{
    const btn=row.querySelector(".new-chat-action");
    if(!btn || btn.dataset.busy==="true") return;
    const state=requestActionState({uid:row.dataset.uid});
    btn.disabled=state.disabled;
    btn.textContent=state.label;
    btn.dataset.action=state.kind;
    btn.dataset.requestId=state.requestId;
    btn.classList.toggle("btn-primary", state.kind !== "blocked" && state.kind !== "cancel");
    btn.classList.toggle("btn-soft", state.kind === "blocked" || state.kind === "cancel");
    btn.classList.toggle("danger-item", state.kind === "cancel");
  });
}
function renderNewChatResults(matches,box){
  if(!matches.length){box.innerHTML='<div class="empty-state">No CUNNACT account found.</div>';return;}
  box.innerHTML=`<div class="new-chat-section"><div class="new-chat-section-title">Search results</div>${matches.map(user=>{const state=requestActionState(user);return `<div class="new-person-row" data-uid="${escapeHtml(user.uid)}">${avatarHtml(user,{dot:false})}<div class="meta"><strong>${escapeHtml(user.name||user.displayName||"User")}</strong><span>@${escapeHtml(user.username||"")}</span></div><button class="btn ${state.kind==="send"||state.kind==="connected"?"btn-primary":"btn-soft"}${state.kind==="cancel"?" danger-item":""} btn-sm new-chat-action" data-action="${state.kind}" data-request-id="${escapeHtml(state.requestId||"")}" ${state.disabled?"disabled":""}>${state.label}</button></div>`;}).join("")}<div class="new-chat-hint">Search by @CUNNACT ID or email to connect with someone new.</div></div>`;
  box.querySelectorAll(".new-person-row").forEach((row,index)=>{
    const user=matches[index];
    paintAvatar(row.querySelector(".avatar"),user);
    row.querySelector(".new-chat-action")?.addEventListener("click",async()=>{
      const btn=row.querySelector(".new-chat-action");
      if(!btn || btn.disabled || btn.dataset.busy==="true") return;
      const state=requestActionState(user);
      if(state.kind==="blocked") return;
      if(state.kind==="connected") {
        const c=conversations.find(c=>c.type!=="group" && c.members?.includes(user.uid));
        if(c){closeNewChatView();await openChatById(c.id,user.uid);}return;
      }
      if(state.kind==="cancel") {
        btn.dataset.busy="true";btn.disabled=true;btn.textContent="Cancelling…";
        const ok=await cancelMessageRequest(state.requestId);
        btn.dataset.busy="false";
        if(ok){refreshNewChatRequestButtons();}else{btn.disabled=false;btn.textContent="Cancel request";}
        return;
      }
      btn.dataset.busy="true";btn.disabled=true;btn.textContent="Sending…";
      const senderProfile={uid:currentUser.uid,email:currentUser.email,displayName:currentUserData.name||currentUser.displayName,photoURL:currentUserData.photoURL||currentUser.photoURL||"",username:currentUserData.username||""};
      const result=await sendMessageRequest(senderProfile,user.uid,user);
      btn.dataset.busy="false";
      if(result?.alreadyExists){closeNewChatView();await openChatById(result.conversationId,user.uid);}
      else if(result?.pending){btn.disabled=false;refreshNewChatRequestButtons();}
      else if(result?.incomingPending){btn.disabled=false;btn.textContent="Check requests";}
      else if(result){refreshNewChatRequestButtons();setTimeout(()=>closeNewChatView(),550);}
      else{refreshNewChatRequestButtons();}
    });
  });
}

async function consumeGroupInviteLink(){
  const params=new URLSearchParams(location.search);const groupId=params.get("groupInvite"),token=params.get("invite");if(!groupId||!token||!currentUser)return;
  try{
    const inviteSnap=await getDoc(doc(db,"conversations",groupId,"invites",token));
    if(!inviteSnap.exists()||inviteSnap.data()?.active!==true)throw new Error("INVITE_INVALID");
    if(conversations.some(c=>c.id===groupId&&c.members?.includes(currentUser.uid))){await openChatById(groupId);return;}
    const invite=inviteSnap.data()||{};
    if(invite.joinApproval===false){
      await updateDoc(doc(db,"conversations",groupId),{members:arrayUnion(currentUser.uid),joinInviteToken:token});
      showToast("You joined the group 🎉","success");
      await openChatById(groupId);
    }else{
      const reqRef=doc(db,"conversations",groupId,"joinRequests",currentUser.uid);
      await setDoc(reqRef,{userId:currentUser.uid,userName:currentUserData.name||currentUser.displayName||"CUNNACT user",username:currentUserData.username||"",inviteToken:token,status:"pending",createdAt:serverTimestamp(),updatedAt:serverTimestamp()},{merge:true});
      showToast("Join request sent — a group admin will approve it.","success");
    }
    const clean=new URL(location.href);clean.searchParams.delete("groupInvite");clean.searchParams.delete("invite");history.replaceState({},"",clean.toString());
  }catch(e){console.error("Group invite failed",e);showToast("This group invite is invalid or unavailable.","error");}
}
function openNewChatWithQuery(value){
  $id("sidebarDefaultView")?.setAttribute("hidden", "true");
  $id("newChatView")?.removeAttribute("hidden");
  const input=$id("newChatSearch");
  if(input){input.value=value.startsWith("@")?value:`@${value}`;loadNewChatSearch(input.value);setTimeout(()=>input.focus(),20);}
  history.replaceState({},"",location.pathname);
}

/* Conversations */
function listenConversations(){
  unsubscribeConversations?.();
  const q=query(collection(db,"conversations"),where("members","array-contains",currentUser.uid),limit(100));
  unsubscribeConversations=onSnapshot(q,(snap)=>{
    conversations=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.lastMessageTime?.toMillis?.()??b.createdAt?.toMillis?.()??0)-(a.lastMessageTime?.toMillis?.()??a.createdAt?.toMillis?.()??0));
    const activeUids=new Set(conversations.map(otherUid).filter(Boolean));
    for(const [uid,entry] of userListeners){ if(!activeUids.has(uid) && uid!==activeUser?.uid){ entry.unsub?.(); userListeners.delete(uid); } }
    conversations.forEach(c=>ensureUserListener(otherUid(c)));
    callController.syncConversationListeners(conversations);
    renderChatList();
    if (!callLinkConsumed) { callLinkConsumed = true; callController.consumeCallLink().catch(() => {}); consumeGroupInviteLink().catch(() => {}); }
  },e=>{console.error(e);$id("chatList").innerHTML='<div class="empty-state">Chats could not be loaded.<br><span>Check your Firebase connection and rules.</span></div>';});
}
function otherUid(c){return Array.isArray(c.members)?c.members.find(uid=>uid!==currentUser.uid):null;}
function ensureUserListener(uid){if(!uid||userListeners.has(uid))return;const entry={data:null,unsub:null};entry.unsub=onSnapshot(doc(db,"users",uid),snap=>{entry.data=snap.exists()?{uid,...snap.data()}:{uid};renderChatList();if(activeUser?.uid===uid){activeUser={...activeUser,...entry.data};refreshChatHeader();renderProfileDrawer();}},e=>console.warn("User listener failed",uid,e));userListeners.set(uid,entry);}
function conversationDisplay(c){
  if(c.type==="group")return{uid:null,isGroup:true,name:c.groupName||"Group",photoURL:c.groupPhotoURL||"",memberCount:(c.members||[]).length};
  const uid=otherUid(c);return userListeners.get(uid)?.data||{uid,name:"Conversation"};
}
function renderChatList(){
  const box=$id("chatList");if(!box||!currentUser)return;
  const visible=conversations.filter(c=>!c.hiddenFor?.[currentUser.uid]);
  const filtered=visible.filter(c=>matchesChat(conversationDisplay(c),chatSearchTerm))
    .sort((a,b)=>{const pa=a.pinned?.[currentUser.uid]?1:0,pb=b.pinned?.[currentUser.uid]?1:0;if(pa!==pb)return pb-pa;return(b.lastMessageTime?.toMillis?.()??b.createdAt?.toMillis?.()??0)-(a.lastMessageTime?.toMillis?.()??a.createdAt?.toMillis?.()??0);});
  if(!filtered.length){box.innerHTML=chatSearchTerm?`<div class="empty-state">No conversations match “${escapeHtml(chatSearchTerm)}”.</div>`:'<div class="empty-state big">Your inbox is quiet.<br><span>Start a new chat to connect.</span></div>';return;}
  box.innerHTML=filtered.map(c=>{const isGroup=c.type==="group";const uid=isGroup?null:otherUid(c);const user=conversationDisplay(c),unread=Number(c.unread?.[currentUser.uid]||0),when=c.lastMessageTime?.toDate?.()||c.createdAt?.toDate?.(),blocked=!isGroup&&currentBlockedUsers.has(uid),pinned=!!c.pinned?.[currentUser.uid],locked=!!currentUserSettings?.lockedChats?.[c.id],selected=selectedConversationIds.has(c.id);let preview=locked?"🔒 Locked chat":(c.lastMessage?previewText({type:c.lastMessageType,text:c.lastMessage},{isMine:c.lastMessageSenderId===currentUser.uid}):"No messages yet");if(!locked&&isGroup&&c.lastMessage&&c.lastMessageSenderId&&c.lastMessageSenderId!==currentUser.uid){const senderName=(userListeners.get(c.lastMessageSenderId)?.data?.name||"").split(" ")[0];if(senderName)preview=`${senderName}: ${preview}`;}if(!locked&&localHiddenLatest.has(c.id))preview="Message hidden for you";return `<button class="chat-item ${activeConversationId===c.id?"active":""} ${pinned?"is-pinned":""} ${chatSelectionMode&&selected?"chat-selected":""}" data-conversation-id="${escapeHtml(c.id)}" type="button">${chatSelectionMode?`<span class="chat-select-check ${selected?"selected":""}" aria-hidden="true">${selected?'✓':''}</span>`:''}${avatarHtml(user,{dot:!isGroup})}${isGroup?`<span class="group-badge">${ICONS.profile}</span>`:""}${locked?'<span class="chat-lock-indicator" title="Locked chat">🔒</span>':''}<span class="meta"><span class="top-line"><strong>${escapeHtml(user.name||"User")}</strong>${pinned?`<span class="pin-indicator" title="Pinned">${ICONS.bookmark}</span>`:""}<span class="time">${escapeHtml(when?formatWhen(when):"")}</span></span><span class="preview-line"><span class="text">${escapeHtml(blocked?"Blocked":preview)}</span>${unread>0&&!blocked&&!locked?`<span class="unread-badge">${unread>99?"99+":unread}</span>`:""}</span></span></button>`;}).join("");
  filtered.forEach(c=>{const isGroup=c.type==="group";const uid=isGroup?null:otherUid(c);const user=conversationDisplay(c),row=box.querySelector(`[data-conversation-id="${CSS.escape(c.id)}"]`);paintAvatar(row?.querySelector(".avatar"),user);if(!isGroup)setStatusDot(row?.querySelector(".status-dot"),isUserOnline(user));});
  box.querySelectorAll(".chat-item").forEach(row=>{
    let pressTimer=null,longPressed=false;
    row.addEventListener("click",()=>{if(longPressed){longPressed=false;return;}const c=conversations.find(x=>x.id===row.dataset.conversationId);if(!c)return;playClick();if(chatSelectionMode){toggleSelectedConversation(c.id);return;}openChatById(c.id); });
    row.addEventListener("contextmenu",(e)=>{e.preventDefault();showChatItemContextMenu(row.dataset.conversationId,row,e.clientX,e.clientY);});
    row.addEventListener("touchstart",()=>{longPressed=false;pressTimer=setTimeout(()=>{longPressed=true;if(navigator.vibrate)navigator.vibrate(12);const r=row.getBoundingClientRect();showChatItemContextMenu(row.dataset.conversationId,row,r.left+20,r.top+20);},480);},{passive:true});
    row.addEventListener("touchend",()=>{clearTimeout(pressTimer);});
    row.addEventListener("touchmove",()=>{clearTimeout(pressTimer);});
  });
}

async function markAllChatsRead(){
  if(!currentUser)return;
  const unread=conversations.filter(c=>Number(c.unread?.[currentUser.uid]||0)>0 && !c.hiddenFor?.[currentUser.uid]);
  if(!unread.length){showToast("All chats are already marked as read.","info");return;}
  try{
    const batch=writeBatch(db);
    unread.forEach(c=>batch.update(doc(db,"conversations",c.id),{[`unread.${currentUser.uid}`]:0}));
    await batch.commit();
    showToast(`${unread.length} chat${unread.length===1?"":"s"} marked as read.`,"success");
  }catch(e){
    console.error("Mark all chats read failed",e);
    showToast(e?.code==="permission-denied"?"Firebase blocked marking chats as read.":"Could not mark all chats as read.","error");
  }
}

function updateChatSelectionToolbar(){
  const toolbar=$id("chatSelectionToolbar");
  const count=$id("chatSelectionCount");
  if(toolbar)toolbar.hidden=!chatSelectionMode;
  if(count)count.textContent=`${selectedConversationIds.size} selected`;
}
function setChatSelectionMode(enabled){
  chatSelectionMode=!!enabled;
  selectedConversationIds.clear();
  updateChatSelectionToolbar();
  renderChatList();
}
function toggleSelectedConversation(id){
  if(selectedConversationIds.has(id))selectedConversationIds.delete(id);else selectedConversationIds.add(id);
  updateChatSelectionToolbar();
  renderChatList();
}
async function markSelectedChatsRead(){
  const ids=[...selectedConversationIds];
  if(!ids.length){showToast("Select at least one chat.","info");return;}
  try{
    const batch=writeBatch(db);
    ids.forEach(id=>batch.update(doc(db,"conversations",id),{[`unread.${currentUser.uid}`]:0}));
    await batch.commit();
    showToast(`${ids.length} chat${ids.length===1?"":"s"} marked as read.`,"success");
    setChatSelectionMode(false);
  }catch(e){
    console.error("Mark selected chats read failed",e);
    showToast(e?.code==="permission-denied"?"Firebase blocked marking these chats as read.":"Could not mark selected chats as read.","error");
  }
}

/* Active chat */
async function openChatById(conversationId,hintedUid=null){
  const convLocked=!!currentUserSettings?.lockedChats?.[conversationId]; if(convLocked && !(await requireAppUnlock())) return;
  if(!currentUser||!conversationId)return;
  try{
    const snap=await getDoc(doc(db,"conversations",conversationId));if(!snap.exists()){showToast("Conversation is not available yet.","info");return;}
    const data=snap.data(),members=data.members||[];if(!members.includes(currentUser.uid)){showToast("You don't have access to this conversation.","error");return;}
    closeMessageActionMenus();stopTyping();unsubscribeTyping?.();unsubscribeTyping=null;unsubscribeMessages?.();unsubscribeMessages=null;cleanupInterval?.();cleanupInterval=null;
    activeConversationId=conversationId;activeConversation={id:conversationId,...data};

    if(data.type==="group"){
      const profiles=await Promise.all(members.map(async uid=>{
        if(uid===currentUser.uid)return[uid,{uid,name:currentUserData.name||"You",photoURL:currentUserData.photoURL||""}];
        const cached=userListeners.get(uid)?.data;
        if(cached)return[uid,cached];
        try{const s=await getDoc(doc(db,"users",uid));return[uid,s.exists()?{uid,...s.data()}:{uid,name:"Member"}];}catch{return[uid,{uid,name:"Member"}];}
      }));
      activeGroupMembers=new Map(profiles);
      members.forEach(uid=>{if(uid!==currentUser.uid)ensureUserListener(uid);});
      activeUser={uid:null,isGroup:true,name:data.groupName||"Group",photoURL:data.groupPhotoURL||"",memberCount:members.length,members,admins:data.groupAdmins||[],moderators:data.groupModerators||[],roles:data.groupRoles||{},joinApproval:data.joinApproval!==false,description:data.groupDescription||"",inviteVersion:data.inviteVersion||1};
    }else{
      const other=members.find(uid=>uid!==currentUser.uid)||hintedUid;if(!other)return;
      const user=userListeners.get(other)?.data||(await getDoc(doc(db,"users",other))).data();if(!user){showToast("User profile not found.","error");return;}
      activeGroupMembers=new Map();
      activeUser={uid:other,isGroup:false,...user};
      ensureUserListener(other);
    }

    $id("app")?.classList.add("chat-open");clearImagePreview();clearReply();$id("chatMoreBtn").disabled=false;$id("chatPopoutBtn")?.removeAttribute("disabled");$id("chatMoreBtn")?.setAttribute("aria-hidden","false");refreshChatHeader();setComposerState();renderProfileDrawer();renderChatList();
    await updateDoc(doc(db,"conversations",conversationId),{[`unread.${currentUser.uid}`]:0}).catch(()=>{});
    listenMessages();listenTyping();
  }catch(e){console.error("Open chat failed",e);showToast(e?.code==="permission-denied"?"You don't have access to this chat.":"Could not open this chat.","error");}
}
function refreshChatHeader(){
  if(!activeUser)return;
  if(activeUser.isGroup){
    $id("chatName").textContent=activeUser.name||"Group";
    const typingCount=0; // set by listenTyping via #chatTyping directly
    $id("chatStatus").textContent=`${activeUser.memberCount||activeUser.members?.length||0} members`;
    $id("chatStatusPill").hidden=true;
    setStatusDot($id("chatStatusDot"),false);
    paintAvatar($id("chatAvatar"),{photoURL:activeUser.photoURL,name:activeUser.name});
    setComposerState();
    $id("chatVoiceCallBtn")?.setAttribute("hidden","");
    $id("chatVideoCallBtn")?.setAttribute("hidden","");
    $id("groupCallBtn")?.removeAttribute("hidden");
    $id("pollBtn")?.removeAttribute("hidden");
    $id("eventBtn")?.removeAttribute("hidden");
    return;
  }
  const live=userListeners.get(activeUser.uid)?.data;if(live)activeUser={...activeUser,...live};$id("groupCallBtn")?.setAttribute("hidden","");
  $id("pollBtn")?.setAttribute("hidden","");
  $id("eventBtn")?.setAttribute("hidden","");
  $id("chatVoiceCallBtn")?.removeAttribute("hidden");
  $id("chatVideoCallBtn")?.removeAttribute("hidden");
  const online=isUserOnline(activeUser),blocked=currentBlockedUsers.has(activeUser.uid);$id("chatName").textContent=activeUser.name||(activeUser.username?`@${activeUser.username}`:"User");
  // Last seen is mutual: if either side has turned it off, neither can see the other's last-seen time.
  const canSeeLastSeen=currentUserData.hideLastSeen!==true&&activeUser.hideLastSeen!==true;
  const status=blocked?"Blocked by you":online?"Active now":(canSeeLastSeen?`Offline · ${formatLastSeen(activeUser.lastSeen?.toDate?.()||null)}`:"Offline");$id("chatStatus").textContent=status;$id("chatStatusPill").hidden=!online||blocked;if(!$id("chatStatusPill").hidden)$id("chatStatusPill").textContent="Online";setStatusDot($id("chatStatusDot"),online&&!blocked);paintAvatar($id("chatAvatar"),{photoURL:activeUser.photoURL,name:activeUser.name,email:activeUser.email});setComposerState();}
function isBlockedByEither(){return !!(activeUser&&currentBlockedUsers.has(activeUser.uid));}
function setComposerState(){const blocked=isBlockedByEither(),enabled=!!activeUser&&!!activeConversationId&&!blocked&&!sendingMessage;$id("chatSearchBtn")?.toggleAttribute("disabled",!activeConversationId);$id("chatPopoutBtn")?.toggleAttribute("disabled",!activeConversationId);["messageInput","attachBtn","emojiBtn","stickerBtn","gifBtn","contactBtn","locationBtn","pollBtn","eventBtn","voiceNoteBtn"].forEach(id=>{const el=$id(id);if(el)el.disabled=!enabled;});$id("messageForm")?.querySelector("button[type=submit]")?.toggleAttribute("disabled",!enabled);const input=$id("messageInput");if(input)input.placeholder=blocked?"Messaging is blocked":"Write a message…";const notice=$id("blockedNotice");if(blocked){notice.hidden=false;notice.innerHTML=`<span>${ICONS.block}</span><span>You blocked this person. Unblock them to continue.</span>`;}else notice.hidden=true;}
function renderChatMoreMenu(){
  const menu=$id("chatMoreMenu");if(!menu||!activeUser)return;
  const icon=(svg)=>`<span class="chat-more-icon" aria-hidden="true">${svg}</span>`;
  const arrow=`<span class="chat-more-arrow" aria-hidden="true">›</span>`;
  const I={
    info:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M12 10v6M12 7h.01"/></svg>',
    search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/></svg>',
    select:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="m8 12 2.5 2.5L16 9"/></svg>',
    mute:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M11 5 6 9H3v6h3l5 4V5Z"/><path d="m16 9 5 5M21 9l-5 5"/></svg>',
    timer:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="13" r="7"/><path d="M12 13V9M9 3h6M12 3v3"/></svg>',
    lock:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M7 10V7a5 5 0 0 1 10 0v3"/></svg>',
    star:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></svg>',
    list:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M8 9h8M8 12h8M8 15h5"/></svg>',
    download:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 4v10M8 10l4 4 4-4"/><path d="M5 19h14"/></svg>',
    close:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    link:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M10 13.5 14 9.5"/><path d="M7.5 16.5H6a4 4 0 0 1 0-8h3"/><path d="M16.5 7.5H18a4 4 0 1 1 0 8h-3"/></svg>',
    calendar:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 9h16M8 13h.01M12 13h.01M16 13h.01M8 17h.01M12 17h.01"/></svg>',
    groupCall:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="9" cy="8" r="3"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><circle cx="17.5" cy="8.5" r="2.5"/><path d="M15.5 13.5A6 6 0 0 1 21 20"/></svg>',
    flag:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M5 21V4M5 5c4-3 7 3 14 0v9c-7 3-10-3-14 0"/></svg>',
    block:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="m7 7 10 10"/></svg>'
  };
  const item=(id,label,svg,extra="")=>`<button class="dropdown-item chat-more-item ${extra}" id="${id}" type="button">${icon(svg)}<span>${label}</span></button>`;
  const itemArrow=(id,label,svg)=>`<button class="dropdown-item chat-more-item" id="${id}" type="button">${icon(svg)}<span>${label}</span>${arrow}</button>`;
  const separator='<div class="chat-menu-separator" role="separator"></div>';

  if(activeUser.isGroup){
    const isAdmin=(activeUser.admins||[]).includes(currentUser.uid);
    const isModerator=isAdmin||(activeUser.moderators||[]).includes(currentUser.uid);
    menu.innerHTML=`
      ${item("viewProfileBtn","Group info",I.info)}
      ${item("groupSearchBtn","Search",I.search)}
      ${item("groupSelectBtn","Select messages",I.select)}
      ${item("groupMuteBtn","Mute notifications",I.mute)}
      ${item("disappearingBtn","Disappearing messages",I.timer)}
      ${item("groupSettingsMenuBtn","Group settings",I.lock)}
      ${item("groupInviteMenuBtn","Invite to group",I.link)}
      ${isAdmin?item("groupJoinRequestsMenuBtn","Join requests",I.groupCall):""}
      ${isModerator?item("groupPollMenuBtn","Create poll",I.calendar)+item("groupEventMenuBtn","Create event",I.calendar):""}
      ${item("groupCallHistoryMenuBtn","Call history",I.groupCall)}
      ${item("clearChatBtn","Clear chat",I.close)}
      ${separator}
      ${item("leaveGroupMenuBtn","Exit group",I.block,"danger-item")}`;
    menu.querySelector("#viewProfileBtn")?.addEventListener("click",()=>{menu.hidden=true;openProfileDrawer();});
    menu.querySelector("#groupSearchBtn")?.addEventListener("click",()=>{menu.hidden=true;openModal("conversationSearchModal");setTimeout(()=> $id("conversationSearchInput")?.focus(),30);});
    menu.querySelector("#groupSelectBtn")?.addEventListener("click",()=>{menu.hidden=true;setSelectionMode(true);});
    menu.querySelector("#groupMuteBtn")?.addEventListener("click",async()=>{menu.hidden=true;await toggleConversationMute();});
    menu.querySelector("#groupInviteMenuBtn")?.addEventListener("click",()=>{menu.hidden=true;openGroupInviteModal();});
    menu.querySelector("#groupJoinRequestsMenuBtn")?.addEventListener("click",()=>{menu.hidden=true;openGroupJoinRequestsModal();});
    menu.querySelector("#groupSettingsMenuBtn")?.addEventListener("click",()=>{menu.hidden=true;openGroupSettingsModal();});
    menu.querySelector("#groupPollMenuBtn")?.addEventListener("click",()=>{menu.hidden=true;openGroupPollModal();});
    menu.querySelector("#groupEventMenuBtn")?.addEventListener("click",()=>{menu.hidden=true;openGroupEventModal();});
    menu.querySelector("#groupCallHistoryMenuBtn")?.addEventListener("click",()=>{menu.hidden=true;callController.showHistory(activeConversationId);});
    menu.querySelector("#clearChatBtn")?.addEventListener("click",async()=>{menu.hidden=true;await clearChatForMe();});
    menu.querySelector("#leaveGroupMenuBtn")?.addEventListener("click",async()=>{menu.hidden=true;await leaveGroupChat();});
    menu.querySelector("#disappearingBtn")?.addEventListener("click",()=>{menu.hidden=true;setDisappearingMessages();});
    return;
  }

  const blocked=currentBlockedUsers.has(activeUser.uid);
  const isMuted=!!currentUserSettings?.mutedConversations?.[activeConversationId];
  const isFavourite=!!currentUserSettings?.favoriteConversations?.[activeConversationId];
  menu.innerHTML=`
    ${item("viewProfileBtn","Contact info",I.info)}
    ${item("chatMenuSearchBtn","Search",I.search)}
    ${item("chatMenuSelectBtn","Select messages",I.select)}
    ${item("muteNotificationsBtn",isMuted?"Unmute notifications":"Mute notifications",I.mute)}
    ${item("disappearingBtn","Disappearing messages",I.timer)}
    ${item("lockChatBtn",currentUserSettings?.lockedChats?.[activeConversationId]?"Unlock chat":"Lock chat",I.lock)}
    ${item("favoriteChatBtn",isFavourite?"Remove from favourites":"Add to favourites",I.star)}
    ${itemArrow("chatListMenuBtn","Add to list",I.list)}
    ${item("exportChatBtn","Export chat",I.download)}
    ${item("closeChatBtn","Close chat",I.close)}
    ${separator}
    ${item("sendCallLinkMenuBtn","Send call link",I.link)}
    ${item("scheduleCallMenuBtn","Schedule call",I.calendar)}
    ${item("newGroupCallMenuBtn","New group call",I.groupCall)}
    ${separator}
    ${item("reportUserBtn","Report",I.flag,"danger-item")}
    ${item("blockToggleBtn",blocked?"Unblock":"Block",I.block,blocked?"":"danger-item")}
    ${item("clearChatBtn","Clear chat",I.close,"danger-item")}
    ${item("deleteChatBtn","Delete chat",I.close,"danger-item")}`;

  menu.querySelector("#viewProfileBtn")?.addEventListener("click",()=>{menu.hidden=true;openProfileDrawer();});
  menu.querySelector("#chatMenuSearchBtn")?.addEventListener("click",()=>{menu.hidden=true;openModal("conversationSearchModal");setTimeout(()=> $id("conversationSearchInput")?.focus(),30);});
  menu.querySelector("#chatMenuSelectBtn")?.addEventListener("click",()=>{menu.hidden=true;setSelectionMode(true);});
  menu.querySelector("#muteNotificationsBtn")?.addEventListener("click",async()=>{menu.hidden=true;await toggleConversationMute();});
  menu.querySelector("#favoriteChatBtn")?.addEventListener("click",async()=>{menu.hidden=true;await toggleConversationFavourite();});
  menu.querySelector("#chatListMenuBtn")?.addEventListener("click",async()=>{menu.hidden=true;await addConversationToList();});
  menu.querySelector("#exportChatBtn")?.addEventListener("click",()=>{menu.hidden=true;exportCurrentChat();});
  menu.querySelector("#closeChatBtn")?.addEventListener("click",()=>{menu.hidden=true;closeActiveChat();});
  menu.querySelector("#sendCallLinkMenuBtn")?.addEventListener("click",()=>{menu.hidden=true;sendChatCallLink();});
  menu.querySelector("#scheduleCallMenuBtn")?.addEventListener("click",()=>{menu.hidden=true;showToast("Call scheduling is not configured yet.","info");});
  menu.querySelector("#newGroupCallMenuBtn")?.addEventListener("click",()=>{menu.hidden=true;startActiveCall("video");});
  menu.querySelector("#clearChatBtn")?.addEventListener("click",async()=>{menu.hidden=true;await clearChatForMe();});
  menu.querySelector("#deleteChatBtn")?.addEventListener("click",async()=>{menu.hidden=true;await deleteConversationForMe(activeConversationId);});
  menu.querySelector("#blockToggleBtn")?.addEventListener("click",async()=>{menu.hidden=true;const shouldBlock=!blocked;if(shouldBlock){const ok=await showConfirmDialog({title:"Block this user?",message:"They won't be able to send you messages until you unblock them.",confirmText:"Block user",cancelText:"Cancel",danger:true});if(!ok)return;}await toggleBlockUser(activeUser.uid,shouldBlock);});
  menu.querySelector("#reportUserBtn")?.addEventListener("click",async()=>{menu.hidden=true;const reason=window.prompt("Reason for reporting this user (optional)")||"General report";try{await setDoc(doc(collection(db,"reports")),{reporterId:currentUser.uid,reportedUserId:activeUser.uid,conversationId:activeConversationId,reason:String(reason).slice(0,300),createdAt:serverTimestamp(),status:"open"});showToast("Report submitted","success");}catch(e){showToast("Could not submit report","error");}});
  menu.querySelector("#disappearingBtn")?.addEventListener("click",()=>{menu.hidden=true;setDisappearingMessages();});
  menu.querySelector("#lockChatBtn")?.addEventListener("click",async()=>{menu.hidden=true;await toggleChatLock();});
}

async function toggleConversationMute(){
  if(!currentUser||!activeConversationId)return;
  const map={...(currentUserSettings?.mutedConversations||{})};
  const next=!map[activeConversationId];
  if(next)map[activeConversationId]=true;else delete map[activeConversationId];
  try{await setUserSetting(currentUser.uid,{mutedConversations:map});currentUserSettings={...currentUserSettings,mutedConversations:map};showToast(next?"Notifications muted":"Notifications unmuted","success");}
  catch(e){console.error("Mute update failed",e);showToast("Could not update notification setting.","error");}
}

async function toggleConversationFavourite(){
  if(!currentUser||!activeConversationId)return;
  const map={...(currentUserSettings?.favoriteConversations||{})};
  const next=!map[activeConversationId];
  if(next)map[activeConversationId]=true;else delete map[activeConversationId];
  try{await setUserSetting(currentUser.uid,{favoriteConversations:map});currentUserSettings={...currentUserSettings,favoriteConversations:map};showToast(next?"Added to favourites":"Removed from favourites","success");}
  catch(e){console.error("Favourite update failed",e);showToast("Could not update favourites.","error");}
}

async function addConversationToList(){
  if(!currentUser||!activeConversationId)return;
  const name=window.prompt("List name","Friends");
  const listName=String(name||"").trim().slice(0,40);if(!listName)return;
  const lists={...(currentUserSettings?.chatLists||{})};
  lists[listName]=Array.from(new Set([...(lists[listName]||[]),activeConversationId]));
  try{await setUserSetting(currentUser.uid,{chatLists:lists});currentUserSettings={...currentUserSettings,chatLists:lists};showToast(`Added to ${listName}`,"success");}
  catch(e){console.error("Chat list update failed",e);showToast("Could not add chat to the list.","error");}
}

function exportCurrentChat(){
  if(!activeConversationId||!activeUser)return;
  const title=activeUser.name||"CUNNACT chat";
  const lines=currentMessages.map(m=>{const sender=m.senderId===currentUser?.uid?"You":(activeGroupMembers.get(m.senderId)?.name||userListeners.get(m.senderId)?.data?.name||activeUser.name||"User");const when=m.createdAt?.toDate?.()?formatTime(m.createdAt.toDate()):"";const text=m.type==="image"?"[Photo]":m.type==="video"?"[Video]":m.type==="audio"?"[Audio]":m.type==="document"?`[Document: ${m.fileName||"file"}]`:(m.text||"[Message]");return `[${when}] ${sender}: ${text}`;});
  const blob=new Blob([`CUNNACT chat export — ${title}\n\n`,...lines.join("\n")],{type:"text/plain;charset=utf-8"});
  const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`CUNNACT-${title.replace(/[^a-z0-9-_]+/gi,"-").replace(/^-|-$/g,"")||"chat"}.txt`;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);showToast("Chat exported","success");
}

function closeActiveChat(){
  closeMessageActionMenus();clearImagePreview();clearReply();stopTyping();unsubscribeTyping?.();unsubscribeTyping=null;unsubscribeMessages?.();unsubscribeMessages=null;activeConversationId=null;activeConversation=null;activeUser=null;activeGroupMembers=new Map();currentMessages=[];activeMessageMap=new Map();$id("app")?.classList.remove("chat-open");$id("chatMoreBtn")?.setAttribute("disabled","");$id("chatPopoutBtn")?.setAttribute("disabled","");setComposerState();renderChatList();renderProfileDrawer();
}

function sendChatCallLink(){
  if(!activeConversationId||!activeUser)return;
  showToast("Start the call first, then use Share link from the active call screen.","info");
}

function setDisappearingMessages(){
  if(!activeConversationId||!activeConversation)return;
  const value=window.prompt("Disappearing messages: 0=off, or seconds (60, 3600, 86400)",String(activeConversation?.disappearingSeconds||0));
  const seconds=Number(value);
  if(!Number.isInteger(seconds)||seconds<0||seconds>604800){showToast("Use 0 or a value up to 7 days.","error");return;}
  updateDoc(doc(db,"conversations",activeConversationId),{disappearingSeconds:seconds}).then(()=>{activeConversation={...activeConversation,disappearingSeconds:seconds};showToast(seconds?"Disappearing messages updated":"Disappearing messages off","success");}).catch(e=>showToast(e?.code==="permission-denied"?"Only a chat member can change this setting.":"Could not update disappearing messages","error"));
}

async function toggleChatLock(){
  if(!activeConversationId||!currentUser)return;
  const locked=!!currentUserSettings?.lockedChats?.[activeConversationId];
  currentUserSettings.lockedChats={...(currentUserSettings.lockedChats||{})};
  try{
    if(locked){
      delete currentUserSettings.lockedChats[activeConversationId];
      await setUserSetting(currentUser.uid,{lockedChats:currentUserSettings.lockedChats});
      showToast("Chat unlocked","success");
    }else{
      if(!isAppLockEnabled(currentUserSettings)){
        const pin=window.prompt("Create a 4–8 digit CUNNACT lock PIN");
        if(!/^\d{4,8}$/.test(pin||"")){showToast("PIN must be 4–8 digits.","error");return;}
        const {salt,hash}=await createPinHash(pin);currentUserSettings.appLockEnabled=true;currentUserSettings.appLockSalt=salt;currentUserSettings.appLockHash=hash;
        await setUserSetting(currentUser.uid,{appLockEnabled:true,appLockSalt:salt,appLockHash:hash});
      }
      currentUserSettings.lockedChats[activeConversationId]=true;await setUserSetting(currentUser.uid,{lockedChats:currentUserSettings.lockedChats});showToast("Chat locked","success");
    }
    renderChatList();renderChatMoreMenu();
  }catch(e){console.error(e);showToast("Could not update chat lock.","error");}
}

async function startActiveCall(callType="voice"){
  if(!activeConversationId||!activeUser||!currentUser)return;
  const ids=activeUser.isGroup?(activeUser.members||[]).filter(uid=>uid!==currentUser.uid):[activeUser.uid];
  await callController.startCall({conversationId:activeConversationId,participantIds:ids,callType,type:activeUser.isGroup?"group":"direct",title:activeUser.isGroup?(activeUser.name||"Group call"):(activeUser.name||"Call")});
}

async function clearChatForMe(){
  if(!activeConversationId||!currentUser)return false;
  const ok=await showConfirmDialog({title:"Clear this chat?",message:"All messages will be removed from your view only. The other person will still see them.",confirmText:"Clear chat",cancelText:"Cancel",danger:true});
  if(!ok)return false;
  try{
    const msgsSnap=await getDocs(collection(db,"conversations",activeConversationId,"messages"));
    if(msgsSnap.empty){showToast("Chat is already empty","info");return true;}
    const docs=msgsSnap.docs;
    for(let i=0;i<docs.length;i+=450){
      const batch=writeBatch(db);
      docs.slice(i,i+450).forEach(d=>batch.update(d.ref,{deletedFor:arrayUnion(currentUser.uid)}));
      await batch.commit();
    }
    localHiddenLatest.add(activeConversationId);
    renderChatList();
    showToast("Chat cleared","success");
    return true;
  }catch(e){
    console.error("Clear chat failed",e);
    showToast(e?.code==="permission-denied"?"You don't have permission to clear this chat.":"Could not clear the chat. Try again.","error");
    return false;
  }
}

async function deleteConversationForMe(conversationId){
  if(!conversationId||!currentUser)return false;
  const ok=await showConfirmDialog({title:"Delete this chat?",message:"This removes the entire conversation from your chat list. The other person keeps their copy.",confirmText:"Delete chat",cancelText:"Cancel",danger:true});
  if(!ok)return false;
  try{
    await updateDoc(doc(db,"conversations",conversationId),{[`hiddenFor.${currentUser.uid}`]:true,[`pinned.${currentUser.uid}`]:false});
    if(activeConversationId===conversationId){activeConversationId=null;activeUser=null;$id("app")?.classList.remove("chat-open");}
    renderChatList();
    showToast("Chat deleted","success");
    return true;
  }catch(e){
    console.error("Delete chat failed",e);
    showToast(e?.code==="permission-denied"?"You don't have permission to delete this chat.":"Could not delete the chat. Try again.","error");
    return false;
  }
}

async function togglePinConversation(conversationId){
  if(!conversationId||!currentUser)return false;
  const c=conversations.find(x=>x.id===conversationId);
  const nowPinned=!(c?.pinned?.[currentUser.uid]);
  try{
    await updateDoc(doc(db,"conversations",conversationId),{[`pinned.${currentUser.uid}`]:nowPinned});
    renderChatList();
    showToast(nowPinned?"Chat pinned":"Chat unpinned","success");
    return true;
  }catch(e){
    console.error("Pin chat failed",e);
    showToast("Could not update pin. Try again.","error");
    return false;
  }
}

function closeChatItemContextMenu(){document.querySelector(".chat-item-context-menu")?.remove();}

async function logGroupEvent(type, details = {}){
  if(!activeConversationId || !currentUser || !activeUser?.isGroup) return;
  try{
    const ref=doc(collection(db,"conversations",activeConversationId,"groupEvents"));
    await setDoc(ref,{
      type, actorId:currentUser.uid, actorName:currentUserData?.name||currentUser.displayName||"Member",
      targetUid:String(details.targetUid||""), targetName:String(details.targetName||""),
      fromRole:String(details.fromRole||""), toRole:String(details.toRole||""),
      details:String(details.details||"").slice(0,300), createdAt:serverTimestamp()
    });
  }catch(e){ console.warn("Group activity log failed", e); }
}

async function reportActiveGroup(){
  if(!activeConversationId||!activeUser?.isGroup||!currentUser)return;
  const reason=window.prompt("Why are you reporting this group?", "Spam or unwanted content")?.trim();
  if(!reason)return;
  try{
    await setDoc(doc(collection(db,"conversations",activeConversationId,"reports")),{reportedBy:currentUser.uid,type:"group",reason:reason.slice(0,300),createdAt:serverTimestamp(),targetGroup:activeUser.name||"Group"});
    showToast("Group report submitted","success");
  }catch(e){console.error("Group report failed",e);showToast(e?.code==="permission-denied"?"Firebase blocked this report. Deploy the latest firestore.rules.":"Could not report this group.","error");}
}

async function openGroupChangesModal(){
  if(!activeConversationId||!activeUser?.isGroup)return;
  const box=$id("groupChangesList"); if(!box)return;
  box.innerHTML='<div class="empty-state">Loading member changes…</div>';
  openModal("groupChangesModal");
  try{
    const snap=await getDocs(query(collection(db,"conversations",activeConversationId,"groupEvents"),orderBy("createdAt","desc"),limit(50)));
    if(snap.empty){box.innerHTML='<div class="empty-state">No member changes have been recorded for this group yet.</div>';return;}
    box.innerHTML=snap.docs.map(d=>{const e=d.data()||{};const when=e.createdAt?.toDate?.();let text=e.details||e.type||"Group updated";if(e.type==="member_added")text=`${e.targetName||"A member"} was added`;else if(e.type==="member_removed")text=`${e.targetName||"A member"} was removed`;else if(e.type==="role_changed")text=`${e.targetName||"A member"} changed from ${e.fromRole||"member"} to ${e.toRole||"member"}`;else if(e.type==="member_left")text=`${e.targetName||e.actorName||"A member"} left the group`;else if(e.type==="group_created")text="Group created";else if(e.type==="group_renamed")text=`Group renamed${e.targetName?` to ${e.targetName}`:""}`;return `<div class="group-change-row"><div class="group-change-icon">${ICONS.profile}</div><div class="group-change-copy"><strong>${escapeHtml(text)}</strong><span>${escapeHtml(e.actorName||"Member")} · ${escapeHtml(when?formatWhen(when):"Recently")}</span></div></div>`;}).join("");
  }catch(e){console.error("Group changes load failed",e);box.innerHTML='<div class="empty-state">Could not load member changes. Check your Firebase rules.</div>';}
}

// --- Group chat: create, rename, membership ---
async function promptRenameGroup(){
  if(!activeConversationId||!activeUser?.isGroup)return;
  const name=window.prompt("Group name",activeUser.name||"")?.trim();
  if(!name||name===activeUser.name)return;
  try{
    await updateDoc(doc(db,"conversations",activeConversationId),{groupName:name.slice(0,60)});
    activeUser.name=name.slice(0,60);
    refreshChatHeader();renderChatList();renderProfileDrawer();
    await logGroupEvent("group_renamed",{targetName:name.slice(0,60),details:`Group renamed to ${name.slice(0,60)}`});
    showToast("Group renamed","success");
  }catch(e){console.error("Rename group failed",e);showToast("Could not rename the group.","error");}
}

async function leaveGroupChat(){
  if(!activeConversationId||!activeUser?.isGroup||!currentUser)return;
  const ok=await showConfirmDialog({title:"Leave this group?",message:"You'll stop receiving messages from this group. You can be added back later by a member.",confirmText:"Leave group",cancelText:"Cancel",danger:true});
  if(!ok)return;
  try{
    const c=conversations.find(x=>x.id===activeConversationId);
    const remainingMembers=(c?.members||activeUser.members||[]).filter(uid=>uid!==currentUser.uid);
    const remainingAdmins=(c?.groupAdmins||activeUser.admins||[]).filter(uid=>uid!==currentUser.uid);
    const remainingModerators=(c?.groupModerators||activeUser.moderators||[]).filter(uid=>uid!==currentUser.uid);
    const remainingRoles={...(c?.groupRoles||activeUser.roles||{})};delete remainingRoles[currentUser.uid];
    const leavingName=currentUserData?.name||currentUser.displayName||"Member";
    await logGroupEvent("member_left",{targetUid:currentUser.uid,targetName:leavingName,details:`${leavingName} left the group`});
    await updateDoc(doc(db,"conversations",activeConversationId),{members:remainingMembers,groupAdmins:remainingAdmins,groupModerators:remainingModerators,groupRoles:remainingRoles});
    activeConversationId=null;activeUser=null;activeConversation=null;$id("app")?.classList.remove("chat-open");
    closeProfileDrawer();renderChatList();
    showToast("You left the group","success");
  }catch(e){console.error("Leave group failed",e);showToast(e?.code==="permission-denied"?"Could not leave the group.":"Something went wrong leaving the group.","error");}
}

function contactList(){
  // People you already have a direct (1:1) conversation with — the pool group members are picked from.
  return conversations.filter(c=>c.type!=="group").map(c=>{const uid=otherUid(c);const user=userListeners.get(uid)?.data;return user?{uid,...user}:null;}).filter(Boolean);
}

function openNewGroupModal(){
  openModal("newGroupModal");
  const nameInput=$id("newGroupName");if(nameInput)nameInput.value="";
  const descInput=$id("newGroupDescription");if(descInput)descInput.value="";
  if($id("newGroupJoinApproval"))$id("newGroupJoinApproval").checked=true;
  $id("newGroupError").textContent="";
  renderGroupMemberPicker();
}

function renderGroupMemberPicker(){
  const box=$id("newGroupMemberPicker");if(!box)return;
  const contacts=contactList();
  if(!contacts.length){box.innerHTML='<div class="empty-state">Start a few 1:1 chats first — groups are built from people you already talk to.</div>';return;}
  box.innerHTML=contacts.map(u=>`<label class="contact-pick-row"><input type="checkbox" value="${escapeHtml(u.uid)}">${avatarHtml(u,{dot:false})}<span class="meta"><strong>${escapeHtml(u.name||"User")}</strong>${u.username?`<span>@${escapeHtml(u.username)}</span>`:""}</span></label>`).join("");
  contacts.forEach(u=>paintAvatar(box.querySelector(`.contact-pick-row input[value="${CSS.escape(u.uid)}"]`)?.closest(".contact-pick-row")?.querySelector(".avatar"),u));
}

async function createGroup(){
  const errBox=$id("newGroupError");errBox.textContent="";
  const name=$id("newGroupName")?.value.trim()||"";
  const checked=[...document.querySelectorAll("#newGroupMemberPicker input[type=checkbox]:checked")].map(i=>i.value);
  if(!name){errBox.textContent="Give your group a name.";return;}
  if(checked.length<2){errBox.textContent="Pick at least 2 people to start a group.";return;}
  const btn=$id("createGroupBtn");btn.disabled=true;btn.textContent="Creating…";
  try{
    const members=[currentUser.uid,...checked];
    const ref=doc(collection(db,"conversations"));
    const unread={};members.forEach(uid=>{unread[uid]=0;});
    await setDoc(ref,{
      type:"group",members,groupName:name.slice(0,60),groupPhotoURL:"",
      groupDescription:String($id("newGroupDescription")?.value||"").trim().slice(0,240),
      groupAdmins:[currentUser.uid],groupModerators:[],groupRoles:{[currentUser.uid]:"admin"},joinApproval:$id("newGroupJoinApproval")?.checked!==false,
      createdBy:currentUser.uid,createdAt:serverTimestamp(),
      lastMessage:"",lastMessageType:"text",lastMessageSenderId:"",lastMessageId:"",lastMessageTime:serverTimestamp(),
      unread,pinned:{},hiddenFor:{}
    });
    // Best-effort initial activity record; the group itself is already committed above.
    try{await setDoc(doc(ref,"groupEvents","created"),{type:"group_created",actorId:currentUser.uid,actorName:currentUserData?.name||currentUser.displayName||"Member",createdAt:serverTimestamp(),details:"Group created"});}catch(e){console.warn("Initial group event log failed",e);}
    closeModal("newGroupModal");
    showToast("Group created 🎉","success");
    await openChatById(ref.id);
  }catch(e){
    console.error("Create group failed",e);
    errBox.textContent=e?.code==="permission-denied"?"Could not create the group (permission denied).":"Something went wrong creating the group.";
  }finally{
    btn.disabled=false;btn.textContent="Create group";
  }
}

async function addGroupMembers(){
  if(!activeConversationId||!activeUser?.isGroup)return;
  const existing=new Set(activeUser.members||[]);
  const candidates=contactList().filter(u=>!existing.has(u.uid));
  if(!candidates.length){showToast("Everyone you chat with is already in this group.","info");return;}
  const picked=window.prompt(`Add by CUNNACT ID (comma-separated). Available: ${candidates.map(u=>u.username?`@${u.username}`:u.name).join(", ")}`);
  if(!picked)return;
  const wanted=picked.split(",").map(s=>s.trim().replace(/^@/,"").toLowerCase()).filter(Boolean);
  const toAdd=candidates.filter(u=>wanted.includes((u.username||"").toLowerCase())).map(u=>u.uid);
  if(!toAdd.length){showToast("Couldn't match those CUNNACT IDs to your contacts.","error");return;}
  try{
    const newMembers=[...existing,...toAdd];
    const unreadPatch={};toAdd.forEach(uid=>{unreadPatch[`unread.${uid}`]=0;});
    await updateDoc(doc(db,"conversations",activeConversationId),{members:newMembers,groupAdmins:activeUser.admins||[],groupModerators:activeUser.moderators||[],groupRoles:activeUser.roles||{},...unreadPatch});
    await Promise.all(toAdd.map(uid=>{const u=candidates.find(x=>x.uid===uid);return logGroupEvent("member_added",{targetUid:uid,targetName:u?.name||u?.username||"Member"});}));
    showToast("Members added","success");
    await openChatById(activeConversationId);
  }catch(e){console.error("Add members failed",e);showToast("Could not add members.","error");}
}

async function removeGroupMember(uid){
  if(!activeConversationId||!activeUser?.isGroup)return;
  const ok=await showConfirmDialog({title:"Remove this member?",message:"They'll lose access to this group's messages.",confirmText:"Remove",cancelText:"Cancel",danger:true});
  if(!ok)return;
  try{
    const newMembers=(activeUser.members||[]).filter(m=>m!==uid);
    const newAdmins=(activeUser.admins||[]).filter(m=>m!==uid);
    const newModerators=(activeUser.moderators||[]).filter(m=>m!==uid);
    const newRoles={...(activeUser.roles||{})};delete newRoles[uid];
    await updateDoc(doc(db,"conversations",activeConversationId),{members:newMembers,groupAdmins:newAdmins,groupModerators:newModerators,groupRoles:newRoles});
    showToast("Member removed","success");
    await openChatById(activeConversationId);
  }catch(e){console.error("Remove member failed",e);showToast(e?.code==="permission-denied"?"Only group admins can remove members.":"Could not remove that member.","error");}
}


async function openGroupInviteModal(){
  if(!activeConversationId||!activeUser?.isGroup)return;
  const box=$id("groupInviteLink");const qr=$id("groupInviteQr");
  try{
    const token=`${currentUser.uid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,14)}`.replace(/[^a-zA-Z0-9_\-]/g,"");
    const ref=doc(db,"conversations",activeConversationId,"invites",token);
    await setDoc(ref,{token,conversationId:activeConversationId,createdBy:currentUser.uid,active:true,joinApproval:activeUser.joinApproval!==false,groupName:activeUser.name||"Group",createdAt:serverTimestamp()});
    const url=new URL(location.href);url.search="";url.searchParams.set("groupInvite",activeConversationId);url.searchParams.set("invite",token);
    window.__cunnactGroupInviteUrl=url.href;
    if(box)box.value=url.href;
    if(qr)qr.src=`https://api.qrserver.com/v1/create-qr-code/?size=180x180&data=${encodeURIComponent(url.href)}`;
    openModal("groupInviteModal");
  }catch(e){console.error("Invite creation failed",e);showToast(e?.code==="permission-denied"?"Only group admins can create invite links.":"Could not create invite link.","error");}
}
async function copyGroupInvite(){const value=window.__cunnactGroupInviteUrl||$id("groupInviteLink")?.value;if(!value)return;try{await navigator.clipboard.writeText(value);showToast("Group invite link copied","success");}catch{showToast("Could not copy the invite link.","error");}}
async function openGroupJoinRequestsModal(){
  if(!activeConversationId||!activeUser?.isGroup)return;
  const box=$id("groupJoinRequestsList");if(!box)return;
  box.innerHTML='<div class="empty-state">Loading join requests…</div>';
  try{
    const snap=await getDocs(collection(db,"conversations",activeConversationId,"joinRequests"));
    const rows=snap.docs.map(d=>({id:d.id,...d.data()})).filter(x=>x.status==="pending");
    if(!rows.length){box.innerHTML='<div class="empty-state">No pending join requests.</div>';}
    else{box.innerHTML=rows.map(r=>`<div class="join-request-row" data-uid="${escapeHtml(r.userId)}"><div class="meta"><strong>${escapeHtml(r.userName||"CUNNACT user")}</strong><small>@${escapeHtml(r.username||"")}</small></div><div class="join-request-actions"><button type="button" class="btn btn-primary btn-sm approve-join">Approve</button><button type="button" class="btn btn-soft btn-sm reject-join">Reject</button></div></div>`).join("");
      box.querySelectorAll(".join-request-row").forEach(row=>{const uid=row.dataset.uid;row.querySelector(".approve-join")?.addEventListener("click",()=>resolveGroupJoinRequest(uid,true));row.querySelector(".reject-join")?.addEventListener("click",()=>resolveGroupJoinRequest(uid,false));});
    }
  }catch(e){console.error(e);box.innerHTML='<div class="empty-state">Join requests could not be loaded.</div>';}
  openModal("groupJoinRequestsModal");
}
async function resolveGroupJoinRequest(uid,approve){
  if(!activeConversationId||!activeUser?.isGroup||!(activeUser.admins||[]).includes(currentUser.uid)||!uid)return;
  try{
    const reqRef=doc(db,"conversations",activeConversationId,"joinRequests",uid);const reqSnap=await getDoc(reqRef);if(!reqSnap.exists())return;const req=reqSnap.data()||{};if(req.status!=="pending")return;
    const updates={status:approve?"approved":"rejected",reviewedBy:currentUser.uid,reviewedAt:serverTimestamp()};
    const batch=writeBatch(db);batch.update(reqRef,updates);
    if(approve && !activeUser.members.includes(uid)){
      const members=[...activeUser.members,uid];const unread={};unread[uid]=0;
      const roles={...(activeUser.roles||{}),[uid]:"member"};
      batch.update(doc(db,"conversations",activeConversationId),{members,unread,groupRoles:roles});
    }
    await batch.commit();showToast(approve?"Member approved":"Join request rejected","success");openGroupJoinRequestsModal();
  }catch(e){console.error(e);showToast("Could not update that join request. Deploy the latest firestore.rules.","error");}
}
async function openGroupSettingsModal(){
  if(!activeUser?.isGroup)return;
  $id("groupSettingsName").value=activeUser.name||"";$id("groupSettingsDescription").value=activeUser.description||"";$id("groupSettingsJoinApproval").checked=activeUser.joinApproval!==false;
  openModal("groupSettingsModal");
}
async function saveGroupSettings(){
  if(!activeConversationId||!activeUser?.isGroup)return;
  const isAdmin=(activeUser.admins||[]).includes(currentUser.uid);if(!isAdmin){showToast("Only group admins can change settings.","error");return;}
  const name=String($id("groupSettingsName")?.value||"").trim().slice(0,60);const description=String($id("groupSettingsDescription")?.value||"").trim().slice(0,240);if(!name){showToast("Group name cannot be empty.","error");return;}
  try{await updateDoc(doc(db,"conversations",activeConversationId),{groupName:name,groupDescription:description,joinApproval:$id("groupSettingsJoinApproval")?.checked!==false});closeModal("groupSettingsModal");await openChatById(activeConversationId);showToast("Group settings saved","success");}catch(e){console.error(e);showToast(e?.code==="permission-denied"?"Firebase blocked group settings. Deploy the latest firestore.rules.":"Could not save group settings.","error");}
}
async function uploadGroupPhoto(){
  if(!activeConversationId||!activeUser?.isGroup||!(activeUser.admins||[]).includes(currentUser.uid))return;
  const input=$id("groupPhotoInput");const file=input?.files?.[0];if(!file)return;
  try{const url=await uploadImageToCloudinary(file);await updateDoc(doc(db,"conversations",activeConversationId),{groupPhotoURL:url});showToast("Group photo updated","success");closeModal("groupSettingsModal");await openChatById(activeConversationId);}catch(e){console.error(e);showToast(e?.userMessage||"Could not upload group photo.","error");}finally{if(input)input.value="";}
}
async function openGroupPollModal(){if(!activeUser?.isGroup)return; $id("pollQuestion").value=""; $id("pollOptions").value="";openModal("groupPollModal");setTimeout(()=>$id("pollQuestion")?.focus(),20);}
async function sendGroupPoll(){if(!activeUser?.isGroup)return;const q=String($id("pollQuestion")?.value||"").trim();const options=String($id("pollOptions")?.value||"").split(/\n|,/).map(x=>x.trim()).filter(Boolean).slice(0,10);if(!q||options.length<2){showToast("Add a question and at least two options.","error");return;}try{await sendMessage({type:"poll",text:q,pollQuestion:q,pollOptions:options});closeModal("groupPollModal");playSend();showToast("Poll sent","success");}catch(e){console.error(e);showToast("Could not send the poll.","error");}}
async function openGroupEventModal(){if(!activeUser?.isGroup)return;$id("eventTitle").value="";$id("eventWhen").value="";$id("eventDescription").value="";openModal("groupEventModal");setTimeout(()=>$id("eventTitle")?.focus(),20);}
async function sendGroupEvent(){if(!activeUser?.isGroup)return;const title=String($id("eventTitle")?.value||"").trim();const when=String($id("eventWhen")?.value||"").trim();const desc=String($id("eventDescription")?.value||"").trim();if(!title||!when){showToast("Add an event title and date/time.","error");return;}try{await sendMessage({type:"event",text:title,eventTitle:title,eventWhen:new Date(when).toISOString(),eventDescription:desc});closeModal("groupEventModal");playSend();showToast("Event shared","success");}catch(e){console.error(e);showToast("Could not send the event.","error");}}

function showChatItemContextMenu(conversationId,anchorEl,clientX,clientY){
  closeChatItemContextMenu();
  const c=conversations.find(x=>x.id===conversationId);
  const isPinned=!!(c?.pinned?.[currentUser?.uid]);
  const menu=document.createElement("div");
  menu.className="message-action-menu chat-item-context-menu";
  menu.innerHTML=`<button class="menu-item pin-chat" type="button">${ICONS.bookmark}<span>${isPinned?"Unpin chat":"Pin chat"}</span></button><button class="menu-item danger-item delete-chat" type="button">${ICONS.trash}<span>Delete chat</span></button>`;
  document.body.appendChild(menu);
  const rect=anchorEl.getBoundingClientRect();
  const mr=menu.getBoundingClientRect();
  const top=Math.min(Math.max(8,clientY||rect.top),innerHeight-mr.height-8);
  const left=Math.min(Math.max(8,clientX||rect.left),innerWidth-mr.width-8);
  menu.style.top=`${top}px`;menu.style.left=`${left}px`;
  menu.querySelector(".pin-chat")?.addEventListener("click",async()=>{menu.remove();await togglePinConversation(conversationId);});
  menu.querySelector(".delete-chat")?.addEventListener("click",async()=>{menu.remove();await deleteConversationForMe(conversationId);});
  setTimeout(()=>document.addEventListener("click",closeChatItemContextMenu,{once:true}),0);
}
async function loadBlockedUsers(){currentBlockedUsers=new Set();if(!currentUser)return;try{const snap=await getDocs(collection(db,"users",currentUser.uid,"blockedUsers"));snap.docs.forEach(d=>currentBlockedUsers.add(d.id));}catch(e){console.warn(e);}}
async function toggleBlockUser(uid,shouldBlock){try{const ref=doc(db,"users",currentUser.uid,"blockedUsers",uid);if(shouldBlock)await setDoc(ref,{uid,createdAt:serverTimestamp()});else await deleteDoc(ref);shouldBlock?currentBlockedUsers.add(uid):currentBlockedUsers.delete(uid);renderChatList();refreshChatHeader();setComposerState();showToast(shouldBlock?"User blocked":"User unblocked","success");}catch(e){console.error(e);showToast("Could not update block setting.","error");}}

/* Typing */
function listenTyping(){unsubscribeTyping?.();if(!activeConversationId||currentUserData.showTypingIndicators===false)return;const dots='<i></i><i></i><i></i> ';unsubscribeTyping=onSnapshot(collection(db,"conversations",activeConversationId,"typing"),snap=>{const el=$id("chatTyping");if(!el)return;if(activeUser?.isGroup){const typers=snap.docs.filter(d=>d.id!==currentUser.uid&&d.data()?.typing===true).map(d=>(activeGroupMembers.get(d.id)?.name||"Someone").split(" ")[0]);el.hidden=!typers.length;if(typers.length)el.innerHTML=dots+escapeHtml(`${typers.slice(0,2).join(", ")}${typers.length>1?" are":" is"} typing…`);return;}const other=activeUser?.uid;const state=snap.docs.some(d=>d.id===other&&d.data()?.typing===true);el.hidden=!state;el.innerHTML=dots+"typing…";},()=>{const el=$id("chatTyping");if(el)el.hidden=true;});}
const sendTypingState=debounce(async(typing)=>{if(!activeConversationId||!currentUser||currentUserData.showTypingIndicators===false)return;const ref=doc(db,"conversations",activeConversationId,"typing",currentUser.uid);try{if(typing)await setDoc(ref,{uid:currentUser.uid,typing:true,updatedAt:serverTimestamp()},{merge:true});else await deleteDoc(ref);}catch(e){}},450);
function handleTypingInput(){const typing=!!$id("messageInput")?.value.trim();clearTimeout(window.__cunnactTypingTimer);if(typing){sendTypingState(true);window.__cunnactTypingTimer=setTimeout(()=>sendTypingState(false),2500);}else sendTypingState(false);}
function stopTyping(){clearTimeout(window.__cunnactTypingTimer);sendTypingState(false);}

/* Messages */
function listenMessages(){
  const token=++messageListenerToken;
  currentMessages=[];
  activeMessageMap=new Map();
  renderedMessageElsCleanup();
  const box=$id("messages");
  if(!box)return;
  box.innerHTML='<div class="empty-state big">Loading messages…</div>';
  const isNearBottom=()=>box.scrollHeight-box.scrollTop-box.clientHeight<120;

  readObserver?.disconnect();
  readObserver=new IntersectionObserver(entries=>{
    for(const entry of entries){
      if(entry.isIntersecting&&entry.intersectionRatio>0.35){
        const id=entry.target.dataset.messageId;
        if(id)queueRead(id);
      }
    }
  },{root:box,threshold:[0.35]});

  let settled=false;
  let retryTimer=0;
  const showLoadError=(message,detail="")=>{
    if(token!==messageListenerToken)return;
    clearTimeout(retryTimer);
    box.innerHTML=`<div class="empty-state">${escapeHtml(message)}<br><span>${escapeHtml(detail)}</span><br><button type="button" class="btn btn-soft btn-sm" id="retryMessagesBtn" style="margin-top:12px">Retry</button></div>`;
    $id("retryMessagesBtn")?.addEventListener("click",()=>listenMessages(),{once:true});
  };

  const applySnapshot=(snap)=>{
    if(token!==messageListenerToken)return;
    settled=true;
    clearTimeout(retryTimer);
    const wasAtBottom=isNearBottom();
    const beforeCount=currentMessages.length;
    const changes=snap.docChanges();
    try{
      // Sort in the browser so legacy messages without perfect Firestore ordering/indexing
      // cannot leave the chat stuck on a loading state.
      currentMessages=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>{
        const at=timestampDate(a.createdAt)?.getTime()??0;
        const bt=timestampDate(b.createdAt)?.getTime()??0;
        return at-bt || String(a.id).localeCompare(String(b.id));
      });
      activeMessageMap=new Map(currentMessages.map(m=>[m.id,m]));
      reconcileMessageDOM();
      if(beforeCount===0 && snap.docs.length<100){
        getDocs(query(collection(db,"conversations",activeConversationId,"messages"),limit(200))).then(fallback=>{
          if(token!==messageListenerToken)return;
          const merged=new Map(currentMessages.map(m=>[m.id,m]));
          fallback.docs.forEach(d=>merged.set(d.id,{id:d.id,...d.data()}));
          currentMessages=[...merged.values()].sort((a,b)=>{const at=timestampDate(a.createdAt)?.getTime()??0;const bt=timestampDate(b.createdAt)?.getTime()??0;return at-bt||String(a.id).localeCompare(String(b.id));}).slice(-200);
          activeMessageMap=new Map(currentMessages.map(m=>[m.id,m]));
          reconcileMessageDOM();
        }).catch(()=>{});
      }

      const incomingAdded=changes.some(c=>c.type==="added"&&c.doc.data()?.senderId!==currentUser.uid&&beforeCount>0);
      if(incomingAdded&&document.visibilityState==="visible")playReceive();
      const selfAdded=changes.some(c=>c.type==="added"&&c.doc.data()?.senderId===currentUser.uid);
      if(selfAdded||wasAtBottom||beforeCount===0)requestAnimationFrame(()=>{box.scrollTop=box.scrollHeight;});

      queueDeliveredForIncoming(currentMessages);
      if(document.visibilityState==="visible")observeVisibleIncoming();
      cleanupExpiredMessages(db,activeConversationId,currentMessages,currentUser.uid,updateDoc).catch(()=>{});

      // Only reconcile the conversation preview when the newest message actually changed.
      if(changes.some(c=>c.type==="added"||c.type==="removed"))updateConversationPreviewFromMessages();
    }catch(err){
      console.error("Message render failed",err);
      showLoadError("Messages couldn't be displayed.",err?.message||"UI rendering error");
    }
  };

  const handleError=(e)=>{
    if(token!==messageListenerToken)return;
    console.error("Message listener failed",e);
    clearTimeout(retryTimer);
    const code=e?.code||"unknown";
    if(["failed-precondition","invalid-argument"].includes(code)){
      // Retry without orderBy for legacy data / index mismatches.
      unsubscribeMessages?.();
      const fallbackQuery=query(collection(db,"conversations",activeConversationId,"messages"),limit(100));
      unsubscribeMessages=onSnapshot(fallbackQuery,applySnapshot,(fallbackErr)=>showLoadError("Messages couldn't be loaded.",fallbackErr?.code||code));
      return;
    }
    settled=true;
    const detail=code==="permission-denied"?"Firebase rules are blocking message reads.":"Check your connection and Firebase configuration.";
    showLoadError("Messages couldn't be loaded.",detail+` (${code})`);
  };

  // Load the newest 100 messages first. This avoids showing an old slice of a
  // long conversation and gives Firestore a deterministic index-free query.
  // We reverse them in applySnapshot so the chat still renders oldest → newest.
  const messagesQuery=query(collection(db,"conversations",activeConversationId,"messages"),orderBy("createdAt","desc"),limit(100));
  unsubscribeMessages=onSnapshot(messagesQuery,applySnapshot,handleError);

  // Never leave a user staring at an infinite loader if the listener is stalled.
  retryTimer=setTimeout(()=>{
    if(token!==messageListenerToken||settled)return;
    console.warn("Message listener timed out; retrying with a fresh listener.");
    unsubscribeMessages?.();
    const freshQuery=query(collection(db,"conversations",activeConversationId,"messages"),orderBy("createdAt","desc"),limit(100));
    unsubscribeMessages=onSnapshot(freshQuery,applySnapshot,(e)=>{
      if(["failed-precondition","invalid-argument"].includes(e?.code)){
        // Legacy installations may contain records without createdAt. Fall back
        // to a plain listener rather than trapping the user on Loading.
        unsubscribeMessages?.();
        const fallbackQuery=query(collection(db,"conversations",activeConversationId,"messages"),limit(100));
        unsubscribeMessages=onSnapshot(fallbackQuery,applySnapshot,(fallbackErr)=>showLoadError("Messages couldn't be loaded.",fallbackErr?.code||e?.code||"listener-error"));
      } else showLoadError("Messages couldn't be loaded.",e?.code||"listener-timeout");
    });
  },7000);

  cleanupInterval=startPeriodicCleanup(db,activeConversationId,()=>currentMessages,currentUser.uid,updateDoc);
}

function renderedMessageElsCleanup(){document.querySelectorAll("#messages .message, #messages .date-separator").forEach(el=>el.remove());}
function reconcileMessageDOM(){
  const box=$id("messages");if(!box)return;
  const visible=currentMessages.filter(m=>!isDeletedForUser(m,currentUser.uid)&&!shouldExpireMessage(m,currentUser.uid));
  if(!visible.length){box.innerHTML='<div class="empty-state big">No messages yet.<br><span>Send a message to start the conversation.</span></div>';activeMessageMap=new Map();return;}
  box.querySelectorAll(".empty-state").forEach(e=>e.remove());
  const visibleIds=new Set(visible.map(m=>m.id));
  document.querySelectorAll("#messages .message").forEach(el=>{if(!visibleIds.has(el.dataset.messageId))el.remove();});
  visible.forEach((message)=>{let el=box.querySelector(`.message[data-message-id="${CSS.escape(message.id)}"]`);if(!el){el=buildMessageElement(message);box.appendChild(el);}else updateMessageElement(el,message);if(readObserver&&message.receiverId===currentUser.uid)readObserver.observe(el);});
  // Ensure DOM order matches the timestamp order without replacing nodes.
  const ordered=visible.map(m=>box.querySelector(`.message[data-message-id="${CSS.escape(m.id)}"]`)).filter(Boolean);ordered.forEach((el,i)=>{const wanted=box.querySelectorAll(".message")[i];if(wanted!==el)box.insertBefore(el,wanted||null);});
  syncDateSeparators(visible); syncMessageGrouping(visible); observeVisibleIncoming();
}
function syncDateSeparators(visible){document.querySelectorAll("#messages .date-separator").forEach(e=>e.remove());let lastDay="";visible.forEach(m=>{const d=timestampDate(m.createdAt);if(!d)return;const day=d.toDateString();if(day===lastDay)return;lastDay=day;const first=$id("messages").querySelector(`.message[data-message-id="${CSS.escape(m.id)}"]`);if(first){const sep=document.createElement("div");sep.className="date-separator";sep.textContent=day===new Date().toDateString()?"Today":day===new Date(Date.now()-86400000).toDateString()?"Yesterday":d.toLocaleDateString([], {day:"numeric",month:"short",year:d.getFullYear()===new Date().getFullYear()?undefined:"numeric"});$id("messages").insertBefore(sep,first);}});}
function syncMessageGrouping(visible){visible.forEach((m,i)=>{const el=$id("messages").querySelector(`.message[data-message-id="${CSS.escape(m.id)}"]`);if(!el)return;const prev=visible[i-1],next=visible[i+1],d=timestampDate(m.createdAt)?.getTime()||0,pd=timestampDate(prev?.createdAt)?.getTime()||0,nd=timestampDate(next?.createdAt)?.getTime()||0;const samePrev=prev&&prev.senderId===m.senderId&&d-pd<5*60*1000,sameNext=next&&next.senderId===m.senderId&&nd-d<5*60*1000;el.classList.toggle("group-start",!samePrev);el.classList.toggle("group-middle",!!samePrev&&!!sameNext);el.classList.toggle("group-end",!!samePrev&&!sameNext);el.classList.toggle("solo",!samePrev&&!sameNext);});}
function buildMessageElement(message){
  const outgoing=message.senderId===currentUser.uid;const el=document.createElement("article");el.className=`message ${outgoing?"outgoing":"incoming"}`;el.dataset.messageId=message.id;el._message=message;el.classList.toggle("is-selected",selectedMessageIds.has(message.id));
  const bubble=document.createElement("div");bubble.className="message-bubble";el.appendChild(bubble);
  if(!outgoing&&activeUser?.isGroup){const senderName=(activeGroupMembers.get(message.senderId)?.name||userListeners.get(message.senderId)?.data?.name||"Member");const label=document.createElement("div");label.className="sender-name";label.textContent=senderName;bubble.appendChild(label);}
  if(message.replyTo){const quote=document.createElement("button");quote.type="button";quote.className="reply-quote";quote.innerHTML=`<span>${escapeHtml(message.replyTo.senderName||"Message")}</span><p>${escapeHtml(message.replyTo.text||"Photo")}</p>`;quote.addEventListener("click",()=>scrollToMessage(message.replyTo.messageId));bubble.appendChild(quote);}
  if(message.forwardedFrom){const f=document.createElement("div");f.className="forwarded-label";f.textContent=`↪ Forwarded from ${message.forwardedFrom.senderName||"Someone"}`;bubble.appendChild(f);}
  const viewedOnce=Array.isArray(message.viewedBy)&&message.viewedBy.includes(currentUser.uid);
  if(message.deletedAt){
    const p=document.createElement("p");p.className="deleted-message";p.textContent="This message was deleted";bubble.appendChild(p);
  }else if(message.viewOnce && viewedOnce){
    const p=document.createElement("p");p.className="deleted-message";p.textContent="View once media was opened";bubble.appendChild(p);
  }else if(message.viewOnce && !viewedOnce && (message.type==="image"||message.type==="video")){
    const btn=document.createElement("button");btn.type="button";btn.className="view-once-card";btn.innerHTML=`<strong>👁 View once</strong><small>${message.type==="video"?"Video":"Photo"} • Opens once on this device</small>`;btn.addEventListener("click",()=>openViewOnce(message));bubble.appendChild(btn);
  }else if(message.type==="image"&&isTrustedImageUrl(message.imageURL)){
    el.classList.add("image-message");const img=document.createElement("img");
    const preset=message.quality==="original"?null:(message.quality==="hd"?"hd":"chat");
    img.src=preset?imageUrl(message.imageURL,preset):message.imageURL;img.alt="Shared image";img.loading="lazy";img.addEventListener("click",()=>openLightbox(message.imageURL));bubble.appendChild(img);
  }else if(message.type==="gif"&&(isTrustedGifUrl(message.imageURL)||isTrustedImageUrl(message.imageURL))){
    el.classList.add("gif-message");const img=document.createElement("img");img.src=message.imageURL;img.alt="GIF";img.loading="lazy";img.addEventListener("click",()=>openLightbox(message.imageURL));bubble.appendChild(img);
  }else if(message.type==="audio"&&isTrustedCloudinaryUrl(message.mediaURL)){
    const audio=document.createElement("audio");audio.controls=true;audio.preload="metadata";audio.src=message.mediaURL;bubble.appendChild(audio);
  }else if(message.type==="video"&&isTrustedCloudinaryUrl(message.mediaURL)){
    el.classList.add("video-message");const video=document.createElement("video");video.controls=true;video.preload="metadata";video.playsInline=true;video.src=message.mediaURL;video.className="media-video";bubble.appendChild(video);
  }else if(message.type==="document"&&isTrustedCloudinaryUrl(message.mediaURL)){
    const a=document.createElement("a");a.href=message.mediaURL;a.target="_blank";a.rel="noopener noreferrer";a.className="document-card";a.download=message.fileName||"";a.innerHTML=`<span class="document-icon">📄</span><span><strong>${escapeHtml(message.fileName||"Document")}</strong><small>${escapeHtml(formatBytes(message.fileSize||0))}</small></span>`;bubble.appendChild(a);
  }else if(message.type==="contact"){
    const card=document.createElement("div");card.className="shared-contact-card";card.innerHTML=`<div class="shared-contact-avatar">${message.contactPhotoURL?`<img src="${escapeHtml(message.contactPhotoURL)}" alt="">`:`👤`}</div><div><strong>${escapeHtml(message.contactName||"Contact")}</strong><small>${message.contactUsername?`@${escapeHtml(message.contactUsername)}`:"CUNNACT contact"}</small></div>`;bubble.appendChild(card);
  }else if(message.type==="location"&&Number.isFinite(Number(message.latitude))&&Number.isFinite(Number(message.longitude))){
    const url=`https://www.google.com/maps?q=${encodeURIComponent(`${message.latitude},${message.longitude}`)}`;const card=document.createElement("a");card.className="shared-location-card";card.href=url;card.target="_blank";card.rel="noopener noreferrer";card.innerHTML=`<span class="location-icon">📍</span><span><strong>${escapeHtml(message.locationLabel||"Shared location")}</strong><small>Open in Google Maps</small></span>`;bubble.appendChild(card);
  }else if(message.type==="sticker"){
    const p=document.createElement("div");p.className="sticker-message";p.textContent=message.text||"✨";bubble.appendChild(p);
  }else if(message.type==="poll"){
    const card=document.createElement("div");card.className="group-poll-card";
    const q=document.createElement("strong");q.textContent=message.pollQuestion||message.text||"Poll";card.appendChild(q);
    const options=Array.isArray(message.pollOptions)?message.pollOptions:[];const mine=message.pollVotes?.[currentUser.uid];
    options.forEach((opt,i)=>{const btn=document.createElement("button");btn.type="button";btn.className="poll-option";btn.dataset.option=String(i);btn.innerHTML=`<span>${escapeHtml(opt)}</span><span>${Object.values(message.pollVotes||{}).filter(v=>Number(v)===i).length}</span>`;btn.addEventListener("click",()=>voteInPoll(message.id,i));if(Number(mine)===i)btn.classList.add("selected");card.appendChild(btn);});bubble.appendChild(card);
  }else if(message.type==="event"){
    const card=document.createElement("div");card.className="group-event-card";card.innerHTML=`<span class="event-icon">📅</span><div><strong>${escapeHtml(message.eventTitle||message.text||"Event")}</strong><small>${escapeHtml(message.eventWhen?new Date(message.eventWhen).toLocaleString():"")}</small>${message.eventDescription?`<p>${escapeHtml(message.eventDescription)}</p>`:""}</div>`;bubble.appendChild(card);
  }else{
    const p=document.createElement("p");p.textContent=message.text||"Attachment unavailable";bubble.appendChild(p);
    const preview=message.type==="text"?linkPreviewData(message.text):null;if(preview){const card=document.createElement("a");card.className="link-preview-card";card.href=preview.url;card.target="_blank";card.rel="noopener noreferrer";card.innerHTML=`<span class="link-preview-icon">↗</span><span><strong>${escapeHtml(preview.host)}</strong><small>${escapeHtml(preview.url)}</small></span>`;bubble.appendChild(card);}
  }
  if(message.albumSize>1){const label=document.createElement("small");label.className="album-indicator";label.textContent=`Album · ${Number(message.albumIndex||0)+1}/${Number(message.albumSize)}`;bubble.appendChild(label);}
  const meta=document.createElement("div");meta.className="message-meta";const time=document.createElement("small");time.textContent=message.createdAt?.toDate?formatTime(message.createdAt.toDate()):"";meta.appendChild(time);if(message.editedAt){const edited=document.createElement("small");edited.className="edited-label";edited.textContent="edited";meta.appendChild(edited);}if(Array.isArray(message.pinnedBy)&&message.pinnedBy.length){const pin=document.createElement("span");pin.className="message-pin-indicator";pin.textContent="📌";pin.title="Pinned";meta.appendChild(pin);}if(outgoing){const status=document.createElement("span");status.className="delivery-check";setDeliveryIcon(status,message);meta.appendChild(status);}bubble.appendChild(meta);
  renderReactionChips(el,message);if(isSavedByUser(message,currentUser.uid)){const mark=document.createElement("span");mark.className="bookmark-icon";mark.innerHTML=ICONS.bookmark;el.appendChild(mark);}
  el.addEventListener("click",e=>{if(selectionMode){e.preventDefault();toggleSelectedMessage(message.id);}});
  el.addEventListener("contextmenu",e=>{e.preventDefault();showMessageActions(el,el._message,outgoing,el);});
  let msgPressTimer=null,msgLongPressed=false;
  el.addEventListener("touchstart",()=>{msgLongPressed=false;msgPressTimer=setTimeout(()=>{msgLongPressed=true;if(navigator.vibrate)navigator.vibrate(12);showMessageActions(el,el._message,outgoing,el);},420);},{passive:true});
  el.addEventListener("touchend",()=>clearTimeout(msgPressTimer));
  el.addEventListener("touchmove",()=>clearTimeout(msgPressTimer));
  el.addEventListener("click",e=>{if(msgLongPressed){e.preventDefault();msgLongPressed=false;}});
  return el;
}
async function openViewOnce(message){
  if(!message?.viewOnce||!currentUser||!activeConversationId)return;
  const viewed=Array.isArray(message.viewedBy)&&message.viewedBy.includes(currentUser.uid);
  if(viewed){showToast("This view-once message has already been opened.","info");return;}
  const videoWindow=message.type==="video"?window.open("about:blank","_blank","noopener,noreferrer"):null;
  try{
    await updateDoc(doc(db,"conversations",activeConversationId,"messages",message.id),{viewedBy:arrayUnion(currentUser.uid)});
    if(message.type==="image"&&isTrustedImageUrl(message.imageURL))openLightbox(message.imageURL);
    else if(message.type==="video"&&isTrustedCloudinaryUrl(message.mediaURL)){
      if(videoWindow){videoWindow.document.write(`<title>CUNNACT view once video</title><body style=\"margin:0;background:#111827;display:grid;place-items:center;min-height:100vh\"><video controls autoplay playsinline style=\"max-width:100%;max-height:100vh\" src=\"${escapeHtml(message.mediaURL)}\"></video></body>`);videoWindow.document.close();}
      else showToast("Allow pop-ups to open the view-once video.","info");
    }
  }catch(e){try{videoWindow?.close();}catch{}console.error(e);showToast(e?.code==="permission-denied"?"Firebase blocked opening this view-once message.":"Could not open view-once media.","error");}
}
function updateMessageElement(el,message){
  const previous=el._message||{};
  if(previous.type!==message.type||!!previous.deletedAt!==!!message.deletedAt||!!previous.viewOnce!==!!message.viewOnce||JSON.stringify(previous.viewedBy||[])!==JSON.stringify(message.viewedBy||[])||previous.imageURL!==message.imageURL||previous.mediaURL!==message.mediaURL||previous.albumIndex!==message.albumIndex||previous.quality!==message.quality||previous.text!==message.text||JSON.stringify(previous.pollVotes||{})!==JSON.stringify(message.pollVotes||{})||previous.eventWhen!==message.eventWhen||previous.eventTitle!==message.eventTitle||previous.eventDescription!==message.eventDescription){const replacement=buildMessageElement(message);el.replaceWith(replacement);return;}
  el._message=message;el.classList.toggle("is-selected",selectedMessageIds.has(message.id));
  const outgoing=message.senderId===currentUser.uid;const bubble=el.querySelector(".message-bubble");if(!bubble)return;
  const quote=bubble.querySelector(".reply-quote");if(message.replyTo&&!quote){const q=document.createElement("button");q.type="button";q.className="reply-quote";q.innerHTML=`<span>${escapeHtml(message.replyTo.senderName||"Message")}</span><p>${escapeHtml(message.replyTo.text||"Photo")}</p>`;q.addEventListener("click",()=>scrollToMessage(message.replyTo.messageId));bubble.prepend(q);}
  if(message.type==="text"){let textEl=bubble.querySelector(":scope > p");if(!textEl){textEl=document.createElement("p");bubble.insertBefore(textEl,bubble.querySelector(".message-meta")||null);}textEl.textContent=message.text||"";}
  let edited=el.querySelector(".edited-label");const meta=bubble.querySelector(".message-meta");if(message.editedAt&&!edited&&meta){edited=document.createElement("small");edited.className="edited-label";edited.textContent="edited";meta.insertBefore(edited,meta.firstChild?.nextSibling||null);}if(!message.editedAt&&edited)edited.remove();
  let pin=el.querySelector(".message-pin-indicator");const isPinned=Array.isArray(message.pinnedBy)&&message.pinnedBy.length>0;if(isPinned&&!pin&&meta){pin=document.createElement("span");pin.className="message-pin-indicator";pin.textContent="📌";pin.title="Pinned";meta.appendChild(pin);}if(!isPinned&&pin)pin.remove();
  if(meta&&outgoing){const status=meta.querySelector(".delivery-check")||document.createElement("span");status.className="delivery-check";setDeliveryIcon(status,message);if(!status.parentNode)meta.appendChild(status);}
  renderReactionChips(el,message);const saved=isSavedByUser(message,currentUser.uid);const oldMark=el.querySelector(".bookmark-icon");if(saved&&!oldMark){const mark=document.createElement("span");mark.className="bookmark-icon";mark.innerHTML=ICONS.bookmark;el.appendChild(mark);}if(!saved&&oldMark)oldMark.remove();
}
function setDeliveryIcon(status,message){const delivered=currentUserData.showReadReceipts===false?false:!!message.deliveredBy?.[activeUser?.uid],read=currentUserData.showReadReceipts===false?false:!!message.readBy?.[activeUser?.uid];status.classList.toggle("read",read);status.innerHTML=read?ICONS.check+ICONS.check:delivered?ICONS.check+ICONS.check:ICONS.check;}
function renderReactionChips(el,message){let wrap=el.querySelector(".message-reactions"),entries=Object.entries(message.reactions||{}).filter(([,v])=>v);if(!entries.length){wrap?.remove();return;}if(!wrap){wrap=document.createElement("div");wrap.className="message-reactions";el.appendChild(wrap);}const counts=new Map();entries.forEach(([uid,emoji])=>counts.set(emoji,(counts.get(emoji)||0)+1));wrap.innerHTML="";counts.forEach((count,emoji)=>{const b=document.createElement("button");b.type="button";b.className="reaction-chip";b.textContent=`${emoji}${count>1?` ${count}`:""}`;b.addEventListener("click",()=>toggleReaction(message.id,emoji,el));wrap.appendChild(b);});}
function showMessageActions(messageEl,message,isOutgoing,anchor){
  closeMessageActionMenus();
  const menu=document.createElement("div");
  menu.className="message-action-menu";
  const saved=isSavedByUser(message,currentUser.uid);
  const pinned=Array.isArray(message.pinnedBy)&&message.pinnedBy.includes(currentUser.uid);
  const canEdit=isOutgoing&&message.type==="text"&&!message.deletedAt;
  menu.innerHTML=`<div class="reaction-picker">${["❤️","😂","👍","😮","😢","🔥"].map(e=>`<button type="button" class="reaction-choice" data-reaction="${e}" aria-label="React ${e}">${e}</button>`).join("")}</div>${canEdit?`<button class="menu-item edit-msg" type="button">${ICONS.edit}<span>Edit</span></button>`:""}<button class="menu-item reply-msg" type="button">${ICONS.reply}<span>Reply</span></button><button class="menu-item forward-msg" type="button">${ICONS.forward}<span>Forward</span></button><button class="menu-item select-msg" type="button">${ICONS.check}<span>Select</span></button><button class="menu-item copy-msg" type="button">${ICONS.copy}<span>Copy text</span></button><button class="menu-item pin-msg" type="button">${ICONS.pin}<span>${pinned?"Unpin message":"Pin message"}</span></button><button class="menu-item save-msg" type="button">${ICONS.bookmark}<span>${saved?"Unsave message":"Save message"}</span></button><button class="menu-item details-msg" type="button">${ICONS.info}<span>Message details</span></button>${isOutgoing?`<button class="menu-item danger-item delete-msg" type="button">${ICONS.trash}<span>Delete for everyone</span></button>`:""}${activeUser?.isGroup?`<button class="menu-item danger-item report-msg" type="button">⚑<span>Report message</span></button>`:""}<button class="menu-item danger-item delete-for-me" type="button">${ICONS.trash}<span>Delete for me</span></button>`;
  document.body.appendChild(menu);
  const rect=anchor.getBoundingClientRect();const mr=menu.getBoundingClientRect();const top=rect.bottom+8+mr.height>innerHeight?rect.top-mr.height-8:rect.bottom+8;const left=Math.min(Math.max(8,rect.left),innerWidth-mr.width-8);menu.style.top=`${Math.max(8,top)}px`;menu.style.left=`${left}px`;
  menu.querySelectorAll(".reaction-choice").forEach(b=>b.addEventListener("click",async()=>{await toggleReaction(message.id,b.dataset.reaction,messageEl);menu.remove();}));
  menu.querySelector(".edit-msg")?.addEventListener("click",()=>{startEdit(message);menu.remove();});
  menu.querySelector(".forward-msg")?.addEventListener("click",()=>{openForwardModal([message]);menu.remove();});
  menu.querySelector(".select-msg")?.addEventListener("click",()=>{setSelectionMode(true);toggleSelectedMessage(message.id,true);menu.remove();});
  menu.querySelector(".pin-msg")?.addEventListener("click",async()=>{await togglePinMessage(message.id,pinned);menu.remove();});
  menu.querySelector(".details-msg")?.addEventListener("click",()=>{showMessageDetails(message);menu.remove();});
  menu.querySelector(".reply-msg")?.addEventListener("click",()=>{startReply(message);menu.remove();});
  menu.querySelector(".copy-msg")?.addEventListener("click",async()=>{try{await navigator.clipboard.writeText(message.text||"");showToast("Message copied","success");}catch{showToast("Could not copy message","error");}menu.remove();});
  menu.querySelector(".save-msg")?.addEventListener("click",async()=>{await toggleSaveMessage(message.id,saved);menu.remove();});
  menu.querySelector(".delete-msg")?.addEventListener("click",async()=>{playDelete();await deleteMessageForEveryone(message.id);menu.remove();});
  menu.querySelector(".report-msg")?.addEventListener("click",async()=>{playDelete();await reportGroupMessage(message.id);menu.remove();});
  menu.querySelector(".delete-for-me")?.addEventListener("click",async()=>{playDelete();await deleteMessageForMe(message.id,messageEl);menu.remove();});
}
function closeMessageActionMenus(){document.querySelectorAll(".message-action-menu").forEach(m=>m.remove());}
async function toggleReaction(messageId,emoji){try{await runTransaction(db,async(tx)=>{const ref=doc(db,"conversations",activeConversationId,"messages",messageId),snap=await tx.get(ref);if(!snap.exists())throw new Error("MESSAGE_NOT_FOUND");const reactions={...(snap.data().reactions||{})};reactions[currentUser.uid]=reactions[currentUser.uid]===emoji?null:emoji;tx.update(ref,{reactions});});}catch(e){console.error(e);showToast("Could not update reaction.","error");}}
async function toggleSaveMessage(messageId,currentSaved){try{const ref=doc(db,"conversations",activeConversationId,"messages",messageId),savedRef=doc(db,"users",currentUser.uid,"savedMessages",messageId),message=currentMessages.find(m=>m.id===messageId);const batch=writeBatch(db);batch.update(ref,{savedBy:currentSaved?arrayRemove(currentUser.uid):arrayUnion(currentUser.uid)});if(currentSaved)batch.delete(savedRef);else batch.set(savedRef,{messageId,conversationId:activeConversationId,partnerUid:activeUser?.isGroup?"":activeUser.uid,savedAt:serverTimestamp(),type:message?.type||"text",text:(message?.text||"").slice(0,500),imageURL:message?.imageURL||"",mediaURL:message?.mediaURL||"",fileName:message?.fileName||""});await batch.commit();showToast(currentSaved?"Message unsaved":"Message saved 🔖",currentSaved?"info":"success");if(!currentSaved)playSave();return true;}catch(e){console.error(e);showToast(e?.code==="permission-denied"?"Firebase blocked saving this message. Deploy the updated rules.":"Could not update saved message.","error");return false;}}
async function deleteMessageForEveryone(messageId){const ok=await showConfirmDialog({title:"Delete message for everyone?",message:"The message content will be replaced with a deleted-message notice.",confirmText:"Delete message",cancelText:"Keep message",danger:true});if(!ok)return false;try{await updateDoc(doc(db,"conversations",activeConversationId,"messages",messageId),{deletedAt:serverTimestamp(),deletedBy:currentUser.uid});await refreshConversationPreview();showToast("Message deleted for everyone","success");return true;}catch(e){console.error(e);showToast(e?.code==="permission-denied"?"Only the sender can delete this message.":"Could not delete the message.","error");return false;}}
async function deleteMessageForMe(messageId,messageEl){try{messageEl?.classList.add("deleting");await updateDoc(doc(db,"conversations",activeConversationId,"messages",messageId),{deletedFor:arrayUnion(currentUser.uid)});const c=conversations.find(x=>x.id===activeConversationId);if(c?.lastMessageId===messageId)localHiddenLatest.add(activeConversationId);showToast("Message deleted for you","info");return true;}catch(e){messageEl?.classList.remove("deleting");console.error(e);showToast("Could not delete the message for you.","error");return false;}}
async function refreshConversationPreview(){const c=conversations.find(x=>x.id===activeConversationId);if(!c)return;try{const snap=await getDocs(query(collection(db,"conversations",activeConversationId,"messages"),orderBy("createdAt","desc"),limit(20)));const docs=snap.docs.map(d=>({id:d.id,...d.data()})).filter(m=>!m.deletedAt&&!isDeletedForUser(m,currentUser.uid));const m=docs[0];if(m){const preview=m.type==="image"?"📷 Photo":m.type==="gif"?"GIF":m.type==="audio"?"🎤 Voice message":m.type==="video"?"🎬 Video":m.type==="document"?`📄 ${m.fileName||"Document"}`:m.type==="contact"?`👤 ${m.contactName||"Contact"}`:m.type==="location"?"📍 Location":(m.text||"").slice(0,500);await updateDoc(doc(db,"conversations",activeConversationId),{lastMessage:preview,lastMessageType:m.type||"text",lastMessageSenderId:m.senderId||"",lastMessageId:m.id,lastMessageTime:m.createdAt||serverTimestamp()});}else{await updateDoc(doc(db,"conversations",activeConversationId),{lastMessage:"",lastMessageType:"text",lastMessageSenderId:"",lastMessageId:"",lastMessageTime:serverTimestamp()});}}catch(e){console.warn("Preview reconcile failed",e);}}
function updateConversationPreviewFromMessages(){const c=conversations.find(x=>x.id===activeConversationId);if(!c||!currentMessages.length)return;const newest=[...currentMessages].reverse().find(m=>!m.deletedAt&&!isDeletedForUser(m,currentUser.uid));if(newest&&c.lastMessageId!==newest.id){const preview=newest.type==="image"?"📷 Photo":newest.type==="gif"?"GIF":newest.type==="audio"?"🎤 Voice message":newest.type==="video"?"🎬 Video":newest.type==="document"?`📄 ${newest.fileName||"Document"}`:newest.type==="contact"?`👤 ${newest.contactName||"Contact"}`:newest.type==="location"?"📍 Location":(newest.text||"").slice(0,500);updateDoc(doc(db,"conversations",activeConversationId),{lastMessage:preview,lastMessageType:newest.type||"text",lastMessageSenderId:newest.senderId||"",lastMessageId:newest.id,lastMessageTime:newest.createdAt||serverTimestamp()}).catch(()=>{});}}

async function voteInPoll(messageId, optionIndex){
  if(!activeUser?.isGroup)return;
  const ref=doc(db,"conversations",activeConversationId,"messages",messageId);
  try{await runTransaction(db,async tx=>{const snap=await tx.get(ref);if(!snap.exists()||snap.data()?.type!=="poll")throw new Error("POLL_NOT_FOUND");const data=snap.data();const votes={...(data.pollVotes||{})};votes[currentUser.uid]=Number(optionIndex);tx.update(ref,{pollVotes:votes});});showToast("Vote saved","success");}catch(e){console.error(e);showToast("Could not save your vote.","error");}
}

/* Delivery receipts */
function queueDeliveredForIncoming(messages){
  if(!currentUser||!messages?.length)return;
  messages.forEach(m=>{
    if(m.senderId!==currentUser.uid && m.receiverId===currentUser.uid && !m.deliveredBy?.[currentUser.uid] && !isDeletedForUser(m,currentUser.uid)) queuedDeliveredIds.add(m.id);
  });
  clearTimeout(deliveredFlushTimer);
  deliveredFlushTimer=setTimeout(flushDelivered,180);
}
async function flushDelivered(){
  if(!activeConversationId||!currentUser||!queuedDeliveredIds.size)return;
  const ids=[...queuedDeliveredIds].slice(0,450);
  ids.forEach(id=>queuedDeliveredIds.delete(id));
  try{
    const batch=writeBatch(db);
    ids.forEach(id=>batch.update(doc(db,"conversations",activeConversationId,"messages",id),{[`deliveredBy.${currentUser.uid}`]:serverTimestamp()}));
    await batch.commit();
  }catch(e){ids.forEach(id=>queuedDeliveredIds.add(id));console.warn("Delivery batch failed",e);}
}

/* Read receipts */
function queueRead(messageId){const m=activeMessageMap.get(messageId);if(currentUserData.showReadReceipts===false)return;if(!m||m.receiverId!==currentUser.uid||m.readBy?.[currentUser.uid]||isDeletedForUser(m,currentUser.uid))return;queuedReadIds.add(messageId);clearTimeout(readFlushTimer);readFlushTimer=setTimeout(flushQueuedReads,220);}
async function flushQueuedReads(){if(!activeConversationId||!currentUser||!queuedReadIds.size)return;const ids=[...queuedReadIds].slice(0,450);ids.forEach(id=>queuedReadIds.delete(id));try{const batch=writeBatch(db);ids.forEach(id=>batch.update(doc(db,"conversations",activeConversationId,"messages",id),{[`readBy.${currentUser.uid}`]:serverTimestamp()}));await batch.commit();}catch(e){ids.forEach(id=>queuedReadIds.add(id));console.warn("Read batch failed",e);}}
function observeVisibleIncoming(){document.querySelectorAll("#messages .message").forEach(el=>{const m=activeMessageMap.get(el.dataset.messageId);if(m?.receiverId===currentUser.uid)readObserver?.observe(el);});}
function scrollToMessage(id){const el=$id("messages")?.querySelector(`.message[data-message-id="${CSS.escape(id)}"]`);if(el){el.scrollIntoView({block:"center",behavior:"smooth"});el.classList.add("flash-message");setTimeout(()=>el.classList.remove("flash-message"),700);}}

/* Reply / composer */
function startReply(message){const preview=message.type==="image"?"📷 Photo":message.type==="gif"?"GIF":message.type==="audio"?"🎤 Voice message":message.type==="video"?"🎬 Video":message.type==="document"?`📄 ${message.fileName||"Document"}`:message.type==="contact"?`👤 ${message.contactName||"Contact"}`:message.type==="location"?"📍 Location":String(message.text||"");replyTarget={messageId:message.id,senderId:message.senderId,senderName:message.senderId===currentUser.uid?"You":(activeUser?.isGroup?(activeGroupMembers.get(message.senderId)?.name||"Member"):(activeUser?.name||"User")),text:preview};$id("replyBar").hidden=false;$id("replyAuthor").textContent=replyTarget.senderName;$id("replyPreview").textContent=replyTarget.text;$id("messageInput")?.focus();}
function clearReply(){replyTarget=null;const bar=$id("replyBar");if(bar)bar.hidden=true;}
async function handleMessageSubmit(e){e.preventDefault();if(sendingMessage||!activeUser||!activeConversationId||isBlockedByEither())return;const input=$id("messageInput"),text=input.value.trim();if(!text)return;sendingMessage=true;const sendBtn=$id("messageForm").querySelector('button[type="submit"]');input.value="";autoGrowComposer();stopTyping();const savedReply=replyTarget;clearReply();try{await sendMessage({type:"text",text,replyTo:savedReply});playSend();input.focus();}catch(err){console.error("Send message failed",err);input.value=text;if(savedReply)startReply(savedReply);autoGrowComposer();showToast(err?.code==="permission-denied"?"Message blocked by chat permissions.":"Message could not be sent. Please try again.","error");}finally{sendingMessage=false;setComposerState();}}
function groupMentionData(text){
  if(!activeUser?.isGroup)return {mentions:[],mentionAll:false};
  const raw=String(text||"");const mentionAll=/@everyone\b/i.test(raw);const usernames=new Set((raw.match(/@([a-z0-9_]{3,24})/gi)||[]).map(x=>x.slice(1).toLowerCase()).filter(x=>x!=="everyone"));
  const mentions=[];for(const [uid,u] of activeGroupMembers){const name=String(u?.username||"").toLowerCase();if(name&&usernames.has(name))mentions.push(uid);}
  return {mentions,mentionAll};
}

async function sendMessage({type,text,imageURL,mediaURL,fileName,mimeType,fileSize,replyTo,forwardedFrom,albumId,albumIndex,albumSize,quality,linkUrl,linkHost,contactUid,contactName,contactUsername,contactPhotoURL,latitude,longitude,locationLabel,pollQuestion,pollOptions,eventTitle,eventWhen,eventDescription,mentions,mentionAll,viewOnce=false}={}){
  if(!currentUser||!activeUser||!activeConversationId)throw new Error("NO_ACTIVE_CHAT");
  if(isBlockedByEither())throw new Error("BLOCKED");
  const isGroup=!!activeUser.isGroup;
  const extractedMentions=type==="text"?groupMentionData(text):{mentions:[],mentionAll:false};
  mentions=[...(mentions||extractedMentions.mentions)];
  mentionAll=Boolean(mentionAll||extractedMentions.mentionAll);
  const allowed=["text","image","gif","audio","video","document","sticker","contact","location","poll","event"];
  if(!allowed.includes(type))throw new Error("UNSUPPORTED_MESSAGE_TYPE");
  if(["poll","event"].includes(type)&&!isGroup)throw new Error("GROUP_ONLY_MESSAGE");
  if(["image","gif"].includes(type)&&!isTrustedImageUrl(imageURL)&&type!=="gif")throw new Error("UNTRUSTED_MEDIA_URL");
  if(type==="gif"&&!isTrustedGifUrl(imageURL)&&!isTrustedImageUrl(imageURL))throw new Error("UNTRUSTED_GIF_URL");
  const ref=doc(db,"conversations",activeConversationId,"messages",crypto.randomUUID?crypto.randomUUID():`${Date.now()}_${Math.random().toString(36).slice(2)}`);
  const message={
    senderId:currentUser.uid,
    ...(isGroup?{}:{receiverId:activeUser.uid}),
    type,
    ...(type==="image"?{imageURL}:{}),
    ...(type==="gif"?{imageURL}:{}),
    ...(mediaURL?{mediaURL}:{}),
    ...(fileName?{fileName:String(fileName).slice(0,180)}:{}),
    ...(mimeType?{mimeType:String(mimeType).slice(0,120)}:{}),
    ...(fileSize?{fileSize:Number(fileSize)||0}:{}),
    ...((type==="text"||type==="sticker"||type==="poll"||type==="event")?{text:String(text||"").slice(0,5000)}:{}),
    ...(replyTo?{replyTo}:{}),
    ...(forwardedFrom?{forwardedFrom}:{}),
    ...(albumId?{albumId:String(albumId).slice(0,80),albumIndex:Number(albumIndex)||0,albumSize:Number(albumSize)||1}:{}),
    ...(quality&&type==="image"?{quality}:{}),
    ...(linkUrl?{linkUrl:String(linkUrl).slice(0,2048),linkHost:String(linkHost||"").slice(0,180)}:{}),
    ...(type==="contact"?{contactUid:String(contactUid||""),contactName:String(contactName||"").slice(0,120),contactUsername:String(contactUsername||"").slice(0,60),contactPhotoURL:String(contactPhotoURL||"").slice(0,2048)}:{}),
    ...(type==="location"?{latitude:Number(latitude),longitude:Number(longitude),locationLabel:String(locationLabel||"Shared location").slice(0,160)}:{}),
    ...(type==="poll"?{pollQuestion:String(pollQuestion||text||"").slice(0,300),pollOptions:(pollOptions||[]).map(x=>String(x).slice(0,120)).filter(Boolean).slice(0,10),pollVotes:{}}:{}),
    ...(type==="event"?{eventTitle:String(eventTitle||text||"").slice(0,180),eventWhen:String(eventWhen||"").slice(0,80),eventDescription:String(eventDescription||"").slice(0,600)}:{}),
    ...(Array.isArray(mentions)&&mentions.length?{mentions:[...new Set(mentions)].slice(0,30)}:{}),
    ...(mentionAll?{mentionAll:true}:{}),
    ...(viewOnce?{viewOnce:true,viewedBy:[]} : {}),
    createdAt:serverTimestamp(),...(activeConversation?.disappearingSeconds?{expiresAt:new Date(Date.now()+Number(activeConversation.disappearingSeconds)*1000)}:{}),savedBy:[],pinnedBy:[],deletedFor:[],readBy:{},deliveredBy:{},reactions:{}
  };
  if(type==="text"&&!message.text)throw new Error("EMPTY_MESSAGE");
  if(type==="contact"&&!message.contactUid)throw new Error("INVALID_CONTACT");
  if(type==="location"&&(!Number.isFinite(message.latitude)||!Number.isFinite(message.longitude)))throw new Error("INVALID_LOCATION");
  const batch=writeBatch(db);batch.set(ref,message);
  const unreadPatch={};
  if(isGroup)(activeUser.members||[]).forEach(uid=>{if(uid!==currentUser.uid)unreadPatch[`unread.${uid}`]=increment(1);});
  else unreadPatch[`unread.${activeUser.uid}`]=increment(1);
  const preview=type==="image"?"📷 Photo":type==="gif"?"GIF":type==="audio"?"🎤 Voice message":type==="video"?"🎬 Video":type==="document"?`📄 ${fileName||"Document"}`:type==="sticker"?String(text||"✨"):type==="contact"?`👤 ${contactName||"Contact"}`:type==="location"?"📍 Location":type==="poll"?`📊 ${text||"Poll"}`:type==="event"?`📅 ${text||"Event"}`:String(text||"").slice(0,500);
  batch.update(doc(db,"conversations",activeConversationId),{lastMessage:preview,lastMessageType:type,lastMessageSenderId:currentUser.uid,lastMessageId:ref.id,lastMessageTime:serverTimestamp(),...unreadPatch});
  await batch.commit();
}

function extractFirstUrl(text){
  const m=String(text||"").match(/https?:\/\/[^\s<]+/i);
  if(!m)return null;
  const raw=m[0].replace(/[),.!?;:]$/g,"");
  try{const u=new URL(raw);if(u.protocol!=="http:"&&u.protocol!=="https:")return null;return u;}catch{return null;}
}
function isTrustedGifUrl(value){
  if(typeof value!=="string"||value.length>2048)return false;
  try{const u=new URL(value);if(u.protocol!=="https:")return false;const h=u.hostname.toLowerCase();return ["media.giphy.com","i.giphy.com","media.tenor.com","c.tenor.com"].some(x=>h===x||h.endsWith(`.${x}`)) && /\.gif(?:$|[?#])/i.test(u.pathname+u.search+u.hash);}catch{return false;}
}
function linkPreviewData(text){const u=extractFirstUrl(text);if(!u)return null;return{url:u.href,host:u.hostname.replace(/^www\\./i,"")};}

/* ---------------- Phase 2 media selection ---------------- */
async function handleMediaSelection(){
  const files=[...( $id("fileInput")?.files||[] )];
  if($id("fileInput"))$id("fileInput").value="";
  if(!files.length||!activeUser||!activeConversationId||isBlockedByEither())return;
  if(files.length>8){showToast("You can send up to 8 files at a time.","info");files.splice(8);} 
  let total=0;const items=[];
  for(const file of files){
    try{
      const kind=await validateMediaFile(file);total+=file.size;
      if(total>50*1024*1024)throw new UploadError("size","The selected batch must be 50 MB or smaller.");
      items.push({file,kind,previewUrl:(kind==="image"||kind==="video")?URL.createObjectURL(file):"",status:"pending",error:""});
    }catch(e){showToast(e instanceof UploadError?e.userMessage:"One of the selected files is not supported.","error");}
  }
  if(!items.length)return;
  pendingMediaItems=items;mediaQuality="optimized";if($id("mediaQuality"))$id("mediaQuality").value=mediaQuality;renderMediaPreview();
}
function renderMediaPreview(){
  const bar=$id("imagePreviewBar"),list=$id("mediaPreviewList");if(!bar||!list)return;
  list.innerHTML="";
  pendingMediaItems.forEach((item,index)=>{
    const card=document.createElement("div");card.className=`media-preview-item ${item.status}`;
    if(item.kind==="image"&&item.previewUrl){const img=document.createElement("img");img.src=item.previewUrl;img.alt=item.file.name;card.appendChild(img);}
    else if(item.kind==="video"&&item.previewUrl){const video=document.createElement("video");video.src=item.previewUrl;video.muted=true;video.playsInline=true;video.preload="metadata";card.appendChild(video);}
    else{const icon=document.createElement("span");icon.className="file-preview-icon";icon.textContent=item.kind==="document"?"📄":"📎";card.appendChild(icon);}
    const name=document.createElement("span");name.className="media-preview-name";name.textContent=item.file.name;card.appendChild(name);
    if(item.status==="error"){const err=document.createElement("span");err.className="media-preview-error";err.textContent="Failed";card.appendChild(err);}
    if(item.status==="sent"){const ok=document.createElement("span");ok.className="media-preview-ok";ok.textContent="✓";card.appendChild(ok);}
    const remove=document.createElement("button");remove.type="button";remove.className="media-preview-remove";remove.textContent="×";remove.setAttribute("aria-label",`Remove ${item.file.name}`);remove.addEventListener("click",()=>{if(item.previewUrl)URL.revokeObjectURL(item.previewUrl);pendingMediaItems.splice(index,1);if(!pendingMediaItems.length)clearImagePreview();else renderMediaPreview();});card.appendChild(remove);list.appendChild(card);
  });
  const total=pendingMediaItems.reduce((n,x)=>n+x.file.size,0);
  const viewToggle=$id("viewOnceToggle");
  if(viewToggle){const allowed=pendingMediaItems.length===1&&["image","video"].includes(pendingMediaItems[0]?.kind);viewToggle.disabled=!allowed;if(!allowed)viewToggle.checked=false;viewToggle.closest(".check-inline")?.classList.toggle("disabled",!allowed);}
  $id("imagePreviewName").textContent=pendingMediaItems.length?`${pendingMediaItems.length} file${pendingMediaItems.length===1?"":"s"}`:"Ready to send";
  $id("imagePreviewStatus").textContent=pendingMediaItems.some(x=>x.status==="error")?"Some uploads failed. Tap send to retry failed files.":`${formatBytes(total)} selected${pendingMediaItems.length>1?" · album will be grouped":""}`;
  $id("imagePreviewSend").textContent=pendingMediaItems.some(x=>x.status==="error")?"Retry failed":"Send files";
  $id("imagePreviewSend").disabled=!pendingMediaItems.some(x=>x.status!=="sent");
  bar.hidden=!pendingMediaItems.length;
}
function formatBytes(bytes){if(!Number.isFinite(bytes)||bytes<0)return "0 B";if(bytes<1024)return `${bytes} B`;const units=["KB","MB","GB"];let n=bytes/1024;let i=0;while(n>=1024&&i<units.length-1){n/=1024;i++;}return `${n.toFixed(n>=10?0:1)} ${units[i]}`;}
function cancelImagePreview(){uploadController?.abort();clearImagePreview();}
async function uploadMediaWithRetry(file,progressHandler,signal){
  let lastErr=null;
  for(let attempt=0;attempt<2;attempt++){
    try{return await uploadFileToCloudinary(file,{signal,onProgress:progressHandler});}
    catch(e){lastErr=e;if(e?.kind==="aborted")throw e;if(attempt===0)await new Promise(r=>setTimeout(r,500));}
  }
  throw lastErr||new Error("UPLOAD_FAILED");
}
async function sendPendingMedia(){
  if(!pendingMediaItems.length||!activeConversationId||!activeUser||isBlockedByEither())return;
  const unsent=pendingMediaItems.filter(x=>x.status!=="sent");if(!unsent.length)return;
  const savedReply=replyTarget;const albumId=unsent.length>1?`album_${Date.now()}_${Math.random().toString(36).slice(2,8)}`:"";const albumSize=unsent.length;
  const viewOnce=!!$id("viewOnceToggle")?.checked && unsent.length===1 && ["image","video"].includes(unsent[0]?.kind);
  const sendBtn=$id("imagePreviewSend");sendBtn.disabled=true;$id("imagePreviewBar")?.classList.add("uploading");uploadController=new AbortController();
  let done=0;const total=unsent.reduce((n,x)=>n+x.file.size,0)||1;
  try{
    for(const item of unsent){
      try{
        item.status="uploading";item.error="";renderMediaPreview();
        const url=await uploadMediaWithRetry(item.file,p=>{const base=unsent.slice(0,done).reduce((n,x)=>n+x.file.size,0);const pct=(base+(p||0)*item.file.size)/total;$id("imagePreviewProgress").style.width=`${Math.round(pct*100)}%`;},uploadController.signal);
        const type=item.kind==="image"?(item.file.type==="image/gif"?"gif":"image"):item.kind;
        await sendMessage({type,imageURL:type==="image"||type==="gif"?url:undefined,mediaURL:type==="image"||type==="gif"?undefined:url,fileName:item.file.name,mimeType:item.file.type,fileSize:item.file.size,replyTo:done===0?savedReply:undefined,albumId,albumIndex:done,albumSize,quality:mediaQuality,viewOnce});
        item.status="sent";done++;renderMediaPreview();
      }catch(e){item.status=e?.kind==="aborted"?"pending":"error";item.error=e?.userMessage||"Upload failed";renderMediaPreview();if(e?.kind==="aborted")throw e;}
    }
    const failed=pendingMediaItems.some(x=>x.status==="error");
    if(!failed){playSend();showToast(albumSize>1?`${albumSize} files sent`:`${pendingMediaItems.length} file sent`,"success");clearImagePreview();clearReply();}
    else showToast("Some files could not be sent. Tap Retry failed to try again.","error");
  }catch(e){if(e?.kind!=="aborted"){console.error("Media batch failed",e);showToast(e?.userMessage||"Upload stopped. You can retry.","error");}}
  finally{uploadController=null;$id("imagePreviewBar")?.classList.remove("uploading");renderMediaPreview();}
}
async function handleImageSelection(){await handleMediaSelection();}
async function sendPendingImage(){await sendPendingMedia();}
function clearImagePreview(){pendingMediaItems.forEach(x=>{if(x.previewUrl)URL.revokeObjectURL(x.previewUrl);});pendingMediaItems=[];pendingImageFile=null;if(pendingImageUrl)URL.revokeObjectURL(pendingImageUrl);pendingImageUrl=null;uploadController=null;const bar=$id("imagePreviewBar");if(!bar)return;bar.hidden=true;bar.classList.remove("uploading");$id("mediaPreviewList")&&($id("mediaPreviewList").innerHTML="");$id("imagePreviewProgress")&&($id("imagePreviewProgress").style.width="0%");$id("imagePreviewSend")&&($id("imagePreviewSend").toggleAttribute("disabled",true));if($id("viewOnceToggle"))$id("viewOnceToggle").checked=false;}
function autoGrowComposer(){const input=$id("messageInput");if(!input)return;input.style.height="auto";input.style.height=`${Math.min(input.scrollHeight,140)}px`;}


async function setGroupMemberRole(uid, role){
  if(!activeUser?.isGroup||!(activeUser.admins||[]).includes(currentUser.uid)||!uid||uid===currentUser.uid)return;
  const admins=new Set(activeUser.admins||[]);const moderators=new Set(activeUser.moderators||[]);const roles={...(activeUser.roles||{})};
  const fromRole=roles[uid]||((admins.has(uid))?"admin":(moderators.has(uid)?"moderator":"member"));
  admins.delete(uid);moderators.delete(uid);roles[uid]=role;
  if(role==="admin")admins.add(uid);else if(role==="moderator")moderators.add(uid);
  try{await updateDoc(doc(db,"conversations",activeConversationId),{groupAdmins:[...admins],groupModerators:[...moderators],groupRoles:roles}); const target=activeGroupMembers.get(uid)||userListeners.get(uid)?.data||{}; await logGroupEvent("role_changed",{targetUid:uid,targetName:target.name||target.username||"Member",fromRole,toRole:role,details:`${target.name||target.username||"Member"} changed from ${fromRole} to ${role}`}); await openChatById(activeConversationId);showToast("Member role updated","success");}catch(e){console.error(e);showToast("Could not update member role.","error");}
}
/* Profile drawer / shared media */
function openProfileDrawer(){if(!activeUser||activeUser.uid===currentUser?.uid)return;renderProfileDrawer();$id("profileDrawer").hidden=false;$id("app")?.classList.add("drawer-open");}
function closeProfileDrawer(){const d=$id("profileDrawer");if(!d)return;d.hidden=true;$id("app")?.classList.remove("drawer-open");}
function renderProfileDrawer(){
  if(!activeUser)return;
  const drawer=$id("profileDrawer");
  const contactDetails=$id("drawerContactDetails");
  const contactActions=contactDetails?.querySelector(".drawer-contact-actions");
  const infoList=contactDetails?.querySelector(".drawer-info-list");
  const sharedSection=document.querySelector(".drawer-shared-section");
  const editBtn=$id("drawerEditBtn");
  drawer?.classList.toggle("group-mode",!!activeUser.isGroup);
  if(activeUser.isGroup){
    contactDetails?.removeAttribute("hidden");
    contactActions?.setAttribute("hidden","");
    infoList?.setAttribute("hidden","");
    sharedSection?.removeAttribute("hidden");
    editBtn?.setAttribute("hidden","");
    const title=drawer?.querySelector(".profile-drawer-title strong"); if(title) title.textContent="Group info";
    paintAvatar($id("drawerAvatar"),{photoURL:activeUser.photoURL||activeUser.groupPhotoURL,name:activeUser.name});
    $id("drawerName").textContent=activeUser.name||"Group";
    $id("drawerUsername").textContent=`${activeUser.memberCount||activeUser.members?.length||0} members`;
    $id("drawerBio").textContent=activeUser.description||"";
    $id("drawerViewProfile").hidden=true;
    const statsRow=$id("drawerStatsRow");
    if(statsRow){statsRow.hidden=false;$id("drawerStatMembers").textContent=String(activeUser.memberCount||activeUser.members?.length||0);}
    const isAdmin=(activeUser.admins||[]).includes(currentUser.uid);
    const isFavourite=!!currentUserSettings?.favoriteConversations?.[activeConversationId];
    if($id("groupFavouriteLabel")) $id("groupFavouriteLabel").textContent=isFavourite?"Remove from favourites":"Add to favourites";
    const createdAt=timestampDate(activeConversation?.createdAt||activeUser.createdAt);
    const creatorUid=activeConversation?.createdBy||activeUser.createdBy;
    const creator=creatorUid===currentUser.uid?currentUserData:(activeGroupMembers.get(creatorUid)||userListeners.get(creatorUid)?.data||{});
    if($id("groupCreatedMeta")) $id("groupCreatedMeta").textContent=createdAt?`Group created by ${creator?.name||"a CUNNACT member"}, on ${createdAt.toLocaleDateString()} at ${createdAt.toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"})}`:"";
    const section=$id("groupMembersSection");
    if(section){
      section.hidden=false;
      const list=$id("groupMembersList");
      list.innerHTML=(activeUser.members||[]).map(uid=>{
        const u=uid===currentUser.uid?{name:"You",photoURL:currentUserData.photoURL}:(activeGroupMembers.get(uid)||userListeners.get(uid)?.data||{name:"Member"});
        const role=(activeUser.roles||{})[uid]||((activeUser.admins||[]).includes(uid)?"admin":((activeUser.moderators||[]).includes(uid)?"moderator":"member"));
        return `<div class="group-member-row" data-uid="${escapeHtml(uid)}">${avatarHtml(u,{dot:false})}<span class="meta"><strong>${escapeHtml(u.name||"Member")}</strong><span class="admin-tag">${escapeHtml(role)}</span></span>${isAdmin&&uid!==currentUser.uid?`<select class="member-role-select" aria-label="Role"><option value="member" ${role==="member"?"selected":""}>Member</option><option value="moderator" ${role==="moderator"?"selected":""}>Moderator</option><option value="admin" ${role==="admin"?"selected":""}>Admin</option></select><button class="remove-member" type="button" aria-label="Remove member">${ICONS.trash}</button>`:""}</div>`;
      }).join("");
      (activeUser.members||[]).forEach(uid=>{const u=uid===currentUser.uid?{name:"You",photoURL:currentUserData.photoURL}:(activeGroupMembers.get(uid)||userListeners.get(uid)?.data||{name:"Member"});paintAvatar(list.querySelector(`[data-uid="${CSS.escape(uid)}"] .avatar`),u);});
      list.querySelectorAll(".remove-member").forEach(btn=>btn.addEventListener("click",()=>removeGroupMember(btn.closest(".group-member-row").dataset.uid)));
      list.querySelectorAll(".member-role-select").forEach(sel=>sel.addEventListener("change",()=>setGroupMemberRole(sel.closest(".group-member-row").dataset.uid,sel.value)));
      $id("addGroupMembersBtn").hidden=!isAdmin;
      $id("groupInviteBtn").hidden=!isAdmin;
      $id("groupJoinRequestsBtn").hidden=!isAdmin;
      $id("groupSettingsBtn").hidden=!isAdmin;
      $id("leaveGroupBtn").hidden=false;
    }
    const grid=$id("sharedMediaGrid");if(!grid)return;
    const images=currentMessages.filter(m=>m.type==="image"&&isTrustedImageUrl(m.imageURL)).slice(-12).reverse();
    if($id("drawerStatMedia"))$id("drawerStatMedia").textContent=String(images.length);
    grid.innerHTML=images.length?images.map(m=>`<button type="button" class="shared-media-item" data-image="${escapeHtml(m.imageURL)}"><img src="${escapeHtml(imageUrl(m.imageURL,"chat"))}" alt="Shared image" loading="lazy"></button>`).join(""):'<div class="empty-state">No shared images yet.</div>';
    grid.querySelectorAll(".shared-media-item").forEach(b=>b.addEventListener("click",()=>openLightbox(b.dataset.image)));
    return;
  }

  contactDetails?.removeAttribute("hidden");
  contactActions?.removeAttribute("hidden");
  infoList?.removeAttribute("hidden");
  sharedSection?.setAttribute("hidden","");
  editBtn?.removeAttribute("hidden");
  const title=drawer?.querySelector(".profile-drawer-title strong"); if(title) title.textContent="Contact info";
  $id("groupMembersSection")?.setAttribute("hidden","");
  $id("drawerStatsRow")?.setAttribute("hidden","");
  ["groupInviteBtn","groupJoinRequestsBtn","groupSettingsBtn","addGroupMembersBtn","leaveGroupBtn"].forEach(id=>{$id(id)?.setAttribute("hidden","");});
  $id("drawerViewProfile").hidden=true;
  const live=userListeners.get(activeUser.uid)?.data;if(live)activeUser={...activeUser,...live};
  paintAvatar($id("drawerAvatar"),{photoURL:activeUser.photoURL,name:activeUser.name,email:activeUser.email});
  $id("drawerName").textContent=activeUser.name||"Contact";
  $id("drawerUsername").textContent=activeUser.username?`@${activeUser.username}`:"@username not set";
  $id("drawerBio").textContent=activeUser.bio||"";
  const blocked=currentBlockedUsers.has(activeUser.uid);
  if($id("drawerBlockLabel"))$id("drawerBlockLabel").textContent=blocked?"Unblock":"Block";
  if($id("drawerBlockHint"))$id("drawerBlockHint").textContent=blocked?"Allow messages and calls":"Stop messages and calls";
  const seconds=Number(activeConversation?.disappearingSeconds||0);
  const dLabel=seconds>=86400?`${Math.round(seconds/86400)} day${seconds===86400?"":"s"}`:seconds>=3600?`${Math.round(seconds/3600)} hour${seconds===3600?"":"s"}`:seconds>=60?`${Math.round(seconds/60)} minute${seconds===60?"":"s"}`:"Off";
  if($id("drawerDisappearingValue"))$id("drawerDisappearingValue").textContent=dLabel;
  const grid=$id("sharedMediaGrid");if(!grid)return;
  const images=currentMessages.filter(m=>m.type==="image"&&isTrustedImageUrl(m.imageURL)).slice(-12).reverse();
  if($id("drawerMediaCount"))$id("drawerMediaCount").textContent=String(images.length);
  grid.innerHTML=images.length?images.map(m=>`<button type="button" class="shared-media-item" data-image="${escapeHtml(m.imageURL)}"><img src="${escapeHtml(imageUrl(m.imageURL,"chat"))}" alt="Shared image" loading="lazy"></button>`).join(""):'<div class="empty-state">No shared images yet.</div>';
  grid.querySelectorAll(".shared-media-item").forEach(b=>b.addEventListener("click",()=>openLightbox(b.dataset.image)));
}

/* Saved messages */
async function renderSavedMessages(){const box=$id("savedList");if(!box||!currentUser)return;box.innerHTML='<div class="empty-state">Loading saved messages…</div>';try{const indexSnap=await getDocs(query(collection(db,"users",currentUser.uid,"savedMessages"),orderBy("savedAt","desc"),limit(100)));let entries=indexSnap.docs.map(d=>({id:d.id,...d.data()}));if(!entries.length){entries=await migrateLegacySavedMessages();}if(!entries.length){box.innerHTML='<div class="empty-state big">No saved messages yet.<br><span>Use ••• on a message to save it.</span></div>';return;}const resolved=[];for(const entry of entries){try{const s=await getDoc(doc(db,"conversations",entry.conversationId,"messages",entry.messageId));if(!s.exists())continue;const m={id:s.id,...s.data()};if(isDeletedForUser(m,currentUser.uid))continue;const partner=userListeners.get(entry.partnerUid)?.data||{uid:entry.partnerUid,name:"Conversation"};resolved.push({entry,m,partner});}catch{}}box.innerHTML=resolved.map(({entry,m,partner})=>`<button class="saved-item" type="button" data-conversation-id="${escapeHtml(entry.conversationId)}" data-message-id="${escapeHtml(entry.messageId)}">${avatarHtml(partner)}<span class="meta"><span class="top-line"><strong>${escapeHtml(partner.name||"Conversation")}</strong><span class="time">${escapeHtml(m.createdAt?.toDate?formatWhen(m.createdAt.toDate()):"")}</span></span><span class="preview-line"><span class="text">${escapeHtml(m.type==="image"?"📷 Photo":m.text||"")}</span></span></span><span class="saved-bookmark">${ICONS.bookmark}</span></button>`).join("");resolved.forEach((x,i)=>{const row=box.querySelectorAll(".saved-item")[i];paintAvatar(row?.querySelector(".avatar"),x.partner);row?.addEventListener("click",async()=>{closeModal("savedModal");await openChatById(x.entry.conversationId);setTimeout(()=>scrollToMessage(x.entry.messageId),250);});});}catch(e){console.error(e);box.innerHTML='<div class="empty-state">Saved messages could not be loaded.</div>';}}
async function migrateLegacySavedMessages(){const found=[];for(const c of conversations.slice(0,12)){try{const snap=await getDocs(query(collection(db,"conversations",c.id,"messages"),orderBy("createdAt","desc"),limit(100)));for(const d of snap.docs){const m={id:d.id,...d.data()};if(isSavedByUser(m,currentUser.uid)&&!isDeletedForUser(m,currentUser.uid)){const entry={messageId:m.id,conversationId:c.id,partnerUid:otherUid(c),savedAt:serverTimestamp(),type:m.type||"text",text:m.text||"",imageURL:m.imageURL||""};found.push(entry);await setDoc(doc(db,"users",currentUser.uid,"savedMessages",m.id),entry,{merge:true});}}}catch(e){console.warn("Legacy save migration failed",e);}}return found;}

/* Phase 1 helpers */
function showMessageDetails(message){const modal=$id("messageDetailsModal");if(!modal)return;const created=timestampDate(message.createdAt),edited=timestampDate(message.editedAt);const delivered=Object.keys(message.deliveredBy||{}).length,read=Object.keys(message.readBy||{}).length;const reactions=Object.entries(message.reactions||{}).filter(([,v])=>v).map(([,v])=>v);$id("messageDetailsTitle").textContent="Message details";$id("messageDetailsBody").innerHTML=`<div class="details-grid"><div><span>Sender</span><strong>${escapeHtml(message.senderId===currentUser.uid?"You":(activeUser?.isGroup?(activeGroupMembers.get(message.senderId)?.name||"Member"):activeUser?.name||"User"))}</strong></div><div><span>Sent</span><strong>${created?escapeHtml(created.toLocaleString()):"Pending…"}</strong></div><div><span>Delivery</span><strong>${message.senderId===currentUser.uid?`Delivered to ${delivered} · Read by ${read}`:"Delivered"}</strong></div><div><span>Reactions</span><strong>${reactions.length?escapeHtml(reactions.join(" ")):"None"}</strong></div>${edited?`<div><span>Edited</span><strong>${escapeHtml(edited.toLocaleString())}</strong></div>`:""}</div>`;openModal("messageDetailsModal");}
async function togglePinMessage(messageId,currentPinned){try{await updateDoc(doc(db,"conversations",activeConversationId,"messages",messageId),{pinnedBy:currentPinned?arrayRemove(currentUser.uid):arrayUnion(currentUser.uid)});showToast(currentPinned?"Message unpinned":"Message pinned 📌","success");}catch(e){console.error(e);showToast(e?.code==="permission-denied"?"Firebase blocked pinning. Deploy the updated rules.":"Could not update pinned message.","error");}}
function startEdit(message){if(message.senderId!==currentUser.uid||message.type!=="text")return;editTarget=message;$id("editMessageError").textContent="";$id("editMessageInput").value=message.text||"";openModal("editMessageModal");setTimeout(()=>{$id("editMessageInput")?.focus();$id("editMessageInput")?.select();},20);}
function cancelEdit(){editTarget=null;closeModal("editMessageModal");}
async function saveEdit(){if(!editTarget)return;const text=$id("editMessageInput")?.value.trim()||"";if(!text){$id("editMessageError").textContent="Message cannot be empty.";return;}const age=timestampDate(editTarget.createdAt)?.getTime();if(age&&Date.now()-age>15*60*1000){$id("editMessageError").textContent="This message is older than 15 minutes and can no longer be edited.";return;}try{await updateDoc(doc(db,"conversations",activeConversationId,"messages",editTarget.id),{text:text.slice(0,5000),editedAt:serverTimestamp()});showToast("Message edited","success");cancelEdit();}catch(e){console.error(e);$id("editMessageError").textContent=e?.code==="permission-denied"?"Firebase blocked editing. Deploy the updated rules.":"Could not edit message.";}}
function setSelectionMode(enabled){selectionMode=!!enabled;if(!selectionMode)selectedMessageIds.clear();renderSelectionToolbar();reconcileMessageDOM();}
function toggleSelectedMessage(id,force){if(force===true)selectedMessageIds.add(id);else if(selectedMessageIds.has(id))selectedMessageIds.delete(id);else selectedMessageIds.add(id);if(!selectedMessageIds.size){setSelectionMode(false);return;}renderSelectionToolbar();reconcileMessageDOM();}
function renderSelectionToolbar(){const bar=$id("selectionToolbar");if(!bar)return;bar.hidden=!selectionMode;if(selectionMode)$id("selectionCount").textContent=`${selectedMessageIds.size} selected`;}
async function deleteSelectedForMe(){const ids=[...selectedMessageIds];if(!ids.length)return;try{for(let i=0;i<ids.length;i+=400){const batch=writeBatch(db);ids.slice(i,i+400).forEach(id=>batch.update(doc(db,"conversations",activeConversationId,"messages",id),{deletedFor:arrayUnion(currentUser.uid)}));await batch.commit();}showToast(`${ids.length} message${ids.length===1?"":"s"} deleted for you`,`info`);setSelectionMode(false);}catch(e){console.error(e);showToast("Could not delete selected messages.","error");}}
async function saveSelectedMessages(){const ids=[...selectedMessageIds];for(const id of ids){const m=currentMessages.find(x=>x.id===id);if(m&&!isSavedByUser(m,currentUser.uid))await toggleSaveMessage(id,false);}setSelectionMode(false);}
function searchCurrentConversation(value){const box=$id("conversationSearchResults");if(!box)return;const q=String(value||"").trim().toLowerCase();const matches=!q?[]:currentMessages.filter(m=>String(m.text||"").toLowerCase().includes(q)).slice(0,80);if(!q){box.innerHTML='<div class="empty-state">Type a word or phrase to search this conversation.</div>';return;}if(!matches.length){box.innerHTML='<div class="empty-state">No matching messages in the currently loaded history.</div>';return;}box.innerHTML=matches.map(m=>`<button type="button" class="search-message-row" data-id="${escapeHtml(m.id)}"><strong>${escapeHtml(m.senderId===currentUser.uid?"You":(activeUser?.isGroup?(activeGroupMembers.get(m.senderId)?.name||"Member"):activeUser?.name||"User"))}</strong><span>${escapeHtml(m.type==="image"?"📷 Photo":m.text||"Attachment")}</span></button>`).join("");box.querySelectorAll(".search-message-row").forEach(b=>b.addEventListener("click",()=>{closeModal("conversationSearchModal");scrollToMessage(b.dataset.id);}));}
async function openForwardModal(messages){const box=$id("forwardConversationList");if(!box)return;window.__cunnactForwardMessages=messages.map(m=>({id:m.id,type:m.type,text:m.text||"",imageURL:m.imageURL||"",mediaURL:m.mediaURL||"",fileName:m.fileName||"",mimeType:m.mimeType||"",fileSize:m.fileSize||0,senderId:m.senderId,quality:m.quality||"optimized",albumId:m.albumId||"",albumIndex:m.albumIndex||0,albumSize:m.albumSize||1,linkUrl:m.linkUrl||"",linkHost:m.linkHost||"",contactUid:m.contactUid||"",contactName:m.contactName||"",contactUsername:m.contactUsername||"",contactPhotoURL:m.contactPhotoURL||"",latitude:m.latitude,longitude:m.longitude,locationLabel:m.locationLabel||""}));const list=conversations.filter(c=>!c.hiddenFor?.[currentUser.uid]&&c.id!==activeConversationId).slice(0,80);if(!list.length){box.innerHTML='<div class="empty-state">No other conversations available.</div>';}else{box.innerHTML=list.map(c=>{const u=conversationDisplay(c);return `<button type="button" class="forward-chat-row" data-conversation-id="${escapeHtml(c.id)}">${avatarHtml(u,{dot:false})}<span><strong>${escapeHtml(u.name||"Conversation")}</strong><small>${c.type==="group"?"Group":"Direct chat"}</small></span></button>`;}).join("");list.forEach(c=>{const row=box.querySelector(`[data-conversation-id="${CSS.escape(c.id)}"]`);paintAvatar(row?.querySelector(".avatar"),conversationDisplay(c));row?.addEventListener("click",()=>forwardToConversation(c));});}openModal("forwardModal");}
async function forwardToConversation(conversation){const messages=window.__cunnactForwardMessages||[];if(!messages.length)return;try{const isGroup=conversation.type==="group",targetUid=isGroup?null:otherUid(conversation);if(!isGroup&&currentBlockedUsers.has(targetUid))throw new Error("BLOCKED");const batch=writeBatch(db);messages.forEach(m=>{const ref=doc(collection(db,"conversations",conversation.id,"messages"));batch.set(ref,{senderId:currentUser.uid,...(isGroup?{}:{receiverId:targetUid}),type:m.type,...(m.text?{text:m.text.slice(0,5000)}:{}),...(m.imageURL?{imageURL:m.imageURL}:{}),...(m.mediaURL?{mediaURL:m.mediaURL}:{}),...(m.fileName?{fileName:m.fileName}:{}),...(m.mimeType?{mimeType:m.mimeType}:{}),...(m.fileSize?{fileSize:m.fileSize}:{}),forwardedFrom:{messageId:m.id,senderId:m.senderId,senderName:m.senderId===currentUser.uid?"You":(userListeners.get(m.senderId)?.data?.name||"Someone")},...(m.albumId?{albumId:m.albumId,albumIndex:m.albumIndex||0,albumSize:m.albumSize||1}:{}),...(m.quality?{quality:m.quality}:{}),...(m.linkUrl?{linkUrl:m.linkUrl,linkHost:m.linkHost||""}:{}),...(m.contactUid?{contactUid:m.contactUid,contactName:m.contactName||"",contactUsername:m.contactUsername||"",contactPhotoURL:m.contactPhotoURL||""}:{}),...(Number.isFinite(Number(m.latitude))?{latitude:Number(m.latitude),longitude:Number(m.longitude),locationLabel:m.locationLabel||"Shared location"}:{}),createdAt:serverTimestamp(),savedBy:[],pinnedBy:[],deletedFor:[],readBy:{},deliveredBy:{},reactions:{}});});const unreadPatch={};if(isGroup)(conversation.members||[]).forEach(uid=>{if(uid!==currentUser.uid)unreadPatch[`unread.${uid}`]=increment(messages.length);});else unreadPatch[`unread.${targetUid}`]=increment(messages.length);const last=messages[messages.length-1];const preview=last.type==="image"?"📷 Photo":last.type==="audio"?"🎤 Voice message":last.type==="video"?"🎬 Video":last.type==="document"?`📄 ${last.fileName||"Document"}`:last.text||"Forwarded message";batch.update(doc(db,"conversations",conversation.id),{lastMessage:preview,lastMessageType:last.type,lastMessageSenderId:currentUser.uid,lastMessageTime:serverTimestamp(),...unreadPatch});await batch.commit();closeModal("forwardModal");showToast("Message forwarded","success");}catch(e){console.error(e);showToast(e?.message==="BLOCKED"?"That conversation is blocked.":e?.code==="permission-denied"?"Firebase blocked forwarding. Deploy the updated rules.":"Could not forward message.","error");}}
function toggleComposerPanel(id){document.querySelectorAll(".composer-popover").forEach(p=>{if(p.id!==id)p.hidden=true;});const p=$id(id);if(p)p.hidden=!p.hidden;}
function insertComposerText(text){const input=$id("messageInput");if(!input)return;const start=input.selectionStart??input.value.length,end=input.selectionEnd??start;input.value=input.value.slice(0,start)+text+input.value.slice(end);input.selectionStart=input.selectionEnd=start+text.length;autoGrowComposer();input.focus();}
async function sendSticker(sticker){if(!activeUser||!activeConversationId)return;try{await sendMessage({type:"sticker",text:sticker});playSend();$id("stickerPanel").hidden=true;}catch(e){console.error(e);showToast("Could not send sticker.","error");}}
function updateVoiceButton(recording){const b=$id("voiceNoteBtn");if(!b)return;b.classList.toggle("recording",recording);b.setAttribute("aria-label",recording?"Stop recording":"Record voice note");b.title=recording?"Stop & send voice note":"Voice note";}
async function sendVoiceBlob(blob){try{const {uploadFileToCloudinary}=await import("./cloudinary.js");const url=await uploadFileToCloudinary(new File([blob],`cunnact-voice-${Date.now()}.webm`,{type:blob.type}),{});await sendMessage({type:"audio",mediaURL:url,mimeType:blob.type,fileSize:blob.size});playSend();showToast("Voice note sent","success");}catch(e){console.error(e);showToast(e?.userMessage||"Voice note could not be uploaded. Check the Cloudinary preset.","error");}}
async function recordVoiceNote(){if(voiceRecorder){voiceRecorder.stop();updateVoiceButton(false);return;}if(!navigator.mediaDevices?.getUserMedia||!window.MediaRecorder){showToast("Voice recording is not supported here.","error");return;}try{const stream=await navigator.mediaDevices.getUserMedia({audio:true});const mime=["audio/webm;codecs=opus","audio/webm","audio/ogg;codecs=opus"].find(x=>window.MediaRecorder.isTypeSupported?.(x))||"";voiceChunks=[];voiceRecorder=new MediaRecorder(stream,mime?{mimeType:mime}:undefined);voiceRecorder.ondataavailable=e=>{if(e.data.size)voiceChunks.push(e.data);};voiceRecorder.onstop=async()=>{stream.getTracks().forEach(t=>t.stop());const blob=new Blob(voiceChunks,{type:voiceRecorder?.mimeType||"audio/webm"});voiceRecorder=null;voiceChunks=[];updateVoiceButton(false);if(blob.size<500){showToast("Voice note was too short.","info");return;}await sendVoiceBlob(blob);};voiceRecorder.start();updateVoiceButton(true);showToast("Recording… tap mic again to send.","info");}catch(e){console.error(e);voiceRecorder=null;updateVoiceButton(false);showToast("Microphone permission was denied or unavailable.","error");}}

function openGifModal(){if(!activeConversationId||!activeUser||isBlockedByEither())return;$id("gifUrlInput")&&($id("gifUrlInput").value="");$id("gifError")&&($id("gifError").textContent="");openModal("gifModal");setTimeout(()=> $id("gifUrlInput")?.focus(),20);}
async function sendGifFromModal(){const input=$id("gifUrlInput"),err=$id("gifError");const url=String(input?.value||"").trim();if(!isTrustedGifUrl(url)){if(err)err.textContent="Use a secure GIPHY or Tenor GIF URL.";return;}try{await sendMessage({type:"gif",imageURL:url,text:"GIF"});playSend();closeModal("gifModal");showToast("GIF sent","success");}catch(e){console.error(e);if(err)err.textContent="Could not send the GIF.";}}
function openContactShareModal(){if(!activeConversationId||!activeUser||isBlockedByEither())return;const box=$id("contactShareList");if(!box)return;const contacts=contactList().filter(u=>u.uid!==activeUser.uid);if(!contacts.length){box.innerHTML='<div class="empty-state">You do not have another connected contact to share yet.</div>';}else{box.innerHTML=contacts.map(u=>`<button type="button" class="forward-chat-row contact-share-row" data-uid="${escapeHtml(u.uid)}">${avatarHtml(u,{dot:false})}<span class="meta"><strong>${escapeHtml(u.name||"User")}</strong><small>${u.username?`@${escapeHtml(u.username)}`:"CUNNACT contact"}</small></span></button>`).join("");contacts.forEach(u=>{const row=box.querySelector(`[data-uid="${CSS.escape(u.uid)}"]`);paintAvatar(row?.querySelector(".avatar"),u);row?.addEventListener("click",async()=>{try{await sendMessage({type:"contact",text:u.name||"Contact",contactUid:u.uid,contactName:u.name||"User",contactUsername:u.username||"",contactPhotoURL:u.photoURL||""});playSend();closeModal("contactModal");showToast("Contact shared","success");}catch(e){console.error(e);showToast(e?.code==="permission-denied"?"Firebase blocked contact sharing.":"Could not share contact.","error");}});});}openModal("contactModal");}
function shareCurrentLocation(){if(!activeConversationId||!activeUser||isBlockedByEither())return;if(!navigator.geolocation){showToast("Location sharing is not supported here.","error");return;}showToast("Getting your location…","info");navigator.geolocation.getCurrentPosition(async pos=>{const latitude=Number(pos.coords.latitude.toFixed(6)),longitude=Number(pos.coords.longitude.toFixed(6));try{await sendMessage({type:"location",latitude,longitude,locationLabel:"Current location"});playSend();showToast("Location shared","success");}catch(e){console.error(e);showToast(e?.code==="permission-denied"?"Firebase blocked location sharing.":"Could not share location.","error");}},()=>showToast("Could not get your location. Check browser permissions.","error"),{enableHighAccuracy:true,timeout:10000,maximumAge:30000});}


/* Shared helpers */
function closeProfileIfDesktop(){if(innerWidth<=1100)closeProfileDrawer();}
window.addEventListener("resize",closeProfileIfDesktop);

// Rich emoji picker: category tabs, search, and WhatsApp-style footer tabs.
const EMOJI_CATALOG = {
  smileys: {
    label: 'Smileys & People',
    items: '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 🙃 😉 😌 😍 🥰 😘 😗 😙 😚 😋 😛 😝 😜 🤪 🤨 🧐 🤓 😎 🤩 🥳 😏 😒 😞 😔 😟 😕 🙁 ☹️ 😣 😖 😫 😩 🥺 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😥 😓 🤗 🤔 🤭 🤫 🤥 😶 😐 😑 😬 🙄 😯 😦 😧 😮 😲 🥱 😴 🤤 😪 😵 🤐 🤑 🤠 😈 👿 👹 👺 🤡 💩 👻 💀 ☠️ 👽 👾 🤖 🎃 😺 😸 😹 😻 😼 😽 🙀 😿 😾'.split(' ')
  },
  people: {
    label: 'People & Body',
    items: '👋 🤚 🖐️ ✋ 🖖 👌 🤏 ✌️ 🤞 🫶 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✍️ 👏 🙌 👐 🤲 🙏 💪 🖕 👀 👁️ 👄 🫦 🧠 👶 🧒 👦 👧 🧑 👱 👨 👩 🧔 👴 👵 🙍 🙎 🙅 🙆 💁 🙋 🧏 🙌 💇 💆 🚶 🧍 🧎 🏃 💃 🕺 🧖 🏄 🏊 🤽 🚴 🚵 🤸 🤾 🧘 🤳'.split(' ')
  },
  animals: {
    label: 'Animals & Nature',
    items: '🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐒 🐔 🐧 🐦 🐤 🐣 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞 🐜 🕷️ 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦀 🐠 🐟 🐡 🐬 🦈 🐳 🐋 🐊 🐅 🐆 🦓 🦍 🐘 🦏 🦛 🐪 🐫 🦒 🦘 🐃 🐂 🐄 🐎 🐖 🐏 🐑 🦙 🐐 🦌 🐕 🐈 🐓 🦃 🕊️ 🦜 🦢 🦩 🐇 🌸 🌹 🌻 🌺 🌷 🌼 🌱 🌲 🌳 🌴 🌵 🍀 🍁 🍂 🍃'.split(' ')
  },
  food: {
    label: 'Food & Drink',
    items: '🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🍆 🥔 🥕 🌽 🌶️ 🫑 🥒 🥬 🥦 🧄 🧅 🍄 🥜 🌰 🍞 🥐 🥖 🥨 🧀 🥚 🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🥙 🧆 🌮 🌯 🫔 🥗 🥘 🫕 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🦪 🍤 🍚 🍙 🍘 🍥 🍡 🥠 🥮 🍢 🍧 🍨 🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 ☕ 🫖 🥤 🧋 🧃 🧉 🍺 🍻 🍷 🍸 🍹 🥂 🥃'.split(' ')
  },
  travel: {
    label: 'Travel & Places',
    items: '🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🛻 🚚 🚛 🚜 🛵 🏍️ 🚲 🛴 🚨 🚥 🚦 🛣️ 🛤️ ⛽ 🚧 ⚓ ⛵ 🚤 🛥️ 🛳️ 🚢 ✈️ 🛩️ 🛫 🛬 🪂 💺 🚀 🛸 🛰️ 🗺️ 🗿 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛱️ 🏖️ 🏝️ 🏜️ 🏕️ ⛰️ 🏔️ 🌋 🗻 🏠 🏡 🏢 🏥 🏦 🏨 🏫 🏪 ⛪ 🕌 🛕 🕍 ⛩️ 🗾 🌅 🌄 🌠 🌆 🌇 🌉 ♨️ 🎑'.split(' ')
  },
  objects: {
    label: 'Objects',
    items: '⌚ 📱 💻 ⌨️ 🖱️ 🖨️ 🖥️ 📷 📸 📹 🎥 📞 ☎️ 📺 📻 🎙️ 🎧 🎤 🎼 🎹 🥁 🎷 🎺 🎸 🎻 📚 📖 🔖 📰 📝 ✏️ ✒️ 🖊️ 🖋️ ✂️ 📌 📍 📎 🖇️ 📏 📐 🔒 🔓 🔑 🔨 🪛 🔧 🛠️ ⚙️ 🧰 🧲 🔬 🔭 💡 🔦 🕯️ 🧯 🛒 💰 💳 🧾 💎 ⚖️ 🧴 🧷 🧹 🧺 🧻 🪣 🧼 🪥 🧽 🛏️ 🛋️ 🚪 🪑 🚽 🚿 🛁 🎁 🎈 🎉 🪄 🎀 🏆 🥇 🥈 🥉 ⚽ 🏀 🏈 ⚾ 🎾 🏐 🎱 🪀 🧩 🎯 🪁 🎮 🕹️ 🎲 ♟️'.split(' ')
  },
  symbols: {
    label: 'Symbols',
    items: '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 ❤️‍🩹 💕 💞 💓 💗 💖 💘 💝 💟 ❣️ 💯 💢 💥 💫 💦 💨 🕳️ 💣 💬 👁️‍🗨️ 🗯️ 💭 💤 ☀️ 🌤️ ⛅ 🌥️ 🌦️ ☁️ 🌧️ ⛈️ 🌩️ 🌨️ ❄️ ☃️ 🔥 🌪️ 🌈 ⭐ 🌟 ✨ ⚡ ☄️ 💧 🌊 ✅ ❌ ❗ ❕ ❓ ❔ ‼️ ⁉️ ⚠️ 🚫 ⛔ 🔞 ♻️ ©️ ®️ ™️ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤'.split(' ')
  },
  flags: {
    label: 'Flags',
    items: '🏳️ 🏴 🏁 🚩 🏳️‍🌈 🏳️‍⚧️ 🇮🇳 🇺🇸 🇬🇧 🇨🇦 🇦🇺 🇩🇪 🇫🇷 🇮🇹 🇪🇸 🇯🇵 🇰🇷 🇨🇳 🇸🇬 🇦🇪 🇸🇦 🇧🇷 🇳🇵 🇧🇹 🇵🇰 🇱🇰 🇧🇩 🇷🇺 🇺🇦 🇿🇦 🇲🇾 🇮🇩 🇹🇭 🇻🇳 🇵🇭 🇳🇿 🇲🇽 🇦🇷 🇵🇹 🇳🇱 🇸🇪 🇳🇴 🇩🇰 🇫🇮 🇮🇪 🇨🇭 🇦🇹 🇹🇷 🇪🇬 🇮🇱 🇵🇱 🇬🇷 🇭🇺'.split(' ')
  }
};

let emojiCategory = 'smileys';
function renderEmojiPicker(){
  const grid=$id('emojiGrid');
  const search=$id('emojiSearchInput');
  const label=$id('emojiSectionLabel');
  if(!grid)return;
  const query=(search?.value||'').trim().toLowerCase();
  const data=EMOJI_CATALOG[emojiCategory]||EMOJI_CATALOG.smileys;
  if(label)label.textContent=query?'Search results':data.label;
  const items=query ? Object.values(EMOJI_CATALOG).flatMap(section=>section.items).filter((v,i,a)=>a.indexOf(v)===i && v.includes(query)) : data.items;
  grid.innerHTML=items.length?items.map(e=>`<button type="button" class="emoji-choice" data-emoji="${e}" aria-label="${e}">${e}</button>`).join(''):`<div class="emoji-empty">No emoji found</div>`;
}
function setEmojiCategory(category){
  if(!EMOJI_CATALOG[category])return;
  emojiCategory=category;
  document.querySelectorAll('.emoji-category-tab').forEach(btn=>btn.classList.toggle('is-active',btn.dataset.emojiCategory===category));
  if($id('emojiSearchInput'))$id('emojiSearchInput').value='';
  renderEmojiPicker();
}
function initEmojiPicker(){
  renderEmojiPicker();
  document.addEventListener('click',e=>{
    const emoji=e.target.closest?.('#emojiGrid .emoji-choice');
    if(emoji){insertComposerText(emoji.dataset.emoji||'');return;}
    const cat=e.target.closest?.('.emoji-category-tab');
    if(cat){setEmojiCategory(cat.dataset.emojiCategory);return;}
    const tab=e.target.closest?.('.emoji-footer-tab');
    if(tab){
      const type=tab.dataset.pickerTab;
      document.querySelectorAll('.emoji-footer-tab').forEach(b=>b.classList.toggle('is-active',b===tab));
      if(type==='gif'){ $id('emojiPanel')?.setAttribute('hidden',''); $id('gifModal') && openModal('gifModal'); return; }
      if(type==='sticker'){ $id('emojiPanel')?.removeAttribute('hidden'); $id('stickerBtn')?.focus?.(); return; }
      $id('emojiPanel')?.removeAttribute('hidden');
    }
  });
  $id('emojiSearchInput')?.addEventListener('input',renderEmojiPicker);
}
initEmojiPicker();
