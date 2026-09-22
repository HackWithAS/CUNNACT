// One place that initialises Firebase and re-exports what the rest of the app needs.
// Same CDN modules and SDK version as before, same Auth + Firestore architecture.
// Firebase Storage is not imported anywhere — Cloudinary replaces it (see cloudinary.js).

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, updateProfile
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, addDoc, collection,
  query, where, orderBy, limit, onSnapshot, serverTimestamp, increment
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

export {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, updateProfile,
  doc, getDoc, getDocs, setDoc, updateDoc, addDoc, collection,
  query, where, orderBy, limit, onSnapshot, serverTimestamp, increment
};
