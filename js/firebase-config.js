import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { getStorage } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-storage.js";

const firebaseConfig = {
  apiKey: "AIzaSyA_dapCcAP9w_66FacMlRns1NTwxZ-_wTQ",
  authDomain: "cunnact.firebaseapp.com",
  projectId: "cunnact",
  storageBucket: "cunnact.firebasestorage.app",
  messagingSenderId: "179918248368",
  appId: "1:179918248368:web:a188f5aafc096043a75e75",
  measurementId: "G-W7B6GVV3D9"
};

const app = initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);
export { app };