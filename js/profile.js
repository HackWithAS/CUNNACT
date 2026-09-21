import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth, onAuthStateChanged, updateProfile } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getFirestore, doc, getDoc, updateDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { getStorage, ref, uploadBytes, getDownloadURL } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-storage.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const storage = getStorage(app);

let currentUser;

onAuthStateChanged(auth, async user => {
  if (!user) { location.href = "login.html"; return; }
  currentUser = user;
  const snap = await getDoc(doc(db, "users", user.uid));
  const data = snap.exists() ? snap.data() : {};
  profileName.value = data.name || user.displayName || "";
  profileEmail.value = user.email || "";
  profileBio.value = data.bio || "";
  profilePhoto.src = data.photoURL || user.photoURL || "assets/images/avatar.svg";
});

photoInput.addEventListener("change", async () => {
  const file = photoInput.files[0];
  if (!file || !currentUser) return;
  if (!file.type.startsWith("image/") || file.size > 2 * 1024 * 1024) {
    profileMessage.textContent = "Choose an image under 2 MB.";
    return;
  }
  const storageRef = ref(storage, `profilePictures/${currentUser.uid}/${Date.now()}-${file.name}`);
  const snap = await uploadBytes(storageRef, file);
  const url = await getDownloadURL(snap.ref);
  await updateProfile(currentUser, { photoURL: url });
  await updateDoc(doc(db, "users", currentUser.uid), { photoURL: url, lastSeen: serverTimestamp() });
  profilePhoto.src = url;
  profileMessage.textContent = "Profile picture updated.";
});

profileForm.addEventListener("submit", async e => {
  e.preventDefault();
  try {
    await updateProfile(currentUser, { displayName: profileName.value.trim() });
    await updateDoc(doc(db, "users", currentUser.uid), {
      name: profileName.value.trim(),
      bio: profileBio.value.trim(),
      lastSeen: serverTimestamp()
    });
    profileMessage.textContent = "Profile saved.";
  } catch {
    profileMessage.textContent = "Could not save your profile.";
  }
});
