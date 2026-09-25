// CUNNACT Firebase bootstrap + shared Firestore/Auth exports.
// Cloudinary is used for images; Firebase Storage is intentionally not used.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, updateProfile,
  sendEmailVerification, reload, sendPasswordResetEmail,
  GoogleAuthProvider, signInWithPopup, reauthenticateWithPopup, reauthenticateWithCredential,
  EmailAuthProvider, linkWithCredential, PhoneAuthProvider, PhoneMultiFactorGenerator,
  RecaptchaVerifier, multiFactor, getMultiFactorResolver
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-functions.js";
import {
  getFirestore,
  doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc,
  collection, query, where, orderBy, startAt, endAt, limit,
  onSnapshot, serverTimestamp, increment, writeBatch, runTransaction, arrayUnion, arrayRemove
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
export const functions = getFunctions(app);

export {
  onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, updateProfile, sendEmailVerification, reload, sendPasswordResetEmail,
  GoogleAuthProvider, signInWithPopup, reauthenticateWithPopup, reauthenticateWithCredential,
  EmailAuthProvider, linkWithCredential, PhoneAuthProvider, PhoneMultiFactorGenerator,
  RecaptchaVerifier, multiFactor, getMultiFactorResolver,
  httpsCallable,
  doc, getDoc, getDocs, setDoc, updateDoc, addDoc, deleteDoc,
  collection, query, where, orderBy, startAt, endAt, limit,
  onSnapshot, serverTimestamp, increment, writeBatch, runTransaction, arrayUnion, arrayRemove
};
