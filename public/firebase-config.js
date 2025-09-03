// Trage hier deine Werte aus der Firebase‑Konsole ein
// Beispiel:
// public/firebase-config.js
window.firebaseConfig = {
  apiKey: "AIzaSyA_C8_WCaw7I7E9FRCQLHIhjd2RRppaFo4",
  authDomain: "hochzeits-memory-prod.firebaseapp.com",
  projectId: "hochzeits-memory-prod",
  storageBucket: "hochzeits-memory-prod.appspot.com",  // ✅ korrigiert
  messagingSenderId: "900383167774",
  appId: "1:900383167774:web:7b40c77dc3b24b69f4650f"
};



// Fail‑safe: Blockiere App, wenn Config fehlt
if (!window.firebase || !firebase.apps || firebase.apps.length === 0) {
  console.warn("Bitte Firebase‑Konfiguration in public/firebase-config.js eintragen.");
}
