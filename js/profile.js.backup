import { auth, db, onAuthStateChanged, updateProfile, doc, getDoc, updateDoc, serverTimestamp } from "./firebase.js";
import { uploadImageToCloudinary, UploadError } from "./cloudinary.js";
import { paintAvatar } from "./avatar.js";
import { showToast } from "./toast.js";
import { $ } from "./ui.js";

let currentUser = null;
let currentPhotoURL = "";
let uploadController = null;

const avatarEl = $("profileAvatar");
const uploadBox = $("avatarUpload");
const uploadStatus = $("uploadStatus");
const progressFill = $("uploadProgressFill");
const bioInput = $("profileBio");
const bioCount = $("bioCount");
const profileMessage = $("profileMessage");

onAuthStateChanged(auth, async (user) => {
  if (!user) { location.href = "login.html"; return; }
  currentUser = user;
  const snap = await getDoc(doc(db, "users", user.uid));
  const data = snap.exists() ? snap.data() : {};
  const name = data.name || user.displayName || "";
  currentPhotoURL = data.photoURL || user.photoURL || "";

  $("profileName").value = name;
  $("profileEmail").value = user.email || "";
  bioInput.value = data.bio || "";
  bioCount.textContent = bioInput.value.length;
  paintAvatar(avatarEl, { photoURL: currentPhotoURL, name, email: user.email, preset: "avatarXl" });
});

bioInput.addEventListener("input", () => { bioCount.textContent = bioInput.value.length; });

$("changePhotoBtn").addEventListener("click", () => $("photoInput").click());

$("photoInput").addEventListener("change", async () => {
  const file = $("photoInput").files[0];
  $("photoInput").value = ""; // allow re-selecting the same file later
  if (!file || !currentUser) return;

  uploadController?.abort();
  uploadController = new AbortController();

  const previousPhotoURL = currentPhotoURL;
  const objectUrl = URL.createObjectURL(file);
  const img = avatarEl.querySelector("img");
  const fallback = avatarEl.querySelector(".avatar-fallback");
  img.src = objectUrl;
  img.hidden = false;
  fallback.hidden = true;

  uploadBox.classList.add("uploading");
  uploadStatus.textContent = "Uploading…";
  progressFill.style.width = "0%";

  try {
    const url = await uploadImageToCloudinary(file, {
      signal: uploadController.signal,
      onProgress: (p) => { progressFill.style.width = `${Math.round(p * 100)}%`; }
    });
    currentPhotoURL = url;
    await updateProfile(currentUser, { photoURL: url });
    await updateDoc(doc(db, "users", currentUser.uid), { photoURL: url, lastSeen: serverTimestamp() });
    uploadStatus.textContent = "Profile picture updated.";
    showToast("Profile picture updated.", "success");
  } catch (error) {
    if (error?.kind === "aborted") return;
    const message = error instanceof UploadError ? error.userMessage : "Couldn't upload image. Please try again.";
    uploadStatus.textContent = message;
    showToast(message, "error");
    paintAvatar(avatarEl, { photoURL: previousPhotoURL, name: $("profileName").value, email: currentUser.email, preset: "avatarXl" });
  } finally {
    URL.revokeObjectURL(objectUrl);
    uploadBox.classList.remove("uploading");
    setTimeout(() => { if (uploadStatus.textContent) uploadStatus.textContent = ""; }, 3000);
  }
});

$("profileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  profileMessage.className = "";
  const name = $("profileName").value.trim();
  if (!name) {
    profileMessage.textContent = "Name can't be empty.";
    profileMessage.className = "error";
    return;
  }
  try {
    await updateProfile(currentUser, { displayName: name });
    await updateDoc(doc(db, "users", currentUser.uid), {
      name,
      bio: bioInput.value.trim(),
      lastSeen: serverTimestamp()
    });
    profileMessage.textContent = "Profile saved.";
    profileMessage.className = "success";
  } catch {
    profileMessage.textContent = "Could not save your profile.";
    profileMessage.className = "error";
  }
});
