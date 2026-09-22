import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, updateProfile,
  doc, setDoc, serverTimestamp, runTransaction
} from "./firebase.js";
import { $ } from "./ui.js";

const errorBox = $("authError");
const FRIENDLY_ERRORS = {
  "auth/invalid-credential":"Invalid email or password.",
  "auth/user-not-found":"Invalid email or password.",
  "auth/wrong-password":"Invalid email or password.",
  "auth/email-already-in-use":"This email is already registered.",
  "auth/weak-password":"Password should be at least 6 characters.",
  "auth/invalid-email":"Please enter a valid email.",
  "auth/too-many-requests":"Too many attempts. Please wait a moment and try again.",
  "auth/network-request-failed":"Network error. Check your connection and try again."
};
const RESERVED = new Set(["admin","administrator","support","help","cunnact","official","security","system","root","api","www","user","users","profile","login","register","settings"]);
const sanitize = value => String(value||"").toLowerCase().replace(/[^a-z0-9_]/g, "");
const makeBase = (name,email) => { let base=(sanitize(name)||sanitize(String(email||"").split("@")[0])||"cunnacter").slice(0,24); if(base.length<5) base=(base+"user").slice(0,24); return base; };
async function claimInitialUsername(uid,name,email) {
  const base=makeBase(name,email);
  for(let n=0;n<100;n++){
    const suffix=n===0?"":String(100+n);
    const candidate=(base.slice(0,24-suffix.length)+suffix).slice(0,24);
    if(candidate.length<5||RESERVED.has(candidate))continue;
    try{
      await runTransaction(db,async(tx)=>{
        const ref=doc(db,"usernames",candidate),snap=await tx.get(ref);
        if(snap.exists()&&snap.data()?.uid!==uid)throw new Error("USERNAME_TAKEN");
        tx.set(ref,{uid,createdAt:serverTimestamp()},{merge:true});
        tx.set(doc(db,"users",uid),{username:candidate,usernameLower:candidate},{merge:true});
        tx.set(doc(db,"publicProfiles",uid),{uid,username:candidate,usernameLower:candidate,displayName:name,photoURL:"",bio:"",updatedAt:serverTimestamp()},{merge:true});
      });
      return candidate;
    }catch(e){if(e.message!=="USERNAME_TAKEN")throw e;}
  }
  return "";
}
function setBusy(form,busy){const btn=form.querySelector('button[type="submit"]');btn.disabled=busy;btn.dataset.label ||= btn.textContent;btn.textContent=busy?"Please wait…":btn.dataset.label;}
const friendlyError = e => FRIENDLY_ERRORS[e?.code] || "Something went wrong. Please try again.";

onAuthStateChanged(auth,user=>{if(user&&(location.pathname.endsWith("login.html")||location.pathname.endsWith("register.html")))location.href="index.html";});
$("loginForm")?.addEventListener("submit",async e=>{e.preventDefault();errorBox.textContent="";const form=e.target;setBusy(form,true);try{await signInWithEmailAndPassword(auth,$("email").value.trim(),$("password").value);location.href="index.html";}catch(err){errorBox.textContent=friendlyError(err);setBusy(form,false);}});
$("registerForm")?.addEventListener("submit",async e=>{e.preventDefault();errorBox.textContent="";const form=e.target,password=$("password").value,confirm=$("confirmPassword").value,name=$("name").value.trim(),email=$("email").value.trim().toLowerCase();if(password!==confirm){errorBox.textContent="Passwords do not match.";return;}if(!name){errorBox.textContent="Please enter your name.";return;}setBusy(form,true);try{const credential=await createUserWithEmailAndPassword(auth,email,password);await updateProfile(credential.user,{displayName:name});await setDoc(doc(db,"users",credential.user.uid),{uid:credential.user.uid,name,email,emailLower:email,photoURL:"",bio:"",createdAt:serverTimestamp(),lastSeen:serverTimestamp(),isOnline:true,lastHeartbeat:serverTimestamp()});await setDoc(doc(db,"userSettings",credential.user.uid),{retentionMode:"24hours",theme:localStorage.getItem("cunnact_theme")||"light",soundEnabled:localStorage.getItem("cunnact_sound_enabled")!=="false",createdAt:serverTimestamp()});await claimInitialUsername(credential.user.uid,name,email);location.href="index.html";}catch(err){console.error("Registration failed",err);errorBox.textContent=friendlyError(err);setBusy(form,false);}});
