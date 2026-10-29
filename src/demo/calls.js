// Scripted calls to Sam's line, through the REAL tools (lookup, sorting, briefings, passcode, messages, memory), so the
// live screen can show how the agent treats each kind of caller without a phone. The lines are scripted; who the
// caller turns out to be, the rule and time limit used, what gets saved and what Sam is told all come from the tools.
// Nothing is sent to Telegram and no call is placed: Sam's phone shows on screen.
import { emit } from '../store.js';
import { flags } from '../notify.js';
import { clipFor } from './audio.js';
import { showNumber } from '../assistant.js';

// each step: [who, line, tool, args, before] (before = the tool runs before the line is said)
export const PERSONAS = {
  sales: {
    label: 'Insurance sales', sub: 'A new number, LIC', number: '+919845012345', voice: 'ce45ddca-5f4b-4047-ada3-3fce2bc78acd',
    then: 'sales_again',
    steps: [
      ['agent', 'Hello?', 'lookup_caller', {}, true],
      ['caller', 'Hello sir, main Neha bol rahi hoon, LIC se. Aapke liye ek naya term plan hai, bas do minute lagenge.', 'classify_caller', { name: 'Neha', org: 'LIC', purpose: 'term insurance plan pitch', guess: 'sales' }],
      ['agent', 'Ji, unhe insurance mein interest nahi hai. Please yeh number apni list se hata dijiye.'],
      ['caller', 'Sir bas ek minute, premium sirf aath sau rupaye mahina hai...'],
      ['agent', 'Nahi ji, shukriya. Dobara call mat kijiye.', 'end_call', { name: 'Neha', org: 'LIC', kind: 'sales', summary: 'LIC term plan pitch, declined and asked them to remove your number', outcome: 'declined', block: true }],
    ],
  },
  sales_again: {
    label: 'LIC calls again', sub: 'The same number, an hour later', number: '+919845012345', hidden: true,
    steps: [
      ['agent', '', 'lookup_caller', {}, true],
      ['agent', '', 'end_call', { org: 'LIC', kind: 'sales', summary: 'called again, hung up without talking', outcome: 'blocked number, cut off' }],
    ],
  },
  friend: {
    label: 'Rohit', sub: 'Close friend', number: '+919900112233', voice: '7e8cb11d-37af-476b-ab8f-25da99b18644',
    steps: [
      ['agent', 'Arre Rohit! Sam abhi meeting mein hai, chhe baje tak. Kuch bolna hai?', 'lookup_caller', {}, true],
      ['caller', 'Haan yaar, usko bolna aaj raat cricket hai, aath baje, HSR turf pe. Aa raha hai ya nahi, bata de.'],
      ['agent', 'Done. Aath baje, HSR turf, cricket. Main bol deta hoon, woh tujhe confirm karega.', 'take_message', { name: 'Rohit', message: 'Cricket tonight at 8 at HSR turf. Wants to know if you are coming.' }],
      ['caller', 'Haan perfect. Chal bye.'],
      ['agent', 'Bye Rohit!', 'end_call', { name: 'Rohit', kind: 'close', summary: 'cricket tonight at 8 at HSR turf, wants a yes or no', outcome: 'message taken' }],
    ],
  },
  mom: {
    label: 'Mom, from another phone', sub: 'Unknown number, knows the code', number: '+919731100456', voice: '56e35e2d-6eb6-4226-ab8b-9776515a7094',
    steps: [
      ['agent', 'Hello?', 'lookup_caller', {}, true],
      ['caller', 'Hello, main Sam ki mummy bol rahi hoon, dusre number se. Usse abhi baat karni hai, zaroori hai.', 'classify_caller', { name: 'Mom', purpose: "Sam's mother, wants to talk to him urgently", guess: 'close' }],
      ['agent', 'Ji aunty, Sam meeting mein hai. Zaroori hai toh Sam ka code bata dijiye, main abhi usko bulata hoon.'],
      ['caller', 'Haan, five five four three four.', 'check_passcode', { code: '55434', name: 'Mom' }],
      ['agent', 'Code sahi hai aunty. Maine Sam ko abhi bata diya, woh do minute mein isi number pe call karega.'],
      ['caller', 'Theek hai beta, thank you.'],
      ['agent', 'Ji aunty, bye.', 'end_call', { name: 'Mom', relation: 'mother (another number)', kind: 'close', summary: 'Mom, from another number, urgent. Gave your code, so I alerted you to call back', outcome: 'alerted Sam' }],
    ],
  },
  landlord: {
    label: 'Mr Sharma', sub: 'Landlord, about the rent', number: '+919845566778', voice: '9b953e7b-86a8-42f0-b625-1434fb15392b',
    steps: [
      ['agent', 'Namaste Sharma ji! Sam abhi meeting mein hai, main uski taraf se baat kar raha hoon.', 'lookup_caller', {}, true],
      ['caller', 'Haan, rent ka kya hua? Teen tareekh nikal gayi, abhi tak aaya nahi.'],
      ['agent', 'Ji, is mahine Sam thoda tight hai. Kya dus tareekh tak chalega?'],
      ['caller', 'Dus bahut late hai. Saat tak de do, nahi toh late fee lagegi.'],
      ['agent', 'Saat thoda mushkil hai, Sharma ji. Dus tareekh pakka, bina late fee ke.'],
      ['caller', 'Achha theek hai, dus pakka. Uske baad nahi chalega.'],
      ['agent', 'Ji, dus tareekh pakka. Main Sam ko bata deta hoon. Namaste!', 'end_call', { name: 'Mr Sharma', kind: 'known', summary: 'rent: agreed to pay by the 10th, no late fee (inside your limit of the 15th)', outcome: 'agreed: rent by the 10th' }],
    ],
  },
  jio: {
    label: 'Jio', sub: 'A new number, service call', number: '+917011223344', voice: 'a631bc8b-ea1c-49bb-8dab-7a118afd11b8',
    steps: [
      ['agent', 'Hello?', 'lookup_caller', {}, true],
      ['caller', 'Hello sir, main Jio customer care se Riya bol rahi hoon. Aapke postpaid number ka auto-pay fail ho gaya hai, saat sau ninyanve ka bill pending hai.', 'classify_caller', { name: 'Riya', org: 'Jio', purpose: 'postpaid auto-pay failed, bill pending', guess: 'service' }],
      ['agent', 'Achha. Last date kya hai, aur payment kahan se karna hai?'],
      ['caller', 'Last date tees tareekh hai. MyJio app se ho jayega. Main OTP bhejun, auto-pay abhi set kar dete hain?'],
      ['agent', 'Nahi, OTP nahi. Sam app se khud kar lega. Thank you, Riya ji.', 'end_call', { name: 'Riya', org: 'Jio', kind: 'service', summary: 'postpaid bill ₹799 due on the 30th, auto-pay failed. Pay in the MyJio app. They offered an OTP, I said no', outcome: 'details taken, no OTP shared' }],
    ],
  },
  investor: {
    label: 'Rahul, XYZ Capital', sub: 'Investor, briefed from a ChatGPT chat', number: '+919820033344', voice: '205fc552-2cce-4307-baa1-598b9dc3dd01', lang: 'en',
    steps: [
      ['agent', "Hi Rahul! Sam's in a meeting till six. I'm his assistant, he's told me about the round. Go ahead.", 'lookup_caller', {}, true],
      ['caller', "Great. We've discussed it internally. We can do the one crore at seven crore pre-money. That's a strong offer at this stage."],
      ['agent', "Thanks, Rahul. Sam's number is eight crore pre-money. Below that, he won't move ahead."],
      ['caller', 'Eight is a stretch. Seven and a half, and we close this week?'],
      ['agent', "I can't agree to that, but I'll take seven and a half to Sam today.", 'alert_owner', { name: 'Rahul Verma', reason: 'XYZ Capital offered ₹7.5 Cr pre-money for the ₹1 Cr round, below your ₹8 Cr line' }],
      ['caller', 'Fair. Tell him to call me by evening.'],
      ['agent', 'Will do. Bye, Rahul.', 'end_call', { name: 'Rahul Verma', org: 'XYZ Capital', kind: 'known', summary: 'offered ₹7 Cr, then ₹7.5 Cr pre-money. Below your ₹8 Cr line, so I did not agree. Wants a call by evening', outcome: 'no deal, passed to you' }],
    ],
  },
};
export const personaList = () => Object.entries(PERSONAS).filter(([, p]) => !p.hidden).map(([id, p]) => ({ id, label: p.label, sub: p.sub, number: p.number }));

let running = false;
export const isCalling = () => running;
export async function demoCall(TOOLS, { persona = 'sales', pace = 1 } = {}) {
  const P = PERSONAS[persona];
  if (!P) return { ok: false, error: 'unknown persona' };
  if (running) return { ok: false, error: 'already running' };
  running = true; flags.noCalls = true; flags.quiet = true;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms / pace));
  const run = async (tool, args) => {
    const a = { caller_number: P.number, ...args };
    emit('tool.call', { tool, args: a });
    const out = await TOOLS[tool](a);
    emit('tool.result', { tool, out, args: a });
  };
  try {
    emit('call.started', { demo: true, kind: 'line', caller: showNumber(P.number), number: P.number, persona });
    await sleep(1200);
    for (const [i, [who, text, tool, args, before]] of P.steps.entries()) {
      if (tool && before) { await run(tool, args); await sleep(500); }
      if (text) {
        const clip = clipFor('line-' + persona, i);
        emit('call.line', { role: who === 'caller' ? 'caller' : 'agent', text, audio: clip?.src || null, kind: 'line' });
        await sleep(clip ? clip.seconds * 1000 + 250 : 1400 + text.length * 40);
      }
      if (tool && !before) { await run(tool, args); await sleep(text ? (who === 'caller' ? 700 : 450) : 900); }
    }
    emit('call.ended', { demo: true, kind: 'line' });
  } finally { running = false; flags.noCalls = false; flags.quiet = false; }
  // the spammer tries again: this time the line knows the number
  if (P.then) { await sleep(3500); return demoCall(TOOLS, { persona: P.then, pace }); }
  return { ok: true };
}
