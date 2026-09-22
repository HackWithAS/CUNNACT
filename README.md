# CUNNACT - Stay Connected

A modern, engaging, next-generation messaging experience with privacy-first features.

## 🎉 Comprehensive Upgrade Complete

CUNNACT has been transformed from a basic chat application into a polished, professional messaging product that users actually want to use.

## ✨ Key Features

### 🔐 Privacy First
- **Message Requests**: Users must accept before chatting
- **Ephemeral Messages**: Choose 24-hour or delete-after-seen
- **Saved Messages**: Bookmark important messages
- **Secure**: Strong Firestore security rules

### 🎵 Interactive Experience
- **Sound System**: Subtle UI sounds (Web Audio API)
- **Smooth Animations**: Every interaction feels alive
- **Message Actions**: Save, delete for me, delete for everyone with context menu
- **Real-time**: Instant message delivery

### 🎨 Modern Design
- **Original UI**: Not copied from other apps
- **Clean & Premium**: Professional design language
- **Responsive**: Perfect on all devices
- **Fast**: Vanilla JavaScript, no frameworks

### 🔍 Smart Search
- **6-Character Minimum**: Protects user privacy
- **Email Priority**: Find users by email
- **No Database Dump**: Only shows relevant results

## 📦 What's New in This Upgrade

### Core Features Added:
1. ✅ **Sound System** - Web Audio API tones, global toggle
2. ✅ **Message Requests** - Privacy-first conversation initiation
3. ✅ **Chat Retention** - 24-hour or after-seen expiration
4. ✅ **Saved Messages** - Bookmark with 🔖 icon
5. ✅ **Search Privacy** - 6-character minimum requirement
6. ✅ **Animations** - Smooth 120-300ms interactions
7. ✅ **Message Actions** - Right-click/long-press menu
8. ✅ **Profile UX** - Auto-navigation after save
9. ✅ **HackWithAS Branding** - Professional attribution

### Security Improvements:
- ✅ Source review checked for common suspicious browser-code patterns
- ✅ Updated Firestore rules for requests and saved messages
- ✅ XSS protection verified
- ✅ File upload validation strengthened

## 🚀 Quick Start

### Deploy Firestore Rules + Hosting
```bash
firebase deploy --only firestore:rules,hosting
```

### Test Locally
```bash
python -m http.server 8000
# Open http://localhost:8000
```

### Deploy to Production
```bash
vercel --prod
```

## 📚 Documentation

- **DEPLOYMENT_GUIDE.md** - Complete deployment instructions
- **UPGRADE_SUMMARY.md** - Detailed feature list
- **firestore.rules** - Updated security rules

## 🔧 Tech Stack

- **Frontend**: Vanilla JavaScript, HTML5, CSS3
- **Backend**: Firebase (Auth + Firestore)
- **Storage**: Cloudinary (images)
- **Hosting**: Vercel
- **Animations**: CSS transitions + keyframes
- **Sound**: Web Audio API

## 🎯 Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+
- Mobile: iOS Safari 14+, Chrome Android 90+

## ⚠️ Important Notes

### Message Deletion
Current implementation uses **client-side cleanup**. Messages expire when:
- User opens app
- User refreshes
- User switches conversations
- Periodic cleanup (every 5 minutes)

For guaranteed server-side deletion, upgrade to Firebase Blaze plan and deploy Cloud Functions.

### Chrome "Dangerous Site" Warning
A source-code review cannot prove why Google Safe Browsing or a browser warning was triggered. Verify the live domain through Google Safe Browsing/Search Console and your hosting provider.

## 📄 License

Created by HackWithAS  
Website: https://hackwithas.in

## 🙏 Credits

Built with:
- Firebase by Google
- Cloudinary
- Google Fonts (Inter)
- Web Audio API

---

**CUNNACT** - Making messaging enjoyable again.


## V6 additions
- Shareable CUNNACT IDs and public profiles (`/u/:username`).
- Rebuilt profile UI.
- Correct avatar fallback behavior.
- Heartbeat-based presence UI.
- Typing indicator and message reactions.
