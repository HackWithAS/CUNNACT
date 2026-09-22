import {
  auth, db, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, updateProfile,
  doc, setDoc, serverTimestamp
} from "./firebase.js";
import { $ } from "./ui.js";

// NOTE: every field is looked up with getElementById, never as a bare identifier.
// An element with id="name" is NOT auto-exposed as `window.name` — that global
// already exists (it's the browser's window-name string), so `name.value` throws
// at runtime. That bug silently broke account registration; this file avoids it.

const errorBox = $("authError");

const FRIENDLY_ERRORS = {
  "auth/invalid-credential": "Invalid email or password.",
  "auth/user-not-found": "Invalid email or password.",
  "auth/wrong-password": "Invalid email or password.",
  "auth/email-already-in-use": "This email is already registered.",
  "auth/weak-password": "Password should be at least 6 characters.",
  "auth/invalid-email": "Please enter a valid email.",
  "auth/too-many-requests": "Too many attempts. Please wait a moment and try again.",
  "auth/network-request-failed": "Network error. Check your connection and try again."
};
const friendlyError = (error) => FRIENDLY_ERRORS[error.code] || "Something went wrong. Please try again.";

function setBusy(form, busy) {
  const btn = form.querySelector("button[type=submit]");
  btn.disabled = busy;
  btn.dataset.label ||= btn.textContent;
  btn.textContent = busy ? "Please wait…" : btn.dataset.label;
}

onAuthStateChanged(auth, (user) => {
  if (user && (location.pathname.endsWith("login.html") || location.pathname.endsWith("register.html"))) {
    location.href = "index.html";
  }
});

$("loginForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.textContent = "";
  const form = e.target;
  setBusy(form, true);
  try {
    await signInWithEmailAndPassword(auth, $("email").value.trim(), $("password").value);
    location.href = "index.html";
  } catch (error) {
    errorBox.textContent = friendlyError(error);
    setBusy(form, false);
  }
});

$("registerForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.textContent = "";
  const password = $("password").value;
  if (password !== $("confirmPassword").value) {
    errorBox.textContent = "Passwords do not match.";
    return;
  }
  const form = e.target;
  setBusy(form, true);
  try {
    const fullName = $("name").value.trim();
    const email = $("email").value.trim().toLowerCase();
    const credential = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(credential.user, { displayName: fullName });
    await setDoc(doc(db, "users", credential.user.uid), {
      uid: credential.user.uid,
      name: fullName,
      email,
      emailLower: email,
      photoURL: "",
      bio: "",
      createdAt: serverTimestamp(),
      lastSeen: serverTimestamp(),
      isOnline: true,
      retentionMode: "24hours"
    });
    location.href = "index.html";
  } catch (error) {
    errorBox.textContent = friendlyError(error);
    setBusy(form, false);
  }
});
