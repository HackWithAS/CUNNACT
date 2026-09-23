import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, updateProfile,
  sendEmailVerification, sendPasswordResetEmail,
  sendSignInLinkToEmail, isSignInWithEmailLink, signInWithEmailLink,
  GoogleAuthProvider, signInWithPopup, EmailAuthProvider, linkWithCredential,
  doc, getDoc, setDoc, serverTimestamp, runTransaction
} from "./firebase.js";
import { $ } from "./ui.js";

const errorBox = $("authError");
const EMAIL_LINK_STORAGE_KEY = "cunnact_email_for_link";
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
  "auth/account-exists-with-different-credential":"That email is already registered a different way. Try logging in with email/password instead."
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
function setAuthMessage(text, isError = true) {
  if (!errorBox) return;
  errorBox.textContent = text || "";
  errorBox.style.color = isError ? "" : "var(--online, #16A34A)";
}

// --- Finishing an email-link sign-in (person tapped the link in their inbox) ---
async function completeEmailLinkSignInIfNeeded() {
  if (!isSignInWithEmailLink(auth, window.location.href)) return;
  let email = localStorage.getItem(EMAIL_LINK_STORAGE_KEY);
  if (!email) email = window.prompt("Confirm the email you used to request the link:");
  if (!email) return;
  try {
    await signInWithEmailLink(auth, email, window.location.href);
    localStorage.removeItem(EMAIL_LINK_STORAGE_KEY);
    history.replaceState(null, "", location.pathname);
    // onAuthStateChanged below picks this up and either sends the person
    // straight in, or shows the "finish setup" box for a brand-new account.
  } catch (err) {
    console.error("Email link sign-in failed", err);
    setAuthMessage(friendlyError(err));
  }
}
completeEmailLinkSignInIfNeeded();

// --- Deciding what to do with a signed-in user who's sitting on login/register ---
function showCompleteProfile(user) {
  const box = $("completeProfileBox");
  if (!box) { location.href = "index.html"; return; }
  $("loginForm")?.setAttribute("hidden", "");
  document.querySelectorAll(".auth-card > .switch, .or-divider").forEach(el => el.setAttribute("hidden", ""));
  $("emailLinkBtn")?.setAttribute("hidden", "");
  $("googleSignInBtn")?.setAttribute("hidden", "");
  box.hidden = false;
  const nameField = $("completeName");
  if (nameField && !nameField.value) nameField.value = user.displayName || "";
  // Google / email-link accounts have no password yet — offer to set one.
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

$("loginForm")?.addEventListener("submit",async e=>{
  e.preventDefault();setAuthMessage("");const form=e.target;setBusy(form,true);
  try{ await signInWithEmailAndPassword(auth,$("email").value.trim(),$("password").value); location.href="index.html"; }
  catch(err){ setAuthMessage(friendlyError(err)); setBusy(form,false); }
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
    if (err?.code !== "auth/popup-closed-by-user") console.error("Google sign-in failed", err);
    setAuthMessage(friendlyError(err));
  } finally {
    btn.disabled = false;
  }
});

$("emailLinkBtn")?.addEventListener("click", async () => {
  setAuthMessage("");
  const email = $("email")?.value.trim();
  if (!email) { setAuthMessage("Enter your email above first, then tap this button."); return; }
  const btn = $("emailLinkBtn"); const label = btn.dataset.label ||= btn.textContent;
  btn.disabled = true; btn.textContent = "Sending…";
  try {
    const actionCodeSettings = { url: `${location.origin}/login.html`, handleCodeInApp: true };
    await sendSignInLinkToEmail(auth, email, actionCodeSettings);
    localStorage.setItem(EMAIL_LINK_STORAGE_KEY, email);
    setAuthMessage(`Sign-in link sent to ${email} — open it on this device. Check Spam/Promotions if it doesn't show up in a few minutes.`, false);
  } catch (err) {
    setAuthMessage(friendlyError(err));
  } finally {
    btn.disabled = false; btn.textContent = label;
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
      theme: localStorage.getItem("cunnact_theme") || "light",
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
    await setDoc(doc(db,"userSettings",credential.user.uid),{retentionMode:"24hours",theme:localStorage.getItem("cunnact_theme")||"light",soundEnabled:localStorage.getItem("cunnact_sound_enabled")!=="false",createdAt:serverTimestamp()});

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
