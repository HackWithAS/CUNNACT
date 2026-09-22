import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, updateProfile,
  sendEmailVerification, sendPasswordResetEmail,
  doc, getDoc, setDoc, serverTimestamp, runTransaction
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

function validateUsername(raw){
  const candidate = sanitize(raw);
  if (candidate !== String(raw||"").toLowerCase()) return { ok:false, msg:"CUNNACT ID can only use lowercase letters, numbers and _." };
  if (candidate.length < 3 || candidate.length > 24) return { ok:false, msg:"CUNNACT ID must be 3–24 characters." };
  if (RESERVED.has(candidate)) return { ok:false, msg:"That CUNNACT ID is reserved. Please choose another." };
  return { ok:true, candidate };
}

/** Claims the exact username the person chose. Throws USERNAME_TAKEN if it's gone. */
async function claimChosenUsername(uid,candidate,name) {
  await runTransaction(db,async(tx)=>{
    const ref=doc(db,"usernames",candidate),snap=await tx.get(ref);
    if(snap.exists()&&snap.data()?.uid!==uid)throw new Error("USERNAME_TAKEN");
    tx.set(ref,{uid,createdAt:serverTimestamp()},{merge:true});
    tx.set(doc(db,"users",uid),{username:candidate,usernameLower:candidate},{merge:true});
    tx.set(doc(db,"publicProfiles",uid),{uid,username:candidate,usernameLower:candidate,displayName:name,photoURL:"",bio:"",updatedAt:serverTimestamp()},{merge:true});
  });
}

function setBusy(form,busy){const btn=form.querySelector('button[type="submit"]');btn.disabled=busy;btn.dataset.label ||= btn.textContent;btn.textContent=busy?"Please wait…":btn.dataset.label;}
const friendlyError = e => FRIENDLY_ERRORS[e?.code] || "Something went wrong. Please try again.";

onAuthStateChanged(auth,user=>{if(user&&(location.pathname.endsWith("login.html")||location.pathname.endsWith("register.html")))location.href="index.html";});

$("loginForm")?.addEventListener("submit",async e=>{
  e.preventDefault();errorBox.textContent="";const form=e.target;setBusy(form,true);
  try{ await signInWithEmailAndPassword(auth,$("email").value.trim(),$("password").value); location.href="index.html"; }
  catch(err){ errorBox.textContent=friendlyError(err); setBusy(form,false); }
});

$("forgotPasswordLink")?.addEventListener("click", async (e) => {
  e.preventDefault();
  errorBox.textContent = "";
  const email = $("email")?.value.trim();
  if (!email) { errorBox.textContent = "Enter your email above first, then tap \u201cForgot password?\u201d."; return; }
  try {
    await sendPasswordResetEmail(auth, email);
    errorBox.textContent = `Password reset link sent to ${email}. Check your inbox.`;
  } catch (err) {
    errorBox.textContent = friendlyError(err);
  }
});

$("registerForm")?.addEventListener("submit",async e=>{
  e.preventDefault();errorBox.textContent="";
  const form=e.target,
    usernameRaw=$("username")?.value.trim()||"",
    password=$("password").value,
    confirm=$("confirmPassword").value,
    name=$("name").value.trim(),
    email=$("email").value.trim().toLowerCase();

  const usernameCheck = validateUsername(usernameRaw);
  if (!usernameCheck.ok) { errorBox.textContent = usernameCheck.msg; return; }
  if (!name) { errorBox.textContent = "Please enter your name."; return; }
  if (password !== confirm) { errorBox.textContent = "Passwords do not match."; return; }

  setBusy(form,true);
  try{
    // Reserve the CUNNACT ID before creating the account so people don't
    // end up with an account and no chance at the handle they typed.
    const existing = await getDoc(doc(db,"usernames",usernameCheck.candidate));
    if (existing.exists()) { errorBox.textContent = "That CUNNACT ID is already taken. Try another."; setBusy(form,false); return; }

    const credential = await createUserWithEmailAndPassword(auth,email,password);
    await updateProfile(credential.user,{displayName:name});
    await setDoc(doc(db,"users",credential.user.uid),{uid:credential.user.uid,name,email,emailLower:email,photoURL:"",bio:"",createdAt:serverTimestamp(),lastSeen:serverTimestamp(),isOnline:true,lastHeartbeat:serverTimestamp()});
    await setDoc(doc(db,"userSettings",credential.user.uid),{retentionMode:"24hours",theme:localStorage.getItem("cunnact_theme")||"light",soundEnabled:localStorage.getItem("cunnact_sound_enabled")!=="false",createdAt:serverTimestamp()});

    try {
      await claimChosenUsername(credential.user.uid, usernameCheck.candidate, name);
    } catch (claimErr) {
      // Someone else grabbed it in the split second between our check and
      // the transaction. The account still exists \u2014 they can pick another
      // CUNNACT ID from Profile settings instead of losing the account.
      console.warn("Username claim race:", claimErr);
    }

    try { await sendEmailVerification(credential.user); } catch (verifyErr) { console.warn("Could not send verification email", verifyErr); }

    location.href="index.html";
  }catch(err){
    console.error("Registration failed",err);
    errorBox.textContent=friendlyError(err);
    setBusy(form,false);
  }
});
