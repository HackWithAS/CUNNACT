import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, updateProfile,
  sendEmailVerification, sendPasswordResetEmail,
  GoogleAuthProvider, signInWithPopup, EmailAuthProvider, linkWithCredential, getMultiFactorResolver,
  PhoneAuthProvider, PhoneMultiFactorGenerator, RecaptchaVerifier, multiFactor,
  doc, getDoc, setDoc, serverTimestamp, runTransaction
} from "./firebase.js";
import { $ } from "./ui.js";

const errorBox = $("authError");
let mfaResolver = null;
let mfaRecaptcha = null;
let mfaVerificationId = null;
const FRIENDLY_ERRORS = {
  "auth/invalid-credential":"Invalid email or password.",
  "auth/user-not-found":"Invalid email or password.",
  "auth/wrong-password":"Invalid email or password.",
  "auth/email-already-in-use":"This email is already registered.",
  "auth/weak-password":"Password should be at least 6 characters.",
  "auth/invalid-email":"Please enter a valid email.",
  "auth/too-many-requests":"Too many attempts. Please wait a moment and try again.",
  "auth/network-request-failed":"Network error. Check your connection and try again.",
  "auth/invalid-action-code":"That sign-in link is invalid or has expired. Please request a new one.",
  "auth/popup-closed-by-user":"Sign-in window was closed before finishing.",
  "auth/account-exists-with-different-credential":"That email is already registered a different way. Try the existing sign-in method for this account.",
  "auth/operation-not-allowed":"This sign-in method is not enabled in Firebase yet.",
  "auth/unauthorized-domain":"This website domain is not authorized in Firebase Authentication.",
  "auth/user-disabled":"This account has been disabled.",
  "auth/requires-recent-login":"Please sign in again and retry this action."
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
    tx.set(doc(db,"publicProfiles",uid),{uid,username:candidate,usernameLower:candidate,displayName:name,displayNameLower:String(name||"").toLowerCase(),profileVisibility:"public",discoverable:true,photoURL:"",bio:"",updatedAt:serverTimestamp()},{merge:true});
  });
}

function setBusy(form,busy){const btn=form.querySelector('button[type="submit"]');btn.disabled=busy;btn.dataset.label ||= btn.textContent;btn.textContent=busy?"Please wait…":btn.dataset.label;}
const friendlyError = e => FRIENDLY_ERRORS[e?.code] || "Something went wrong. Please try again.";
function setAuthMessage(text, isError = true) {
  if (!errorBox) return;
  errorBox.textContent = text || "";
  errorBox.style.color = isError ? "" : "var(--online, #16A34A)";
}

// --- Deciding what to do with a signed-in user who's sitting on login/register ---
function showCompleteProfile(user) {
  const box = $("completeProfileBox");
  if (!box) { location.href = "index.html"; return; }
  $("loginForm")?.setAttribute("hidden", "");
  document.querySelectorAll(".auth-card > .switch, .or-divider").forEach(el => el.setAttribute("hidden", ""));
  $("googleSignInBtn")?.setAttribute("hidden", "");
  box.hidden = false;
  const nameField = $("completeName");
  if (nameField && !nameField.value) nameField.value = user.displayName || "";
  // Google accounts may not have a password yet — offer to set one.
  const hasPassword = (user.providerData || []).some(p => p.providerId === "password");
  const pwBox = $("completePasswordFields");
  if (pwBox) pwBox.hidden = hasPassword;
}

onAuthStateChanged(auth, async (user) => {
  if (!user) return;
  if (!(location.pathname.endsWith("login.html") || location.pathname.endsWith("register.html"))) return;
  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    if (snap.exists() && snap.data()?.username) { location.href = "index.html"; return; }
  } catch (e) { console.warn("Profile lookup failed, showing setup just in case.", e); }
  showCompleteProfile(user);
});


async function startMfaChallenge(error){
  mfaResolver=getMultiFactorResolver(auth,error);
  const hint=mfaResolver?.hints?.[0];
  if(!hint){setAuthMessage("Two-step verification is required, but no usable second factor is enrolled.");return;}
  const modal=$("mfaLoginModal");if(!modal){setAuthMessage("Two-step verification is enabled on this account. Update the login page to enter the verification code.");return;}
  modal.hidden=false;document.body.classList.add("modal-open");
  $("mfaHint").textContent=hint.phoneNumber?`Code will be sent to ${hint.phoneNumber}`:"Enter your verification code.";
  try{mfaRecaptcha?.clear();}catch{};mfaRecaptcha=new RecaptchaVerifier(auth,"loginMfaRecaptcha",{size:"normal"});
  mfaVerificationId=await new PhoneAuthProvider(auth).verifyPhoneNumber({multiFactorHint:hint,session:mfaResolver.session},mfaRecaptcha);
  $("mfaCodeInput")?.focus();
}
async function finishMfaChallenge(){
  const code=$("mfaCodeInput")?.value.trim();if(!mfaResolver||!mfaVerificationId||!/^\d{6}$/.test(code)){setAuthMessage("Enter the 6-digit verification code.");return;}
  try{const cred=PhoneAuthProvider.credential(mfaVerificationId,code);const assertion=PhoneMultiFactorGenerator.assertion(cred);await mfaResolver.resolveSignIn(assertion);$("mfaLoginModal").hidden=true;document.body.classList.remove("modal-open");location.href="index.html";}catch(e){console.error("MFA challenge failed",e);setAuthMessage(e?.code==="auth/invalid-verification-code"?"Incorrect verification code.":"Could not verify the code. Try again.");}
}
$("mfaVerifyBtn")?.addEventListener("click",finishMfaChallenge);
$("mfaCodeInput")?.addEventListener("keydown",e=>{if(e.key==="Enter")finishMfaChallenge();if(e.key==="Escape"){$("mfaLoginModal").hidden=true;document.body.classList.remove("modal-open");}});

$("loginForm")?.addEventListener("submit",async e=>{
  e.preventDefault();setAuthMessage("");const form=e.target;setBusy(form,true);
  try{ await signInWithEmailAndPassword(auth,$("email").value.trim(),$("password").value); location.href="index.html"; }
  catch(err){ if(err?.code==="auth/multi-factor-auth-required"){ try{await startMfaChallenge(err);}catch(mfaErr){console.error(mfaErr);setAuthMessage("Could not start two-step verification.");setBusy(form,false);} return; } setAuthMessage(friendlyError(err)); setBusy(form,false); }
});

$("forgotPasswordLink")?.addEventListener("click", async (e) => {
  e.preventDefault();
  setAuthMessage("");
  const email = $("email")?.value.trim();
  if (!email) { setAuthMessage("Enter your email above first, then tap \u201cForgot password?\u201d."); return; }
  try {
    await sendPasswordResetEmail(auth, email);
    setAuthMessage(`Password reset link sent to ${email}. Check your inbox (and Spam/Promotions).`, false);
  } catch (err) {
    setAuthMessage(friendlyError(err));
  }
});

$("googleSignInBtn")?.addEventListener("click", async () => {
  setAuthMessage("");
  const btn = $("googleSignInBtn"); btn.disabled = true;
  try {
    const provider = new GoogleAuthProvider();
    await signInWithPopup(auth, provider);
    // onAuthStateChanged above takes it from here — straight in if the
    // CUNNACT ID already exists, or the "finish setup" box if it's new.
    // Google accounts are inherently email-verified, so no extra step there.
  } catch (err) {
    if (err?.code === "auth/multi-factor-auth-required") {
      try { await startMfaChallenge(err); }
      catch (mfaErr) { console.error("Google MFA challenge failed", mfaErr); setAuthMessage("Could not start two-step verification."); }
      return;
    }
    if (err?.code !== "auth/popup-closed-by-user") console.error("Google sign-in failed", err);
    setAuthMessage(friendlyError(err));
  } finally {
    btn.disabled = false;
  }
});

$("completeProfileBtn")?.addEventListener("click", async () => {
  const errBox = $("completeProfileError");
  errBox.textContent = "";
  const usernameCheck = validateUsername($("completeUsername")?.value.trim() || "");
  const name = $("completeName")?.value.trim() || "";
  if (!usernameCheck.ok) { errBox.textContent = usernameCheck.msg; return; }
  if (!name) { errBox.textContent = "Please enter your name."; return; }
  const user = auth.currentUser;
  if (!user) { errBox.textContent = "Session expired. Please sign in again."; return; }
  const btn = $("completeProfileBtn"); btn.disabled = true; btn.textContent = "Please wait…";
  try {
    const existing = await getDoc(doc(db, "usernames", usernameCheck.candidate));
    if (existing.exists() && existing.data()?.uid !== user.uid) {
      errBox.textContent = "That CUNNACT ID is already taken. Try another.";
      btn.disabled = false; btn.textContent = "Finish setup"; return;
    }
    await updateProfile(user, { displayName: name });
    const email = (user.email || "").toLowerCase();
    await setDoc(doc(db, "users", user.uid), {
      uid: user.uid, name, email, emailLower: email, photoURL: "", bio: "",
      createdAt: serverTimestamp(), lastSeen: serverTimestamp(), isOnline: true, lastHeartbeat: serverTimestamp()
    }, { merge: true });
    await setDoc(doc(db, "userSettings", user.uid), {
      retentionMode: "24hours",
      theme: localStorage.getItem("cunnact_theme") || ((window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) ? "dark" : "light"),
      soundEnabled: localStorage.getItem("cunnact_sound_enabled") !== "false",
      createdAt: serverTimestamp()
    }, { merge: true });
    await claimChosenUsername(user.uid, usernameCheck.candidate, name);

    const newPassword = $("completePassword")?.value || "";
    if (newPassword && user.email) {
      if (newPassword.length < 6) {
        errBox.textContent = "Password should be at least 6 characters — you can also skip it and set one later from Profile.";
        btn.disabled = false; btn.textContent = "Finish setup"; return;
      }
      try {
        await linkWithCredential(user, EmailAuthProvider.credential(user.email, newPassword));
      } catch (linkErr) {
        console.warn("Could not set password, continuing without it", linkErr);
        // Not fatal — the account still works fine via Google / email link.
      }
    }

    location.href = "index.html";
  } catch (e) {
    console.error("Complete profile failed", e);
    errBox.textContent = e?.message === "USERNAME_TAKEN" ? "That CUNNACT ID was just taken. Try another." : "Something went wrong. Please try again.";
    btn.disabled = false; btn.textContent = "Finish setup";
  }
});

$("registerForm")?.addEventListener("submit",async e=>{
  e.preventDefault();setAuthMessage("");
  const form=e.target,
    usernameRaw=$("username")?.value.trim()||"",
    password=$("password").value,
    confirm=$("confirmPassword").value,
    name=$("name").value.trim(),
    email=$("email").value.trim().toLowerCase();

  const usernameCheck = validateUsername(usernameRaw);
  if (!usernameCheck.ok) { setAuthMessage(usernameCheck.msg); return; }
  if (!name) { setAuthMessage("Please enter your name."); return; }
  if (password !== confirm) { setAuthMessage("Passwords do not match."); return; }

  setBusy(form,true);
  try{
    // Reserve the CUNNACT ID before creating the account so people don't
    // end up with an account and no chance at the handle they typed.
    const existing = await getDoc(doc(db,"usernames",usernameCheck.candidate));
    if (existing.exists()) { setAuthMessage("That CUNNACT ID is already taken. Try another."); setBusy(form,false); return; }

    const credential = await createUserWithEmailAndPassword(auth,email,password);
    await updateProfile(credential.user,{displayName:name});
    await setDoc(doc(db,"users",credential.user.uid),{uid:credential.user.uid,name,email,emailLower:email,photoURL:"",bio:"",createdAt:serverTimestamp(),lastSeen:serverTimestamp(),isOnline:true,lastHeartbeat:serverTimestamp()});
    await setDoc(doc(db,"userSettings",credential.user.uid),{retentionMode:"24hours",theme:localStorage.getItem("cunnact_theme")||((window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)?"dark":"light"),soundEnabled:localStorage.getItem("cunnact_sound_enabled")!=="false",createdAt:serverTimestamp()});

    try {
      await claimChosenUsername(credential.user.uid, usernameCheck.candidate, name);
    } catch (claimErr) {
      // Someone else grabbed it in the split second between our check and
      // the transaction. The account still exists — they can pick another
      // CUNNACT ID from Profile settings instead of losing the account.
      console.warn("Username claim race:", claimErr);
    }

    try { await sendEmailVerification(credential.user); } catch (verifyErr) { console.warn("Could not send verification email", verifyErr); }

    location.href="index.html";
  }catch(err){
    console.error("Registration failed",err);
    setAuthMessage(friendlyError(err));
    setBusy(form,false);
  }
});
