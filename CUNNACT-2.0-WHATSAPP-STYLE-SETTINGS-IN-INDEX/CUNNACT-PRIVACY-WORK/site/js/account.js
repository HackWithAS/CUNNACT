import {
  auth, db, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  collection, query, where, limit, orderBy, writeBatch, serverTimestamp
} from "./firebase.js";
import { showToast } from "./toast.js";
import { escapeHtml } from "./ui.js";

const BACKUP_VERSION = 1;
const MAX_MESSAGES_PER_CONVERSATION = 5000;
const allowedMessageTypes = new Set(["text","image","audio","video","document","sticker","gif","contact","location","poll","event"]);

function serialise(value) {
  if (value == null) return value;
  if (typeof value?.toDate === "function") return { __type: "timestamp", value: value.toDate().toISOString() };
  if (Array.isArray(value)) return value.map(serialise);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, serialise(v)]));
  return value;
}
function deserialise(value) {
  if (Array.isArray(value)) return value.map(deserialise);
  if (value && typeof value === "object") {
    if (value.__type === "timestamp" && value.value) return new Date(value.value);
    return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, deserialise(v)]));
  }
  return value;
}
function downloadJson(filename, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function readJsonFile(file) {
  if (!file || file.size > 50 * 1024 * 1024) throw new Error("Backup file must be 50 MB or smaller.");
  const data = JSON.parse(await file.text());
  if (!data || data.format !== "cunnact-backup" || data.version !== BACKUP_VERSION) throw new Error("This is not a supported CUNNACT backup file.");
  return data;
}

export async function collectAccountBackup(user) {
  if (!user?.uid) throw new Error("Sign in first.");
  const uid = user.uid;
  const backup = {
    format: "cunnact-backup",
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    ownerUid: uid,
    profile: null,
    publicProfile: null,
    settings: null,
    blockedUsers: [],
    savedMessages: [],
    messageRequests: [],
    conversations: [],
    stories: [],
    communities: [],
    channels: []
  };

  const [profile, publicProfile, settings] = await Promise.all([
    getDoc(doc(db,"users",uid)), getDoc(doc(db,"publicProfiles",uid)), getDoc(doc(db,"userSettings",uid))
  ]);
  backup.profile = profile.exists() ? serialise(profile.data()) : null;
  backup.publicProfile = publicProfile.exists() ? serialise(publicProfile.data()) : null;
  backup.settings = settings.exists() ? serialise(settings.data()) : null;

  try {
    const snap = await getDocs(collection(db,"users",uid,"blockedUsers"));
    backup.blockedUsers = snap.docs.map(d => ({ id:d.id, data:serialise(d.data()) }));
  } catch {}
  try {
    const snap = await getDocs(collection(db,"users",uid,"savedMessages"));
    backup.savedMessages = snap.docs.map(d => ({ id:d.id, data:serialise(d.data()) }));
  } catch {}
  try {
    const [sent, received] = await Promise.all([
      getDocs(query(collection(db,"messageRequests"),where("senderId","==",uid),limit(500))),
      getDocs(query(collection(db,"messageRequests"),where("receiverId","==",uid),limit(500)))
    ]);
    const map = new Map(); [...sent.docs,...received.docs].forEach(d => map.set(d.id,{id:d.id,data:serialise(d.data())}));
    backup.messageRequests = [...map.values()];
  } catch {}

  const conversations = await getDocs(query(collection(db,"conversations"),where("members","array-contains",uid),limit(500)));
  for (const convoDoc of conversations.docs) {
    const c = { id: convoDoc.id, data: serialise(convoDoc.data()), messages: [] };
    try {
      const msgSnap = await getDocs(query(collection(db,"conversations",convoDoc.id,"messages"),limit(MAX_MESSAGES_PER_CONVERSATION)));
      c.messages = msgSnap.docs.map(d => ({ id:d.id, data:serialise(d.data()) }));
    } catch {}
    backup.conversations.push(c);
  }

  try {
    const stories = await getDocs(query(collection(db,"stories"),where("ownerId","==",uid),limit(200)));
    for (const story of stories.docs) {
      const item = {id:story.id,data:serialise(story.data()),viewers:[],replies:[],reactions:[]};
      try { const s=await getDocs(collection(db,"stories",story.id,"viewers")); item.viewers=s.docs.map(d=>({id:d.id,data:serialise(d.data())})); } catch {}
      try { const s=await getDocs(collection(db,"stories",story.id,"replies")); item.replies=s.docs.map(d=>({id:d.id,data:serialise(d.data())})); } catch {}
      try { const s=await getDocs(collection(db,"stories",story.id,"reactions")); item.reactions=s.docs.map(d=>({id:d.id,data:serialise(d.data())})); } catch {}
      backup.stories.push(item);
    }
  } catch {}
  try {
    const snap = await getDocs(query(collection(db,"communities"),where("memberIds","array-contains",uid),limit(200)));
    backup.communities = snap.docs.map(d=>({id:d.id,data:serialise(d.data())}));
  } catch {}
  try {
    const snap = await getDocs(query(collection(db,"channels"),where("subscriberIds","array-contains",uid),limit(200)));
    backup.channels = snap.docs.map(d=>({id:d.id,data:serialise(d.data())}));
  } catch {}
  return backup;
}

export async function exportAccountData(user) {
  const backup = await collectAccountBackup(user);
  downloadJson(`cunnact-backup-${new Date().toISOString().slice(0,10)}.json`, backup);
  showToast("CUNNACT backup downloaded", "success");
  return backup;
}

export async function restoreAccountBackup(user, file) {
  if (!user?.uid) throw new Error("Sign in first.");
  const backup = await readJsonFile(file);
  if (backup.ownerUid !== user.uid) throw new Error("For security, this backup can only be restored into the same CUNNACT account that created it.");
  const uid=user.uid;
  const profile=deserialise(backup.profile||{}), publicProfile=deserialise(backup.publicProfile||{}), settings=deserialise(backup.settings||{});
  if (Object.keys(profile).length) await setDoc(doc(db,"users",uid),{...profile,uid,updatedAt:serverTimestamp()},{merge:true});
  if (Object.keys(publicProfile).length) await setDoc(doc(db,"publicProfiles",uid),{...publicProfile,uid,updatedAt:serverTimestamp()},{merge:true});
  if (Object.keys(settings).length) await setDoc(doc(db,"userSettings",uid),{...settings,updatedAt:serverTimestamp()},{merge:true});

  let restored=0;
  for (const convo of (backup.conversations||[])) {
    const convoSnap=await getDoc(doc(db,"conversations",convo.id)).catch(()=>null);
    if(!convoSnap?.exists() || !(convoSnap.data()?.members||[]).includes(uid)) continue;
    for (const wrapped of (convo.messages||[])) {
      const data=deserialise(wrapped.data||{});
      if(data.senderId!==uid || !allowedMessageTypes.has(data.type)) continue;
      const clean={...data,senderId:uid,createdAt:serverTimestamp(),restoredAt:serverTimestamp()};
      delete clean.readBy; delete clean.deliveredBy;
      await setDoc(doc(db,"conversations",convo.id,"messages",wrapped.id),clean,{merge:true});
      restored++;
    }
  }
  showToast(`Backup restored: ${restored} of your own messages plus account settings.`, "success", 6000);
  return {restored};
}

export function bindAccountTools({ userRef }) {
  const backupBtn=document.getElementById("exportBackupBtn");
  const restoreBtn=document.getElementById("restoreBackupBtn");
  const input=document.getElementById("restoreBackupInput");
  const dataBtn=document.getElementById("downloadAccountDataBtn");
  if(backupBtn && !backupBtn.dataset.bound){backupBtn.dataset.bound="1";backupBtn.addEventListener("click",async()=>{try{backupBtn.disabled=true;backupBtn.textContent="Preparing…";await exportAccountData(userRef?.());}catch(e){showToast(e?.message||"Could not create backup.","error");}finally{backupBtn.disabled=false;backupBtn.textContent="Download backup";}});}
  if(dataBtn && !dataBtn.dataset.bound){dataBtn.dataset.bound="1";dataBtn.addEventListener("click",async()=>{try{dataBtn.disabled=true;dataBtn.textContent="Preparing…";await exportAccountData(userRef?.());}catch(e){showToast(e?.message||"Could not export account data.","error");}finally{dataBtn.disabled=false;dataBtn.textContent="Download account data";}});}
  if(restoreBtn && !restoreBtn.dataset.bound){restoreBtn.dataset.bound="1";restoreBtn.addEventListener("click",()=>input?.click());}
  if(input && !input.dataset.bound){input.dataset.bound="1";input.addEventListener("change",async()=>{const file=input.files?.[0];input.value="";try{await restoreAccountBackup(userRef?.(),file);}catch(e){showToast(e?.message||"Could not restore backup.","error");}});}
}

export function requestDeleteAccount(user) {
  const fn = window.__cunnactDeleteAccount;
  if (!fn) throw new Error("Account deletion service is not available yet.");
  return fn(user);
}
