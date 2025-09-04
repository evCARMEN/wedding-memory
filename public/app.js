/* global React, ReactDOM, firebase, PDFLib, QRCode */

const { useState, useEffect, useMemo, useRef } = React;

// Init Firebase (from global config)
const app = firebase.apps.length ? firebase.app() : firebase.initializeApp(firebaseConfig || {});
const db = firebase.firestore();
const storage = firebase.storage();
const auth = firebase.auth();
const functions = firebase.functions();

// Anonymous sign-in
auth.onAuthStateChanged(u => { if (!u) auth.signInAnonymously().catch(console.error); });

// Helpers
const randomId = (len=6) => Array.from(crypto.getRandomValues(new Uint8Array(len))).map(n => (n%36).toString(36)).join('');
async function sha256(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

// --- Memory Logic ---
function useMemoryDeck(images) {
  // limit to 8 pairs (16 cards)
  const selected = useMemo(() => {
    const pool = images.slice(0); // copy
    // shuffle
    for (let i=pool.length-1;i>0;i--) { const j = Math.floor(Math.random()*(i+1)); [pool[i],pool[j]] = [pool[j],pool[i]]; }
    return pool.slice(0, 8);
  }, [images.map(i=>i.imageUrl).join('|')]);

  const deck = useMemo(() => {
    const pairs = selected.flatMap(img => ([
      { id: randomId(8), key: img.id, url: img.imageUrl },
      { id: randomId(8), key: img.id, url: img.imageUrl },
    ]));
    // shuffle
    for (let i=pairs.length-1;i>0;i--) { const j = Math.floor(Math.random()*(i+1)); [pairs[i],pairs[j]] = [pairs[j],pairs[i]]; }
    return pairs;
  }, [selected]);

  return deck;
}

function MemoryGame({ eventId, onFinished }) {
  const [images, setImages] = useState([]);
  const [deck, setDeck] = useState([]);
  const [flipped, setFlipped] = useState([]); // ids
  const [matched, setMatched] = useState(new Set());
  const [running, setRunning] = useState(false);
  const [ms, setMs] = useState(0);
  const timerRef = useRef(null);

  useEffect(() => {
    const unsub = db.collection('events').doc(eventId).collection('cardImages')
      .orderBy('createdAt', 'desc')
      .onSnapshot(snap => {
        const arr = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        setImages(arr);
      });
    return () => unsub();
  }, [eventId]);

  useEffect(() => {
    const d = useMemoryDeck(images);
    setDeck(d);
    setFlipped([]); setMatched(new Set()); setMs(0); setRunning(false);
    if (timerRef.current) clearInterval(timerRef.current);
  }, [images.map(i=>i.imageUrl).join('|')]);

  useEffect(() => {
    if (running) {
      timerRef.current = setInterval(() => setMs(m => m + 100), 100);
    }
    return () => timerRef.current && clearInterval(timerRef.current);
  }, [running]);

  function flip(card) {
    if (!running) setRunning(true);
    if (matched.has(card.key)) return;
    if (flipped.find(f => f.id === card.id)) return;
    if (flipped.length === 2) return;

    const next = [...flipped, card];
    setFlipped(next);

    if (next.length === 2) {
      const [a, b] = next;
      if (a.key === b.key) {
        // match
        const nm = new Set(matched);
        nm.add(a.key);
        setTimeout(() => {
          setMatched(nm);
          setFlipped([]);
          if (nm.size === deck.length/2) {
            // finished
            setRunning(false);
            onFinished && onFinished(ms);
          }
        }, 400);
      } else {
        setTimeout(() => setFlipped([]), 600);
      }
    }
  }

  return (
    <div>
      <div className="grid grid-cols-4 gap-2 max-w-md mx-auto">
        {deck.map(card => {
          const isFlipped = flipped.some(f => f.id === card.id) || matched.has(card.key);
          return (
            <div key={card.id} className={"card bg-white rounded-xl shadow " + (isFlipped ? "flipped": "")} onClick={() => flip(card)}>
              <div className="card-inner relative h-24 sm:h-28 md:h-32 rounded-xl">
                <div className="card-face front absolute inset-0 bg-pink-300 rounded-xl flex items-center justify-center text-white text-2xl font-bold">❤</div>
                <div className="card-face back absolute inset-0 rounded-xl overflow-hidden">
                  <img src={card.url} alt="card" className="w-full h-full object-cover"/>
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="text-center mt-3">
        <span className="font-mono text-lg">{(ms/1000).toFixed(1)}s</span>
      </div>
    </div>
  );
}

// --- Crowdfunding (Stripe Extension) ---
function useCrowdfunding(eventId, targetCents=4000) {
  const [sum, setSum] = useState(0);
  const [prices, setPrices] = useState([]);

  useEffect(() => {
    // Read prices synced by extension
    db.collection('products').get().then(async prods => {
      const priceSnaps = [];
      for (const p of prods.docs) {
        const ps = await p.ref.collection('prices').get();
        ps.forEach(pp => priceSnaps.push({ id: pp.id, ...pp.data() }));
      }
      // Filter by metadata.tag = 'donation' if desired
      const sorted = priceSnaps.sort((a,b)=> (a.unit_amount||0) - (b.unit_amount||0));
      setPrices(sorted);
    }).catch(console.warn);
  }, []);

  useEffect(() => {
    // Sum over collection group 'payments' with metadata.eventId
    // We can't query by metadata deeply; store eventId in 'description' or 'metadata.eventId' depending on extension mapping.
    // As a simple approach, also keep a fallback 'crowdfunding' subcollection.
    const unsub = db.collectionGroup('crowdfunding')
      .where('eventId', '==', eventId)
      .onSnapshot(s => {
        const total = s.docs.reduce((acc,d)=> acc + (d.data().amountCents||0), 0);
        setSum(total);
      });
    return () => unsub();
  }, [eventId]);

  const percent = Math.min(100, Math.round(sum * 100 / targetCents));

  async function donate(amountCents) {
    try {
      const user = auth.currentUser;
      if (!user) throw new Error('auth required');
      // Fallback donation: create a row; replace with Stripe Extension callable for production.
      await db.collection('events').doc(eventId).collection('crowdfunding').add({
        amountCents, eventId, provider: 'demo', status: 'succeeded', timestamp: firebase.firestore.FieldValue.serverTimestamp()
      });
      alert('Danke für den Beitrag! (Demo, Stripe‑Flow im README aktivieren)');
    } catch (e) {
      alert(e.message);
    }
  }

  return { sum, percent, prices, donate };
}

// --- PDF Export ---
async function exportCardsPDF(eventId, images) {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const pdfDoc = await PDFDocument.create();
  const page = pdfDoc.addPage([595, 842]); // A4 portrait
  const margin = 36;
  const cols = 3, rows = 4; // 12 Karten pro Seite (Vorderseiten), 6 Paare → mehrere Seiten bei Bedarf
  const cellW = (page.getWidth() - margin*2) / cols;
  const cellH = (page.getHeight() - margin*2) / rows;

  // Only 8 pairs per requirement: ensure at most 16 images duplicated
  const imgs = images.slice(0, 8).flatMap(img => [img, img]);

  for (let i=0;i<imgs.length;i++) {
    const img = imgs[i];
    const u8 = await (await fetch(img.imageUrl)).arrayBuffer();
    let emb;
    // naive: try jpeg, fall back to png
    try { emb = await pdfDoc.embedJpg(u8); } catch(e) { emb = await pdfDoc.embedPng(u8); }
    const pageIndex = Math.floor(i / (cols*rows));
    while (pdfDoc.getPageCount()-1 < pageIndex) pdfDoc.addPage([595,842]);
    const p = pdfDoc.getPage(pageIndex);
    const col = i % cols;
    const row = Math.floor(i / cols) % rows;
    const x = margin + col*cellW;
    const y = page.getHeight() - margin - (row+1)*cellH;
    const scale = Math.min(cellW/emb.width, cellH/emb.height);
    const w = emb.width*scale, h = emb.height*scale;
    p.drawImage(emb, { x: x+(cellW-w)/2, y: y+(cellH-h)/2, width: w, height: h });
  }

  const bytes = await pdfDoc.save();
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `event-${eventId}-memory-cards.pdf`; a.click();
  URL.revokeObjectURL(url);
}

// --- Admin & Event ---
function AdminPanel({ event, eventId, onClose }) {
  const [name, setName] = useState(event.name || '');
  const [date, setDate] = useState(event.date || '');
  const [uploadsEnabled, setUploadsEnabled] = useState(!!event.uploadsEnabled);
  const [target, setTarget] = useState(event.crowdfundingTargetCents || 4000);
  const [isPro, setIsPro] = useState(!!event.isPro);
  const [images, setImages] = useState([]);
  const fileRef = useRef(null);

  useEffect(() => {
    const unsub = db.collection('events').doc(eventId).collection('cardImages')
      .orderBy('createdAt', 'desc')
      .onSnapshot(snap => setImages(snap.docs.map(d => ({ id: d.id, ...d.data() }))));
    return () => unsub();
  }, [eventId]);

  async function save() {
    await db.collection('events').doc(eventId).update({
      name, date, uploadsEnabled, crowdfundingTargetCents: Number(target), isPro
    });
    alert('Gespeichert');
  }
  async function uploadOrganizerImage(file) {
    const path = `events/${eventId}/organizer/${Date.now()}-${file.name}`;
    const ref = storage.ref().child(path);
    await ref.put(file);
    const url = await ref.getDownloadURL();
    await db.collection('events').doc(eventId).collection('cardImages').add({
      imageUrl: url, uploadedBy: 'organizer', type: 'organizer', createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }
  async function exportPDF() {
    await exportCardsPDF(eventId, images);
  }
  function makeQR() {
    const el = document.getElementById('qr-holder');
    el.innerHTML = '';
    const url = `${location.origin}${location.pathname}#e=${eventId}`;
    new QRCode(el, { text: url, width: 200, height: 200 });
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-xl font-semibold">Admin – {eventId}</h3>
        <button className="px-3 py-1 rounded bg-gray-200" onClick={onClose}>Schließen</button>
      </div>
      <div className="grid sm:grid-cols-2 gap-3">
        <label className="block">Eventname
          <input className="mt-1 w-full border rounded p-2" value={name} onChange={e=>setName(e.target.value)} />
        </label>
        <label className="block">Datum
          <input type="date" className="mt-1 w-full border rounded p-2" value={date} onChange={e=>setDate(e.target.value)} />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={uploadsEnabled} onChange={e=>setUploadsEnabled(e.target.checked)} />
          Gast‑Uploads erlauben
        </label>
        <label className="block">Crowdfunding‑Ziel (Cent)
          <input className="mt-1 w-full border rounded p-2" type="number" value={target} onChange={e=>setTarget(e.target.value)} />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={isPro} onChange={e=>setIsPro(e.target.checked)} />
          Pro aktiviert
        </label>
      </div>

      <div className="flex items-center gap-2">
        <input ref={fileRef} type="file" accept="image/*" onChange={e=>uploadOrganizerImage(e.target.files[0])} />
        <button onClick={exportPDF} className="px-3 py-2 rounded bg-pink-600 text-white">PDF Karten exportieren</button>
        <button onClick={makeQR} className="px-3 py-2 rounded bg-gray-200">QR generieren</button>
        <a href="./privacy.html" target="_blank" className="px-3 py-2 rounded bg-gray-200">Datenschutz</a>
      </div>
      <div id="qr-holder" className="p-2 bg-white rounded"></div>

      <div>
        <h4 className="font-semibold mb-2">Bilder ({images.length})</h4>
        <div className="grid grid-cols-4 gap-2">
          {images.map(img => <img key={img.id} src={img.imageUrl} className="w-full h-24 object-cover rounded" />)}
        </div>
      </div>
      <button onClick={save} className="px-4 py-2 rounded bg-emerald-600 text-white">Speichern</button>
    </div>
  );
}

function EventPage({ eventId }) {
  const [event, setEvent] = useState(null);
  const [name, setName] = useState('');
  const [finishedMs, setFinishedMs] = useState(null);
  const [leaderboard, setLeaderboard] = useState([]);
  const [uploadConsent, setUploadConsent] = useState(false);
  const [file, setFile] = useState(null);
  const [showAdmin, setShowAdmin] = useState(false);

  // Event laden
  useEffect(() => {
    const unsub = db.collection('events').doc(eventId)
      .onSnapshot(s => setEvent({ id: s.id, ...s.data() }));
    return () => unsub();
  }, [eventId]);

  // Bestenliste laden
  useEffect(() => {
    const unsub = db.collection('events').doc(eventId)
      .collection('players')
      .orderBy('timeMs', 'asc')
      .limit(10)
      .onSnapshot(s => setLeaderboard(s.docs.map(d => d.data())));
    return () => unsub();
  }, [eventId]);

  // ✅ Nur EIN Hook-Aufruf, nicht im useEffect nochmal
  const cfData = useCrowdfunding(eventId, event?.crowdfundingTargetCents || 4000);

  async function onFinished(ms) {
    setFinishedMs(ms);
  }

  async function saveScore() {
    if (!name) return alert('Bitte Namen eingeben');
    await db.collection('events').doc(eventId).collection('players').add({
      name,
      timeMs: finishedMs,
      timestamp: firebase.firestore.FieldValue.serverTimestamp()
    });
    setName('');
    setFinishedMs(null);
  }

  async function uploadGuest() {
    if (!file) return;
    if (!uploadConsent) return alert('Bitte Einverständnis bestätigen');

    const path = `events/${eventId}/guest/${Date.now()}-${file.name}`;
    const ref = storage.ref().child(path);
    await ref.put(file);
    const url = await ref.getDownloadURL();

    await db.collection('events').doc(eventId).collection('guestUploads').add({
      guestName: name || 'Gast',
      imageUrl: url,
      timestamp: firebase.firestore.FieldValue.serverTimestamp(),
      consent: uploadConsent
    });

    // Bild auch ins Deck integrieren
    await db.collection('events').doc(eventId).collection('cardImages').add({
      imageUrl: url,
      uploadedBy: name || 'Gast',
      type: 'guest',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    alert('Danke für dein Foto!');
    setFile(null);
  }

  if (!event) return <div className="p-6">Laden…</div>;

  const proActive = event.isPro || (cfData.sum >= (event.crowdfundingTargetCents || 4000));

  return (
    <div className="max-w-4xl mx-auto p-4">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Hochzeits-Memory</h1>
          <p className="text-sm text-gray-600">{event.name} – {event.date || ''}</p>
        </div>
        <button
          className="px-3 py-2 rounded bg-gray-200"
          onClick={async () => {
            const s = prompt('Admin-Secret eingeben');
            if (!s) return;
            const h = await (async (str)=>{
              const enc = new TextEncoder().encode(str);
              const buf = await crypto.subtle.digest('SHA-256', enc);
              return Array.from(new Uint8Array(buf))
                .map(b => b.toString(16).padStart(2,'0'))
                .join('');
            })(s);
            const doc = await db.collection('events').doc(eventId).get();
            if (doc.exists && doc.data().adminSecretHash === h) {
              setShowAdmin(true);
            } else {
              alert('Falsches Secret');
            }
          }}
        >
          Admin
        </button>
      </header>

      <section className="mt-4">
        <MemoryGame eventId={eventId} onFinished={onFinished} />
      </section>

      <section className="mt-6 p-4 bg-white rounded-xl shadow">
        <h3 className="font-semibold">Bestenliste</h3>
        <ol className="mt-2 space-y-1">
          {leaderboard.map((p,i) => (
            <li key={i} className="flex justify-between">
              <span>{i+1}. {p.name}</span>
              <span className="font-mono">{(p.timeMs/1000).toFixed(1)}s</sp


function CreateEvent({ onCreated }) {
  const [name, setName] = useState('Unsere Hochzeit');
  const [date, setDate] = useState('');
  const [organizerName, setOrganizerName] = useState('');
  const [days, setDays] = useState(30);

  async function create() {
    const id = randomId(8);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + Number(days)*24*60*60*1000);
    await db.collection('events').doc(id).set({
      name, date, organizerName, brandingVisible: true, uploadsEnabled: false,
      isPro: false, crowdfundingTargetCents: 4000, crowdfundingRaisedCents: 0,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      expiresAt: firebase.firestore.Timestamp.fromDate(expiresAt)
    });
    onCreated(id);
  }

  return (
    <div className="max-w-md mx-auto p-4">
      <h2 className="text-xl font-semibold mb-2">Neues Event</h2>
      <label className="block mb-2">Eventname
        <input className="mt-1 w-full border rounded p-2" value={name} onChange={e=>setName(e.target.value)} />
      </label>
      <label className="block mb-2">Datum
        <input type="date" className="mt-1 w-full border rounded p-2" value={date} onChange={e=>setDate(e.target.value)} />
      </label>
      <label className="block mb-2">Organisator
        <input className="mt-1 w-full border rounded p-2" value={organizerName} onChange={e=>setOrganizerName(e.target.value)} />
      </label>
      <label className="block mb-4">Automatische Löschung nach (Tage)
        <input type="number" className="mt-1 w-full border rounded p-2" value={days} onChange={e=>setDays(e.target.value)} />
      </label>
      <button className="px-4 py-2 rounded bg-emerald-600 text-white" onClick={create}>Event erstellen</button>
    </div>
  );
}

function App() {
  const [eventId, setEventId] = useState(null);
  useEffect(() => {
    const hash = new URLSearchParams(location.hash.slice(1));
    const e = hash.get('e');
    setEventId(e);
    window.addEventListener('hashchange', () => {
      const h = new URLSearchParams(location.hash.slice(1));
      setEventId(h.get('e'));
    });
  }, []);

  if (!eventId) {
    return (
      <div className="min-h-screen grid place-items-center p-6">
        <div className="bg-white p-6 rounded-xl shadow max-w-lg w-full">
          <h1 className="text-2xl font-bold mb-2">Hochzeits‑Memory</h1>
          <p className="text-gray-600 mb-4">QR scannen oder Event‑ID wählen.</p>
          <div className="flex gap-2">
            <input className="border rounded p-2 flex-1" placeholder="Event‑ID (z. B. abc123)"
                   onKeyDown={e=>{ if(e.key==='Enter') location.hash = '#e=' + e.currentTarget.value.trim(); }} />
            <button className="px-3 py-2 rounded bg-pink-600 text-white" onClick={()=>{
              const inp = document.querySelector('input[placeholder^="Event‑ID"]');
              if (inp && inp.value.trim()) location.hash = '#e=' + inp.value.trim();
            }}>Öffnen</button>
          </div>
          <div className="mt-6 border-t pt-4">
            <h2 className="font-semibold mb-2">Admin</h2>
            <CreateEvent onCreated={(id)=> { location.hash = '#e='+id; }} />
          </div>
        </div>
      </div>
    );
  }
  return <EventPage eventId={eventId} />;
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
