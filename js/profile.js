import { auth, db, onAuthStateChanged, updateProfile, doc, getDoc, updateDoc, serverTimestamp } from "./firebase.js";
import { uploadImageToCloudinary, UploadError } from "./cloudinary.js";
import { paintAvatar } from "./avatar.js";
import { showToast } from "./toast.js";
import { $ } from "./ui.js";
import { isSoundEnabled, setSoundEnabled, playClick, playSuccess } from "./sound.js";
import { getRetentionMode, loadRetentionMode, setRetentionMode } from "./retention.js";

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
const profileForm = $("profileForm");
const saveButton = profileForm?.querySelector('button[type="submit"]');

function setProfileStatus(text = "", type = "") {
  if (!profileMessage) return;
  profileMessage.textContent = text;
  profileMessage.className = type ? `profile-status ${type}` : "profile-status";
}

function updateBioCount() {
  if (bioCount && bioInput) bioCount.textContent = String(bioInput.value.length);
}

function openPhotoPicker() {
  playClick();
  $("photoInput")?.click();
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    location.replace("login.html");
    return;
  }

  currentUser = user;
  setProfileStatus("Loading profile…");

  try {
    const snap = await getDoc(doc(db, "users", user.uid));
    const data = snap.exists() ? snap.data() : {};
    const name = data.name || user.displayName || "";
    currentPhotoURL = data.photoURL || user.photoURL || "";

    $("profileName").value = name;
    $("profileEmail").value = user.email || data.email || "";
    bioInput.value = data.bio || "";
    updateBioCount();

    paintAvatar(avatarEl, {
      photoURL: currentPhotoURL,
      name,
      email: user.email,
      preset: "avatarXl"
    });

    const retention = await loadRetentionMode(user.uid);
    const radio = document.querySelector(`input[name="retention"][value="${retention}"]`);
    if (radio) radio.checked = true;
    $("soundToggle").checked = isSoundEnabled();

    setProfileStatus();
  } catch (error) {
    console.error("Profile load error:", error);
    setProfileStatus("Could not load your profile. Please refresh.", "error");
  }
});

bioInput?.addEventListener("input", updateBioCount);

$("changePhotoBtn")?.addEventListener("click", openPhotoPicker);
$("avatarButton")?.addEventListener("click", openPhotoPicker);

$("photoInput")?.addEventListener("change", async () => {
  const file = $("photoInput").files?.[0];
  $("photoInput").value = "";
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
  uploadStatus.textContent = "Uploading photo…";
  progressFill.style.width = "0%";

  try {
    const url = await uploadImageToCloudinary(file, {
      signal: uploadController.signal,
      onProgress: (progress) => {
        progressFill.style.width = `${Math.round(progress * 100)}%`;
      }
    });

    currentPhotoURL = url;
    await updateProfile(currentUser, { photoURL: url });
    await updateDoc(doc(db, "users", currentUser.uid), {
      photoURL: url,
      lastSeen: serverTimestamp()
    });

    uploadStatus.textContent = "Profile photo updated ✓";
    playSuccess();
    showToast("Profile photo updated.", "success");
  } catch (error) {
    if (error?.kind === "aborted") return;
    const message = error instanceof UploadError
      ? error.userMessage
      : "Couldn't upload image. Please try again.";

    uploadStatus.textContent = message;
    showToast(message, "error");
    paintAvatar(avatarEl, {
      photoURL: previousPhotoURL,
      name: $("profileName").value,
      email: currentUser.email,
      preset: "avatarXl"
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
    uploadBox.classList.remove("uploading");
    setTimeout(() => {
      uploadStatus.textContent = "";
      progressFill.style.width = "0%";
    }, 2800);
  }
});

$("backToChat")?.addEventListener("click", () => {
  playClick();
  location.href = "index.html";
});

$("soundToggle")?.addEventListener("change", (event) => {
  const enabled = event.target.checked;
  setSoundEnabled(enabled);
  if (enabled) playClick();
  showToast(enabled ? "Sound effects on" : "Sound effects off", "success");
});

document.querySelectorAll('input[name="retention"]').forEach((radio) => {
  radio.addEventListener("change", async (event) => {
    playClick();
    if (!currentUser) return;

    try {
      await setRetentionMode(event.target.value, currentUser.uid);
      showToast(
        event.target.value === "seen" ? "Messages will delete after seen" : "Messages will delete after 24 hours",
        "success"
      );
    } catch (error) {
      console.error("Retention setting error:", error);
      showToast("Could not save retention setting", "error");
    }
  });
});

profileForm?.addEventListener("submit", async (event) => {
  event.preventDefault();
  playClick();
  setProfileStatus();

  if (!currentUser) return;

  const name = $("profileName").value.trim();
  if (!name) {
    setProfileStatus("Please enter your name.", "error");
    $("profileName")?.focus();
    return;
  }

  const originalText = saveButton.textContent;
  saveButton.disabled = true;
  saveButton.textContent = "Saving…";

  try {
    await updateProfile(currentUser, { displayName: name });
    await updateDoc(doc(db, "users", currentUser.uid), {
      name,
      email: currentUser.email || "",
      emailLower: String(currentUser.email || "").toLowerCase(),
      bio: bioInput.value.trim(),
      retentionMode: getRetentionMode(),
      lastSeen: serverTimestamp()
    });

    setProfileStatus("Changes saved", "success");
    playSuccess();
    showToast("Profile updated ✓", "success");
  } catch (error) {
    console.error("Profile save error:", error);
    setProfileStatus("Could not save your profile. Please try again.", "error");
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = originalText;
  }
});
