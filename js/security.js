import {
  db, auth, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc,
  collection, query, orderBy, limit, onSnapshot, serverTimestamp
} from "./firebase.js";
import { showToast } from "./toast.js";

const DEVICE_STORAGE_KEY = "cunnact_device_session";
const PIN_ITERATIONS = 100000;

function platformLabel(){
  const ua=navigator.userAgent||"";
  const os=/Windows/i.test(ua)?"Windows":/Android/i.test(ua)?"Android":/iPhone|iPad|iPod/i.test(ua)?"iOS":/Mac/i.test(ua)?"macOS":"Web";
  const browser=/Edg/i.test(ua)?"Edge":/Chrome/i.test(ua)?"Chrome":/Firefox/i.test(ua)?"Firefox":/Safari/i.test(ua)?"Safari":"Browser";
  return `${os} · ${browser}`;
}
function randomId(){ return crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2)}`; }
async function sha256Hex(buffer){ const hash=await crypto.subtle.digest("SHA-256",buffer); return [...new Uint8Array(hash)].map(b=>b.toString(16).padStart(2,"0")).join(""); }
function utf8(text){ return new TextEncoder().encode(text); }
async function derivePinHash(pin,salt){
  if(!/^\d{4,8}$/.test(String(pin))) throw new Error("PIN must be 4–8 digits");
  if(!globalThis.crypto?.subtle) throw new Error("Secure crypto is unavailable in this browser.");
  const key=await globalThis.crypto.subtle.importKey("raw",utf8(String(pin)),"PBKDF2",false,["deriveBits"]);
  const bits=await globalThis.crypto.subtle.deriveBits({name:"PBKDF2",salt:utf8(String(salt)),iterations:PIN_ITERATIONS,hash:"SHA-256"},key,256);
  return [...new Uint8Array(bits)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
async function legacyHashPin(pin,salt){
  const base=await sha256Hex(utf8(`${salt}:${pin}`));
  let value=base;
  for(let i=1;i<1000;i++) value=await sha256Hex(utf8(`${salt}:${value}`));
  return value;
}
export async function createPinHash(pin){ const salt=randomId(); return {salt,hash:await derivePinHash(pin,salt)}; }
export async function verifyPin(pin,salt,expected){ try{
  if(!salt||!expected)return false;
  if(expected.length===64){
    const modern=await derivePinHash(pin,salt); if(modern===expected)return true;
    return (await legacyHashPin(pin,salt))===expected;
  }
  return false;
}catch{return false;} }

export function getDeviceSessionId(){
  let id=sessionStorage.getItem(DEVICE_STORAGE_KEY);
  if(!id){ id=randomId(); sessionStorage.setItem(DEVICE_STORAGE_KEY,id); }
  return id;
}
export async function registerDeviceSession(user, meta={}){
  if(!user?.uid)return null;
  const id=getDeviceSessionId();
  const ref=doc(db,"users",user.uid,"devices",id);
  const existing=await getDoc(ref).catch(()=>null);
  const base={sessionId:id,label:meta.label||platformLabel(),platform:meta.platform||platformLabel(),userAgent:(navigator.userAgent||"").slice(0,500),active:true,lastSeen:serverTimestamp()};
  if(existing?.exists()) await updateDoc(ref,{...base,current:true}).catch(()=>{});
  else await setDoc(ref,{...base,createdAt:serverTimestamp(),current:true},{merge:true}).catch(()=>{});
  return id;
}
export function listenCurrentDevice(user, onRevoked){
  if(!user?.uid)return ()=>{};
  const id=getDeviceSessionId();
  return onSnapshot(doc(db,"users",user.uid,"devices",id), snap=>{
    if(snap.exists() && snap.data()?.active===false) onRevoked?.();
  },()=>{});
}
export async function touchCurrentDevice(user){
  if(!user?.uid)return;
  await updateDoc(doc(db,"users",user.uid,"devices",getDeviceSessionId()),{lastSeen:serverTimestamp()}).catch(()=>{});
}
export async function listDevices(user){
  if(!user?.uid)return [];
  const snap=await getDocs(query(collection(db,"users",user.uid,"devices"),orderBy("lastSeen","desc"),limit(25)));
  return snap.docs.map(d=>({id:d.id,...d.data()}));
}
export async function revokeDevice(user,id){
  if(!user?.uid||!id||id===getDeviceSessionId()) return false;
  await updateDoc(doc(db,"users",user.uid,"devices",id),{active:false}).catch(async()=>{
    await setDoc(doc(db,"users",user.uid,"devices",id),{active:false},{merge:true});
  });
  return true;
}
export async function revokeOtherDevices(user){
  const devices=await listDevices(user);
  for(const d of devices) if(d.id!==getDeviceSessionId()&&d.active!==false) await revokeDevice(user,d.id);
  return devices.length;
}
export async function writeSecurityEvent(user,{type,details="",deviceId=getDeviceSessionId()}={}){
  if(!user?.uid)return;
  const ref=doc(collection(db,"securityEvents"));
  await setDoc(ref,{userId:user.uid,type:String(type||"event").slice(0,60),details:String(details||"").slice(0,400),deviceId,createdAt:serverTimestamp()},{merge:false}).catch(()=>{});
}
export function isAppLockEnabled(settings){return !!(settings?.appLockEnabled && settings?.appLockSalt && settings?.appLockHash);}
export async function getUserSettings(uid){
  if(!uid)return {};
  const snap=await getDoc(doc(db,"userSettings",uid));
  return snap.exists()?snap.data():{};
}
export async function saveUserSettings(uid, fields){
  if(!uid)return;
  await setDoc(doc(db,"userSettings",uid),{...fields,updatedAt:serverTimestamp()},{merge:true});
}
export function startAppLockGuard(user,getSettings,showLock){
  let unlocked=true;
  let hiddenAt=0;
  const check=async(force=false)=>{
    const settings=await getSettings();
    if(!isAppLockEnabled(settings)){unlocked=true;return;}
    if(force||!unlocked){unlocked=false;showLock?.(settings);}
  };
  const onVisibility=()=>{
    if(document.visibilityState!=="visible"){hiddenAt=Date.now();return;}
    if(Date.now()-hiddenAt>15000){ unlocked=false; check(true); }
  };
  document.addEventListener("visibilitychange",onVisibility);
  return {unlock:()=>{unlocked=true;},lock:()=>{unlocked=false;showLock?.()},check:()=>check(true),destroy:()=>document.removeEventListener("visibilitychange",onVisibility)};
}

export { platformLabel };
