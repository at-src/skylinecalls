// Shows Hindi on screen in English letters ("aap abhi kahan ho?"), the way people type Hinglish, unless the owner
// picks हिंदी. Varun and the speech-to-text write Hindi in Devanagari (the voice reads it better); this only changes
// what the dashboard displays. No network, no model: a word list for everyday words, then letter by letter.
const WORDS = {
  'में': 'mein', 'मैं': 'main', 'है': 'hai', 'हैं': 'hain', 'हूँ': 'hoon', 'हूं': 'hoon', 'हो': 'ho', 'था': 'tha', 'थी': 'thi', 'थे': 'the',
  'नहीं': 'nahi', 'नही': 'nahi', 'हाँ': 'haan', 'हां': 'haan', 'जी': 'ji', 'क्या': 'kya', 'क्यों': 'kyon', 'कौन': 'kaun', 'कब': 'kab',
  'कहाँ': 'kahan', 'कहां': 'kahan', 'यहाँ': 'yahan', 'यहां': 'yahan', 'वहाँ': 'wahan', 'वहां': 'wahan', 'कैसे': 'kaise', 'कितना': 'kitna',
  'आप': 'aap', 'आपका': 'aapka', 'आपकी': 'aapki', 'आपके': 'aapke', 'आपको': 'aapko', 'मेरा': 'mera', 'मेरी': 'meri', 'मेरे': 'mere', 'मुझे': 'mujhe',
  'हम': 'hum', 'तुम': 'tum', 'वो': 'wo', 'वह': 'woh', 'ये': 'ye', 'यह': 'yeh', 'उनको': 'unko', 'उसको': 'usko', 'उन्हें': 'unhe',
  'का': 'ka', 'की': 'ki', 'के': 'ke', 'को': 'ko', 'से': 'se', 'पे': 'pe', 'पर': 'par', 'तक': 'tak', 'और': 'aur', 'या': 'ya', 'भी': 'bhi',
  'ही': 'hi', 'तो': 'toh', 'ना': 'na', 'कि': 'ki', 'अभी': 'abhi', 'कभी': 'kabhi', 'फिर': 'phir', 'बस': 'bas', 'सब': 'sab',
  'ठीक': 'theek', 'अच्छा': 'achha', 'अच्छी': 'achhi', 'बहुत': 'bahut', 'थोड़ा': 'thoda', 'सीधा': 'seedha', 'सीधे': 'seedhe',
  'आगे': 'aage', 'पीछे': 'peeche', 'ऊपर': 'upar', 'नीचे': 'neeche', 'बाएँ': 'left', 'दाएँ': 'right', 'पास': 'paas', 'दरवाज़ा': 'darwaza', 'दरवाजा': 'darwaza',
  'भैया': 'bhaiya', 'भाई': 'bhai', 'बेटा': 'beta', 'सर': 'sir', 'वाला': 'wala', 'वाली': 'wali', 'वाले': 'wale',
  'रहा': 'raha', 'रही': 'rahi', 'रहे': 'rahe', 'कर': 'kar', 'करो': 'karo', 'करें': 'karein', 'करता': 'karta', 'करती': 'karti', 'करते': 'karte',
  'बोल': 'bol', 'बोलो': 'bolo', 'बताओ': 'batao', 'बताइए': 'bataiye', 'बताइये': 'bataiye', 'दीजिए': 'dijiye', 'दीजिये': 'dijiye',
  'कीजिए': 'kijiye', 'लीजिए': 'lijiye', 'आइए': 'aaiye', 'जाओ': 'jao', 'आओ': 'aao', 'दो': 'do', 'लो': 'lo', 'देता': 'deta', 'लेता': 'leta',
  'दिख': 'dikh', 'मिल': 'mil', 'बात': 'baat', 'मदद': 'madad', 'नाम': 'naam', 'काम': 'kaam', 'समय': 'samay', 'आज': 'aaj', 'कल': 'kal',
  'नमस्ते': 'namaste', 'नमस्कार': 'namaskar', 'धन्यवाद': 'dhanyavaad', 'शुक्रिया': 'shukriya', 'अलविदा': 'alvida', 'ज़रूर': 'zaroor', 'जरूर': 'zaroor',
  'कोई': 'koi', 'सा': 'sa', 'सी': 'si', 'सही': 'sahi', 'चाहिए': 'chahiye', 'चाहिये': 'chahiye', 'सुनिए': 'suniye', 'अगला': 'agla', 'बढ़ो': 'badho', 'बढ़ते': 'badhte', 'बड़ा': 'bada', 'बड़ी': 'badi',
};
const C = { 'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n', 'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n', 'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n', 'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm', 'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
  'क़': 'q', 'ख़': 'kh', 'ग़': 'g', 'ज़': 'z', 'ड़': 'd', 'ढ़': 'dh', 'फ़': 'f', 'य़': 'y' };
const NUKTA = { 'क': 'क़', 'ख': 'ख़', 'ग': 'ग़', 'ज': 'ज़', 'ड': 'ड़', 'ढ': 'ढ़', 'फ': 'फ़', 'य': 'य़' };
const V = { 'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o' };
const M = { 'ा': 'aa', 'ि': 'i', 'ी': 'ee', 'ु': 'u', 'ू': 'oo', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o' };
const DIGITS = '०१२३४५६७८९';
function word(w) {
  if (WORDS[w]) return WORDS[w];
  const ch = [...w.normalize('NFC')];
  let out = '';
  for (let i = 0; i < ch.length; i++) {
    let c = ch[i];
    if (ch[i + 1] === '़' && NUKTA[c]) { c = NUKTA[c]; i++; }
    if (C[c]) {
      const next = ch[i + 1];
      if (next === '्') { out += C[c]; i++; continue; }            // half letter: no vowel
      if (M[next]) { out += C[c] + M[next]; i++; continue; }       // letter + vowel sign
      out += C[c] + (i + 1 < ch.length && !'ंँः'.includes(next) ? 'a' : (next ? 'a' : ''));  // inherent "a", dropped at the end
      continue;
    }
    if (V[c]) { out += V[c]; continue; }
    if (c === 'ं' || c === 'ँ') { out += 'n'; continue; }
    if (c === 'ः') { out += 'h'; continue; }
    const d = DIGITS.indexOf(c); if (d >= 0) { out += d; continue; }
    out += c;
  }
  // how people type it: a long "aa" at the end of a longer word is written "a" (raha, wala, achha)
  if (out.length > 3 && out.endsWith('aa')) out = out.slice(0, -1);
  if (out.length > 3 && out.endsWith('ee')) out = out.slice(0, -2) + 'i';
  if (out.endsWith('ie')) out = out.slice(0, -1) + 'ye';
  return out.replace(/chchh/g, 'chh');
}
const DEVA = /[\u0900-\u097F]/;
export function toLatin(text) {
  const s = String(text ?? '');
  if (!DEVA.test(s)) return s;
  const out = s.replace(/[\u0900-\u0963\u0966-\u097F]+/g, (w) => word(w)).replace(/\u0964|\u0965/g, '.');
  // capitalise the first letter of a line and after a full stop or question mark, like typed text
  return out.replace(/(^|[.?!]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase());
}
// the owner's choice: 'latin' (default) or 'deva'
export const script = { mode: (typeof localStorage !== 'undefined' && localStorage.getItem('ttd-script')) || 'latin' };
export const shown = (text) => (script.mode === 'deva' ? String(text ?? '') : toLatin(text));
