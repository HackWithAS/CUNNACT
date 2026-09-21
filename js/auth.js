import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, updateProfile } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getFirestore, doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const errorBox = document.getElementById("authError");
const friendlyError = (error) => {
  const map = {
    "auth/invalid-credential":"Invalid email or password.",
    "auth/email-already-in-use":"This email is already registered.",
    "auth/weak-password":"Password should be at least 6 characters.",
    "auth/invalid-email":"Please enter a valid email."
  };
  return map[error.code] || "Something went wrong. Please try again.";
};

onAuthStateChanged(auth, user => {
  if (user && (location.pathname.endsWith("login.html") || location.pathname.endsWith("register.html"))) {
    location.href = "index.html";
  }
});

document.getElementById("loginForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.textContent = "";
  try {
    await signInWithEmailAndPassword(auth, email.value.trim(), password.value);
    location.href = "index.html";
  } catch (error) { errorBox.textContent = friendlyError(error); }
});

document.getElementById("registerForm")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  errorBox.textContent = "";
  if (password.value !== confirmPassword.value) {
    errorBox.textContent = "Passwords do not match.";
    return;
  }
  try {
    const credential = await createUserWithEmailAndPassword(auth, email.value.trim(), password.value);
    await updateProfile(credential.user, { displayName: name.value.trim() });
    await setDoc(doc(db, "users", credential.user.uid), {
      uid: credential.user.uid,
      name: name.value.trim(),
      email: email.value.trim(),
      photoURL: "",
      bio: "",
      createdAt: serverTimestamp(),
      lastSeen: serverTimestamp(),
      isOnline: true
    });
    location.href = "index.html";
  } catch (error) { errorBox.textContent = friendlyError(error); }
});

export { auth, db };
