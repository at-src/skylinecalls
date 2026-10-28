# ToTheDoor: build spec

Status: locked. Every choice below is decided. If something isn't covered, pick the simplest option that keeps the demo working and note it in the "Decisions log" at the bottom.

## 1. The product in one paragraph

Maps get a rider to within 20 to 40 metres of you, never to your door. ToTheDoor is a voice agent that learns the way to your door once, the way you'd explain it to a friend, and then guides anyone you're expecting (Amazon, Swiggy, Zepto, Blinkit, Uber, Rapido) from wherever they are to your door. You never have to pick up. It only rings you when it really needs you, and it never helps anyone you didn't invite.

Pitch line: "Your address, the way you'd explain it to a friend. Taught once, used by every app."

### Who owns it

ToTheDoor is an independent service. The **user owns their door path** and sets it up for free. **Businesses plug in**: a delivery or ride app's "Call customer" button routes to ToTheDoor instead of the customer's phone, and the business pays per guided visit (cheaper than one failed delivery or a support call). One door path serves every app, so the user never teaches it twice.

For the demo, the user side is shown in full (teach your door, expect a visit), and the business side is shown as a mock delivery app using it.

### Calls on the Bolna trial plan

Trial accounts can only place outbound calls to verified numbers. That is enough for the demo: the builder's phones play the rider and the customer, and both are verified. Full calling (any number) needs wallet funds and is not required before Oct 31.

## 2. The three parts

### 2.1 Calibration: the agent learns your door path

- A phone call (Bolna) between the agent and the customer.
- The customer names an **anchor**: a well-known landmark the map can find ("start from landmark X").
- The customer describes the **path** from the anchor to the door, step by step.
- While the customer talks, the agent calls tools to:
  - find the anchor on the map and confirm it ("Is it the X on 27th Main?")
  - list real shops and places around each step and check them with the customer ("Next to Y I see a chemist and an ATM. Right?")
- The agent asks follow-up questions until there are no gaps: which side, how far, what's visible, signs, colours, gates, floors, open at night or not, where to leave the parcel if nobody answers, who the guard or neighbour is.
- At the end it reads the path back in short form and the customer confirms.
- Output: one **door path** saved as JSON (section 4).

### 2.2 Expected visitors: security

- The agent only guides people the customer is expecting.
- The customer registers each visit before it happens, by:
  - Telegram message to the bot, e.g. `zepto` or `uber` or `amazon 9876543210`, or
  - the "Expecting a delivery" button on the customer dashboard.
- A visit records: service name, optional rider phone, a 4-digit code, created time, expiry (default 3 hours, ends early when marked delivered).
- On a guidance call the agent checks the caller before giving any directions:
  - outbound mode (demo default): we only ever dial riders attached to an active visit, so the caller is verified by construction.
  - inbound mode (if a number becomes available): the caller's number must match the visit, or the caller must say the 4-digit code.
- Unverified caller: the agent says it can't help with that address and ends the call. The customer gets a Telegram alert.
- The agent never reads out the full address or the full path. It only gives the next step from where the caller is now.

### 2.3 Guidance: getting anyone from anywhere to the door

- Trigger: the rider presses **Call customer** in the rider app. That makes Bolna call the rider's phone straight away (outbound). To the rider, it feels like calling the customer.
- The agent works out where the rider is, using both:
  - the rider's live position (from the rider app), and
  - what the rider says he can see.
- **Far zone** (more than about 150 m from the anchor): normal road directions to the anchor, from the map routing API. Short instructions, one at a time.
- **Near zone** (at or past the anchor): the door path. The agent finds which step the rider is on and gives the next one, then confirms it ("Can you see the red door?").
- If the rider names something that isn't on the path, the agent looks it up on the map near the rider and brings him back to the nearest step or to the anchor.
- **Fallback, call the customer:** if the rider needs the customer (cash on delivery, OTP, refuses to leave the parcel, stuck after 2 tries), the agent triggers a Bolna call to the customer's phone. If the customer doesn't answer, it follows the saved fallback (guard, neighbour, safe spot) and tells the rider exactly what to do.
- The customer gets Telegram updates throughout: "Zepto rider is 2 min away", "At your gate", "Delivered to the guard at Gate 2, 4:12 PM".
- After the call, the outcome is stored and shown on the dashboard.

## 3. Stack (fixed)

| Part | Choice |
|---|---|
| Backend | Node 22, Express, plain JavaScript (ES modules), no TypeScript |
| Frontend | Plain HTML, CSS and JavaScript served by the backend. No framework, no build step |
| Storage | JSON files in `data/` (git-ignored). No database |
| Voice and calls | Bolna. Two agents: `calibrate` and `guide`. Created and updated by a setup script through the Bolna API; if tool setup fails through the API, set tools in the Bolna dashboard and document the steps |
| Calls mode | Outbound calls to verified numbers (trial accounts allow this). Bolna web call is the backup. Inbound only if Bolna provides a number |
| Speech-to-text | ElevenLabs Scribe `scribe_v2_realtime` through Bolna, language `hi` (handles Hinglish). Builder's choice for accuracy; on the flat-rate list |
| Text-to-speech | Cartesia `sonic-3`, voice Varun (male Hindi, imported into Bolna by ID `4cd9f881-58f7-4969-876a-00983214c362`) |
| Agent LLM | The fastest LLM on Bolna's preferred (flat-rate) list |
| Language | Hinglish: Hindi and English mixed, following the caller |
| Map data | Google Maps Platform only: Geocoding with Address Descriptors (landmarks, built for India), Places Nearby and Text Search, Routes (two-wheeler). One provider, so there is never a choice of which to call |
| Map display | Google Maps JavaScript API on the dashboard and rider app |
| Door-path structuring and checks | Gemini Flash on Vertex AI (project `your-gcp-project`, gcloud token), newest GA Flash model at build time |
| Notifications | Telegram bot (customer updates, register visits, alerts) |
| Public URL for Bolna tools | ngrok (already configured) |
| Secrets | `.env` only, read from the Desktop key files by a helper script. Never committed, never printed |

## 4. Door path format

```json
{
  "id": "home-1",
  "customer": { "name": "Demo Customer", "phone": "+91XXXXXXXXXX", "language": "hi-IN" },
  "anchor": { "name": "Landmark X", "lat": 0, "lng": 0, "source": "mappls|google", "confirmed": true },
  "steps": [
    {
      "n": 1,
      "instruction": "Keep landmark X on your right and walk straight past about 10 shops.",
      "see": ["Shop Y with a green board"],
      "side": "right",
      "distance_m": 60,
      "check": "Can you see Shop Y with the green board?",
      "map_matches": [{ "name": "Shop Y", "lat": 0, "lng": 0, "source": "google" }]
    }
  ],
  "door": { "floor": "2nd", "side": "right", "action": "knock", "marks": ["red door left of Shop Y", "bikes parked in the passage"] },
  "fallback": { "if_no_answer": "Leave with the guard at the gate", "contact": "guard", "safe_spot": null },
  "notes": ["Gate closed after 11 pm"],
  "verified_at": "ISO date"
}
```

## 5. Backend tools (called by the Bolna agents during calls)

| Tool | Used by | What it does |
|---|---|---|
| `find_place(query, near)` | calibrate, guide | Search a named place near a point; returns top matches with distance and side |
| `nearby(lat, lng, radius)` | calibrate | Real shops and landmarks around a point, for checks |
| `save_step(step)` / `save_door(...)` / `save_fallback(...)` | calibrate | Build the door path during the call |
| `finish_calibration()` | calibrate | Validate the path with Gemini, return gaps still open |
| `verify_caller(code?)` | guide | Check the caller against active visits |
| `rider_status()` | guide | Rider's live position, distance to anchor, zone, nearest landmarks, current step |
| `next_instruction(seen?)` | guide | Next road direction (far) or next path step (near), using what the rider says he sees |
| `call_customer(reason)` | guide | Start the fallback call to the customer |
| `log_outcome(result)` | guide | Store the outcome and notify the customer |

Every tool response is short, plain text the agent can say out loud.

## 6. Screens

1. **Customer** (`/`): door path card (anchor, steps, door), "Teach my door" button (starts the calibration call), "Expecting a delivery" button, visit list, Telegram link.
2. **Rider app** (`/rider`): looks like a delivery app on a phone. Order card, map with the rider dot, **Call customer** button. The rider's position comes from a simulated route (default) or the phone's GPS (toggle).
3. **Dashboard** (`/live`): the demo view. Big map with the rider moving, the anchor and each step lighting up as it's reached, live call transcript, Telegram feed, outcome, counters (deliveries guided, customer calls avoided, minutes saved).

## 7. Demo set-up

- City and area: Bengaluru, HSR Layout. Use a real, well-known public landmark there as the anchor and real shops around it.
- The building, flat and door details are invented. No real person's address.
- Phones: the builder's own verified mobile plays the rider; a second verified phone (if available) plays the customer. With one phone, the customer side runs as a Bolna web call.
- Demo story: "Zepto order. Customer is in a meeting. Rider is 1.5 km away and takes a wrong turn. ToTheDoor brings him to the anchor, then up to the door. Customer gets one Telegram message: delivered."

## 8. What "done" means for Oct 31

1. A calibration call produces a door path that is correct and complete for the demo address.
2. A guidance call takes the simulated rider from about 1.5 km away to the door, including one wrong turn that gets corrected.
3. An unexpected caller is refused, and the customer is alerted.
4. The "customer doesn't answer" fallback works end to end.
5. README explains the problem, how it works, how to run it, and has screenshots.
6. A pitch deck (PDF) is ready for the Google Drive folder.
7. The pitch video is made with the builder after everything works.

## 9. Build order

1. Skeleton: server, `.env` loader, JSON storage, the three screens with placeholder data.
2. Map tools on Mappls and Google, tested on the demo area.
3. Door path: save tools, Gemini check, a hand-made demo path to start with.
4. Rider simulator and the dashboard map.
5. Bolna `guide` agent with tools (most important for the demo).
6. Visits and caller check, Telegram bot.
7. Bolna `calibrate` agent; replace the hand-made path with a real calibrated one.
8. Fallback call to the customer.
9. Polish, README, screenshots, pitch deck.

## 10. Rules

- Never commit or print API keys. `.env` stays git-ignored.
- No real personal address anywhere in the repo.
- Commits on `main`, small and frequent, plain messages. No pushes to GitHub until the builder says so; the repo is created private.
- Don't spend money beyond Bolna call minutes and one phone number (if Bolna allows one). Ask before anything else that costs.

## Decisions log

(Add any choice made during the build that this spec didn't cover.)

- 2026-10-28: Maps on Google only. Both providers were tested in HSR Layout and both cover everything we need; using two adds a "which one?" decision on every call for no clear gain. Google is kept because it has Address Descriptors (landmarks relative to a point, made for India) and directions that already name landmarks ("pass by the lake on the right"). Mappls key stays in `.env` unused.
- 2026-10-28: Voice: Cartesia `sonic-3`, male Hindi voice (on Bolna's flat-rate list). Sarvam voices rejected as robotic on the phone line. Agent speaks as the customer's household, never says "ToTheDoor". Call opening copies a real delivery call: the agent picks up with "Hello?", the rider says who he is, the agent replies in one short line ("Haan ji, bataiye, abhi kahan pahunche ho?"). No introductions or explanations.
- 2026-10-28: Bolna account on trial plan: wallet 500 (USD cents), 2 concurrent calls, outbound to verified numbers only.
