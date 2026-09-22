import { auth, db, doc, getDoc, getDocs, collection, query, where, limit, onAuthStateChanged } from "./firebase.js";
import { paintAvatar } from "./avatar.js";
import { showToast } from "./toast.js";

const state = document.getElementById("publicState");
const pathParts = location.pathname.split("/").filter(Boolean);
const pathUsername = pathParts[0] === "u" ? pathParts[1] || "" : (pathParts.at(-1) || "");
const queryUsername = new URLSearchParams(location.search).get("username") || "";
const username = decodeURIComponent(queryUsername || pathUsername).replace(/^@+/, "").trim().toLowerCase();

let loadedProfile = null;
let currentUser = auth.currentUser || null;

function escapeHtml(value = "") {
  return String(value).replace(/[&<>\"]/g, c => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;"
  }[c]));
}

function publicLink(profile) {
  return `${location.origin}/u/${encodeURIComponent(profile.usernameLower || profile.username || username)}`;
}

function setPrimaryAction(profile) {
  const primary = document.getElementById("publicPrimary");
  if (!primary) return;

  if (currentUser?.uid === profile.uid) {
    primary.textContent = "Edit Profile";
    primary.onclick = () => { location.href = "/profile.html"; };
    return;
  }

  if (currentUser) {
    primary.textContent = "Open CUNNACT";
    primary.onclick = () => {
      location.href = `/index.html?newChat=${encodeURIComponent(profile.usernameLower || profile.username)}`;
    };
    return;
  }

  primary.textContent = "Login to message";
  primary.onclick = () => { location.href = "/login.html"; };
}

function render(profile) {
  loadedProfile = profile;

  if (!profile) {
    state.innerHTML = `
      <div class="public-state">
        <h2>CUNNACT ID not found</h2>
        <p>This profile does not exist or is not public yet.</p>
        <a class="btn btn-primary" href="/login.html">Go to CUNNACT</a>
      </div>`;
    return;
  }

  const safeName = profile.displayName || "CUNNACT user";
  const publicUsername = profile.usernameLower || profile.username || username;
  state.innerHTML = `
    <div class="avatar public-user-avatar"><img alt="" hidden><span class="avatar-fallback" hidden></span></div>
    <h1 class="public-name"></h1>
    <div class="public-username">@${escapeHtml(publicUsername)}</div>
    <p class="public-bio">${escapeHtml(profile.bio || "")}</p>
    <div class="public-actions">
      <button id="publicPrimary" class="btn btn-primary" type="button"></button>
      <button id="copyPublicId" class="btn btn-soft" type="button">Copy CUNNACT ID</button>
      <button id="sharePublicProfile" class="btn btn-soft" type="button">Share Profile</button>
    </div>
    <p class="public-private-note">Only public profile information is shown here. Your email and private settings stay private.</p>`;

  state.querySelector(".public-name").textContent = safeName;
  paintAvatar(state.querySelector(".avatar"), {
    photoURL: profile.photoURL || "",
    name: safeName,
    email: "",
    preset: "avatarXl"
  });

  setPrimaryAction(profile);

  document.getElementById("copyPublicId")?.addEventListener("click", async () => {
    const id = `@${publicUsername}`;
    try {
      await navigator.clipboard.writeText(id);
      showToast("CUNNACT ID copied ✓", "success");
    } catch {
      showToast(id, "info");
    }
  });

  document.getElementById("sharePublicProfile")?.addEventListener("click", async () => {
    const url = publicLink(profile);
    const text = `Connect with me on CUNNACT:\n@${publicUsername}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "CUNNACT Profile", text, url });
      } else {
        await navigator.clipboard.writeText(`${text}\n${url}`);
        showToast("Profile link copied ✓", "success");
      }
    } catch (error) {
      if (error?.name !== "AbortError") showToast("Could not share profile.", "error");
    }
  });
}

async function resolveProfile() {
  if (!username || username.length < 5) {
    render(null);
    return;
  }

  state.innerHTML = '<div class="public-state"><span class="spinner-ring"></span><p>Loading profile…</p></div>';

  try {
    // Fast deterministic lookup for the shareable CUNNACT ID.
    const mapSnap = await getDoc(doc(db, "usernames", username));

    if (mapSnap.exists()) {
      const uid = mapSnap.data()?.uid;
      if (uid) {
        const profileSnap = await getDoc(doc(db, "publicProfiles", uid));
        if (profileSnap.exists()) {
          render(profileSnap.data());
          return;
        }
      }
    }

    // Backward-compatible fallback for profiles created before the username
    // mapping was written. This performs only an exact username lookup.
    const fallback = await getDocs(
      query(
        collection(db, "publicProfiles"),
        where("usernameLower", "==", username),
        limit(1)
      )
    );

    const first = fallback.docs[0];
    render(first?.exists ? first.data() : null);
  } catch (error) {
    console.error("Public profile load failed:", error);
    state.innerHTML = `
      <div class="public-state">
        <h2>Couldn't load profile</h2>
        <p>Please check your connection and try again.</p>
        <button id="retryPublicProfile" class="btn btn-primary" type="button">Try again</button>
      </div>`;
    document.getElementById("retryPublicProfile")?.addEventListener("click", resolveProfile);
  }
}


// Public profile must load independently of authentication. Authentication is
// only needed to change the action button from Login → Open CUNNACT/Edit.
resolveProfile();
onAuthStateChanged(auth, user => {
  currentUser = user || null;
  if (loadedProfile) setPrimaryAction(loadedProfile);
});
