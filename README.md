# Rain Check SG ☂️

**Before you leave: will rain hit the walking parts of your trip, and what should you do about it?**

Rain Check SG is a mobile web app for people in Singapore who walk to and from public transport. You enter a trip (or tap a saved one), and it checks NEA's forecast **only for the stretches you'll walk, at the time you'll be walking them**. Then it gives you a plain verdict and alternatives:

| Verdict | Meaning | What the app suggests |
|---|---|---|
| 🌤️ **Fine** | No rain forecast on your walks | Nothing. Go. |
| 🌦️ **Light rain** | Light rain, showers | Your umbrella's enough. Shows a route with less walking if there is one. |
| ⛈️ **Heavy rain: change something** | Anything "heavy" or "thundery" | Take the bus/MRT option with the least walking, take a ride-hail, or go later if the outlook improves |

It's a **companion to Google Maps, not a replacement**. When you've decided, one tap opens the trip in Google Maps for navigation.

---

## Part 1: The problem

### Where this started

I carry an umbrella every day and use Google Maps to get anywhere the fastest way. That still doesn't stop me getting caught out. In a Singapore thunderstorm an umbrella isn't enough: you arrive with soaked shoes and legs, or you end up stuck under a shelter waiting it out. Several times I would have **taken a different mode of transport or changed my plans for the day** if I'd known the rain was going to land on the part of my trip where I'm out in the open.

### Who it's for

**Primary: people who walk to and from public transport every day.** That means home → bus stop, MRT → office, station → campus. These are short walks (often 5–15 minutes) that you can't skip, made daily by a large share of Singapore residents.

**Secondary (later): people planning outdoor activities**, like park connector walks, hikes and outings. The same engine applies over a longer time window. It's out of scope for this prototype.

### The actual pain

Walkers rarely lack an umbrella. The pain is:

1. **An umbrella isn't enough in heavy, thundery downpours.** You still get soaked, or you get stranded under a shelter, and lightning makes being in the open unsafe.
2. **Plans get wrecked.** The walk or outing becomes miserable, when a bus, a ride-hail or a different time would have avoided it.

So the useful question isn't "will it rain today?" (it usually might). It's **"will heavy rain hit *my* walking legs, *at the time I'm on them*, and is there a better option?"**

### Why this needs to exist: what's out there today

| What exists | What it does | Why it doesn't answer the question |
|---|---|---|
| **NEA myENV** | Heavy-rain push alerts, rain overlay, 2-hour nowcast, saved locations | Alerts are about a *place* (where you are or saved spots), not a *trip*. You still have to work out whether the rain will be on your walk when you're on it. |
| **MSS rain radar** (weather.gov.sg) | 5-minute radar frames, lightning | Raw observations you read and interpret yourself. No forecast, route or recommendation. |
| **Google Maps, Citymapper** | Fastest transit routes | Ignore weather completely for walking and transit legs. |
| **Apple Weather / Apple Maps** | Minute-by-minute rain, rain-on-route warnings | **Not available in Singapore** (Apple's own country list covers next-hour precipitation only in AU, IE, JP, UK, US). |
| **Undercover** (undercover.gov.sg, OGP prototype, 2026) | Sheltered/shaded walking routes from LTA covered-linkway data | You switch "rainy" mode on yourself. No forecast, no departure time, no bus/MRT legs, no recommendation. |
| **Moovit+** (paid) | Advertises "routes adapted to weather" | Unclear how it works or whether it's active in Singapore. |

**The gap:** nothing combines *your planned trip* + *only the exposed walking parts* + *the time you'll be on them* + *a recommendation of what to do*.

**Positioning vs Undercover.** Undercover shows *where* it's sheltered. Rain Check SG tells you *whether and when* you'll need shelter, and what to do instead. The two complement each other. Merging in covered-linkway data is the natural next step (see Future work).

---

## Part 2: What I need to find out

The prototype exists to test three assumptions, starting with the riskiest.

### 1. Is the data good enough? *(riskiest, test first)*

NEA's 2-hour forecast covers 47 areas in a single 2-hour block. Is that accurate enough to say whether rain falls on a 10–20 minute walk?

- **Method:** for 2 weeks, log real trips with the built-in accuracy logger (`npm run log`). It records the prediction at departure, then pulls what the nearest NEA rain gauges measured along each walking leg, plus what you felt.
- **Pass mark:** the prediction matches reality (wet vs dry) on **at least ~70%** of walks.

### 2. Is it just me?

- **Method:** interview **5–8 people** who walk to transit daily.
- **Questions:**
  - In the last month, how often did rain catch you on a walk?
  - What did you do?
  - What do you check before leaving, if anything?
  - What would you have done differently if you'd known?

### 3. Would people change what they do?

- **Method:** in the same interviews, show a real verdict from the app for a trip they make and ask: "What would you do now?"
- **Pass mark:** **at least 5 of 8** say they'd change transport or timing based on a "heavy rain" verdict.

The pass marks were set *before* collecting evidence, so the results can't be read generously after the fact. Missing a pass mark is still a valid finding.

---

## Part 3: How it works

```
 trip (from, to, departure time)
        │
        ▼
 OneMap public-transport routing ──► up to 3 itineraries, each split into legs:
        │                            walk → bus 166 → walk → MRT NS → walk
        ▼
 for each WALK leg: sample a point every ~150 m and work out what time you'll be there
        │
        ▼
 forecast at (point, time)
   • within the 2-hour window → NEA 2-hour forecast, nearest of 47 areas   ("high confidence")
   • later, up to ~24 h       → NEA 24-hour forecast, nearest of 5 regions ("rough outlook")
        │
        ▼
 forecast text → level:  fair/cloudy = fine · light rain/showers = light · heavy/thundery = heavy
        │
        ▼
 verdict for the fastest itinerary (the one Google Maps would give you)
   + alternatives: the itinerary with the least walking in rain · ride-hail (heavy only)
                   · "go later" if the 24-hour outlook improves
   + "right now" from the nearest live rain gauge if you're leaving within 30 min
```

Bus and MRT legs count as sheltered. **Every walking leg counts as exposed**, including covered walkways. That's deliberately cautious, so the app errs towards "bring/use your umbrella", never towards "you'll be fine".

### Data sources (all free, no credit card)

| Source | Used for | Detail level |
|---|---|---|
| [data.gov.sg 2-hour forecast](https://data.gov.sg/collections/weather-forecast/view) (NEA) | Main forecast | 47 areas, one 2-hour block, updated every 30 min |
| [data.gov.sg 24-hour forecast](https://data.gov.sg/collections/weather-forecast/view) (NEA) | Trips more than 2 h away, "go later" advice | 5 regions × ~3 time blocks |
| [data.gov.sg realtime rainfall](https://data.gov.sg) (NEA) | "Raining now at the gauge near you"; accuracy log | 88 stations, 5-minute totals |
| [OneMap](https://www.onemap.gov.sg/apidocs/) (SLA) | Place search, bus/MRT routing with walking legs | Leg-by-leg itineraries |
| [OpenRouteService](https://openrouteservice.org) / [FOSSGIS OSRM](https://routing.openstreetmap.de) | Walking-only fallback if OneMap isn't configured | OpenStreetMap |

Google Maps routing was ruled out because it needs a billing account with a card. The app links to Google Maps for navigation, which needs no API.

---

## Running it

Requires **Node.js 20.12+**. There are no npm dependencies.

```bash
git clone https://github.com/Ongzl/raincheck-sg.git
cd raincheck-sg
npm start          # http://localhost:3000
```

It works straight away using **walking-only routes**. For bus/MRT itineraries, which make the "take the bus instead" suggestion possible, add a free OneMap account:

```bash
cp .env.example .env
# fill in ONEMAP_EMAIL and ONEMAP_PASSWORD (register at https://www.onemap.gov.sg/apidocs/register)
npm start
```

Other commands:

```bash
npm test                                         # unit tests for the decision logic
npm run log -- predict "Bishan MRT" "Junction 8" # accuracy log: record a prediction as you leave
npm run log -- observe --felt heavy              # after the walk: gauges + what you felt (dry|light|heavy)
npm run log -- report                            # match rate vs the 70% target
```

### Project layout

```
server.js            zero-dependency HTTP server: static files + /api/search + /api/check
src/weather.js       data.gov.sg fetch + 5-minute cache (keyless limit is 6 requests / 10 s)
src/routing.js       OneMap PT → OpenRouteService → OSRM fallback chain, normalised itineraries
src/verdict.js       pure decision logic: forecast along legs, verdict, alternatives
src/geo.js           distances, nearest point, path sampling
src/polyline.js      encoded-polyline decoder
public/              the mobile web app (plain HTML/CSS/JS, saved trips in localStorage)
scripts/accuracy-log.js   the two-week data-accuracy study
test/                node:test unit tests
```

---

## Decisions and scope

| Decision | Choice | Why |
|---|---|---|
| Primary user | Walkers & transit users | Daily, frequent pain; easy to find interviewees; forecast detail fits 10–20 min walks |
| Weather | Rain only | Clearest pain; heat stress (WBGT) is a stretch goal, mainly for outdoor planners |
| When it's used | Before leaving | All three decisions (umbrella, transport, plans) happen before you step out; no push or background location needed |
| Output | Verdict + reason + alternatives | A raw forecast is what people already have and ignore |
| Routing | OneMap (bus/MRT legs) | The only free, no-card option that understands Singapore buses and MRT |
| Relationship to Google Maps | Companion, links out | Don't fight a habit people won't change |
| Platform | Mobile web app | Fastest to build alone, shareable by link |
| Covered walkways | Not subtracted (yet) | Real geospatial work; treating all walking as exposed is the cautious default |

### Known limitations

- **The 2-hour forecast is one block for each of 47 area *points*.** Each spot on a walk takes the forecast of the nearest area label. It can't say "rain starts at 4:40", which is why the app gives no exact "leave by" times.
- **Beyond 2 hours, only 5 regions × ~3 blocks exist**, and they're often identical across regions. Those checks are labelled "rough outlook".
- **OneMap bus/MRT parsing is tested against a fixture**, built from OneMap's documented OpenTripPlanner-style response, not against a live call (no OneMap account was used during development). Walking-only routing, search, and all weather data were tested live.
- **Ride-hail is suggested, not priced**, and there's no ride-hail API.
- **Not an official forecast.** It's a student prototype built on NEA data.

### Future work

- Subtract **LTA covered linkways** ([LTA DataMall](https://datamall.lta.gov.sg/content/datamall/en/static-data.html), quarterly shapefiles) from walking legs, so the check counts only truly exposed minutes, and offer the more sheltered option.
- **Live alerts** if rain appears on a saved trip shortly before its usual time.
- **Radar-based nowcasting** to support specific "leave by" times.
- **Heat stress** (WBGT) and **outdoor-activity planning** for the secondary user group.

---

## Credits & licences

- Weather data © NEA, from [data.gov.sg](https://data.gov.sg), under the [Singapore Open Data Licence](https://data.gov.sg/open-data-licence).
- Search and routing © [OneMap](https://www.onemap.gov.sg), Singapore Land Authority.
- Fallback walking routes © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), via openrouteservice or FOSSGIS OSRM.
- Code: MIT licence.
