// Map helpers, all on Google Maps Platform (one provider, no guessing which to use).
//   landmarks(p)       landmarks relative to a point (Geocoding + Address Descriptors, built for India)
//   nearby(p, radius)  real places around a point (Places Nearby Search)
//   findPlace(q, near) a named place near a point (Places Text Search)
//   streetAt(p)        street and area at a point (Reverse Geocoding)
//   route(from, to)    two-wheeler road directions with landmark hints (Routes API)
import { env } from './env.js';

const KEY = () => env.GOOGLE_MAPS_KEY;

// ---------- geometry ----------
const R = 6371000, rad = (d) => (d * Math.PI) / 180, deg = (r) => (r * 180) / Math.PI;

export function distance(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function bearing(a, b) {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

// where b is, for someone at a facing `heading`: ahead / right / behind / left
export function relativeSide(a, heading, b) {
  const d = (bearing(a, b) - heading + 360) % 360;
  if (d < 45 || d >= 315) return 'ahead';
  if (d < 135) return 'on your right';
  if (d < 225) return 'behind you';
  return 'on your left';
}

const compass = (b) => ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][Math.round(b / 45) % 8];
export const direction = (a, b) => compass(bearing(a, b));

async function getJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(12000) });
  const text = await r.text();
  let j;
  try { j = JSON.parse(text); } catch { throw new Error(`bad response ${r.status}: ${text.slice(0, 120)}`); }
  if (j.error || (j.status && !['OK', 'ZERO_RESULTS'].includes(j.status))) throw new Error(JSON.stringify(j.error || j.status).slice(0, 160));
  return j;
}

const places = (path, body, mask) => getJSON(`https://places.googleapis.com/v1/places:${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY(), 'X-Goog-FieldMask': mask },
  body: JSON.stringify(body),
});

const toPlace = (p) => (x) => {
  const loc = { lat: x.location.latitude, lng: x.location.longitude };
  return { name: x.displayName.text, address: x.formattedAddress, ...loc, distance_m: Math.round(distance(p, loc)) };
};

// ---------- public API ----------
const REL = { NEAR: 'near', WITHIN: 'inside', BESIDE: 'beside', ACROSS_THE_ROAD: 'across the road', DOWN_THE_ROAD: 'down the road', AROUND_THE_CORNER: 'around the corner', BEHIND: 'behind' };

export async function landmarks(p) {
  const j = await getJSON(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${p.lat},${p.lng}&extra_computations=ADDRESS_DESCRIPTORS&key=${KEY()}`);
  const ad = j.address_descriptor || {};
  return {
    landmarks: (ad.landmarks || []).map((l) => ({ name: l.display_name.text, relation: REL[l.spatial_relationship] || 'near', distance_m: Math.round(l.straight_line_distance_meters) })),
    areas: (ad.areas || []).map((a) => a.display_name.text),
  };
}

export async function nearby(p, radius = 150) {
  const j = await places('searchNearby', {
    maxResultCount: 15, rankPreference: 'DISTANCE',
    locationRestriction: { circle: { center: { latitude: p.lat, longitude: p.lng }, radius } },
  }, 'places.displayName,places.location,places.formattedAddress');
  return (j.places || []).map(toPlace(p));
}

export async function findPlace(query, near, radius = 1500) {
  const j = await places('searchText', {
    textQuery: query, maxResultCount: 5,
    locationBias: { circle: { center: { latitude: near.lat, longitude: near.lng }, radius } },
  }, 'places.displayName,places.location,places.formattedAddress');
  return (j.places || []).map(toPlace(near));
}

export async function streetAt(p) {
  const j = await getJSON(`https://maps.googleapis.com/maps/api/geocode/json?latlng=${p.lat},${p.lng}&key=${KEY()}`);
  const parts = (j.results || [])[0]?.address_components || [];
  const get = (t) => parts.find((c) => c.types.includes(t))?.long_name;
  return { street: get('route') || null, area: [get('sublocality_level_2'), get('sublocality_level_1')].filter(Boolean).join(', '), pincode: get('postal_code') || null };
}

export async function route(from, to) {
  const j = await getJSON('https://routes.googleapis.com/directions/v2:computeRoutes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', 'X-Goog-Api-Key': KEY(),
      'X-Goog-FieldMask': 'routes.distanceMeters,routes.polyline.encodedPolyline,routes.legs.steps.distanceMeters,routes.legs.steps.navigationInstruction,routes.legs.steps.startLocation,routes.legs.steps.endLocation',
    },
    body: JSON.stringify({
      origin: { location: { latLng: { latitude: from.lat, longitude: from.lng } } },
      destination: { location: { latLng: { latitude: to.lat, longitude: to.lng } } },
      travelMode: 'TWO_WHEELER', languageCode: 'en-IN', units: 'METRIC',
    }),
  });
  const r = (j.routes || [])[0];
  if (!r) throw new Error('no route');
  const ll = (l) => ({ lat: l.latLng.latitude, lng: l.latLng.longitude });
  return {
    distance_m: r.distanceMeters,
    polyline: r.polyline.encodedPolyline,
    steps: r.legs[0].steps.map((s) => ({
      text: (s.navigationInstruction?.instructions || 'Continue').replace(/\n/g, '. '),
      maneuver: s.navigationInstruction?.maneuver || 'STRAIGHT',
      distance_m: s.distanceMeters, start: ll(s.startLocation), end: ll(s.endLocation),
    })),
  };
}

// Google encoded polyline -> [{lat,lng}]
export function decodePolyline(s) {
  const pts = []; let i = 0, lat = 0, lng = 0;
  while (i < s.length) {
    for (const k of [0, 1]) {
      let b, shift = 0, res = 0;
      do { b = s.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    pts.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return pts;
}
