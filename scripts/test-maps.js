// Smoke test for the map tools in HSR Layout. Usage: npm run test:maps
import '../src/env.js';
import { nearby, landmarks, findPlace, streetAt, route, distance } from '../src/maps.js';

const P = { lat: 12.9116, lng: 77.6389 };
const FAR = { lat: 12.9231, lng: 77.6510 }; // Agara, on a main road ~1.7 km away
const show = (label, v) => console.log(`\n== ${label}\n` + JSON.stringify(v, null, 1).slice(0, 900));

show('streetAt', await streetAt(P));
show('landmarks', await landmarks(P));
show('nearby', (await nearby(P)).slice(0, 6));
show('findPlace "BDA Complex"', (await findPlace('BDA Complex HSR Layout', P)).slice(0, 3));
const r = await route(FAR, P);
show('route', { distance_m: r.distance_m, straight_m: Math.round(distance(FAR, P)), steps: r.steps.slice(0, 6).map((s) => `${s.text} (${s.distance_m} m)`) });
