// Bengaluru: HSR Layout and its edges (Agara, the Outer Ring Road at Silk Board's end, Mangammanapalya), from
// OpenStreetMap. The area around ToTheDoor's demo home.
export default {
  id: 'bengaluru',
  name: 'Bengaluru',
  short: 'BLR',
  origin: { lat: 12.9128, lon: 77.6374, label: 'HSR Layout Sector 6' },
  bearing: 'auto', // HSR's sectors are laid out on a grid a few degrees off north; the frame turns to it
  detail: [12.9020, 77.6260, 12.9240, 77.6500], // south, west, north, east (about 2.6 km x 2.4 km)
  margin: 0.003,
  sidewalk: 2.5, // Indian footpaths are narrow, often just the drain cover
  strip: 6,
  driveSide: 'left',
  // HSR is almost all independent houses of 2 to 4 floors, shops along the main roads, a few apartment blocks and
  // offices along the Outer Ring Road
  districts: [
    { name: 'HSR Layout Sector 6', at: [12.9128, 77.6374], r: 700, style: 'lowrise' },
    { name: 'HSR Layout Sector 7', at: [12.9095, 77.6450], r: 600, style: 'lowrise' },
    { name: 'HSR Layout Sector 2', at: [12.9200, 77.6430], r: 600, style: 'lowrise' },
    { name: 'Agara', at: [12.9220, 77.6300], r: 500, style: 'midrise' },
    { name: 'Outer Ring Road', at: [12.9180, 77.6330], r: 350, style: 'offices' },
    { name: 'Mangammanapalya', at: [12.9050, 77.6300], r: 500, style: 'shophouses' }
  ],
  places: [
    { id: 'home', name: "Sam's home", sub: 'HSR Layout Sector 6', at: [12.9128, 77.6374] },
    { id: 'bda', name: 'BDA Complex', sub: 'HSR Layout', at: [12.9137, 77.6373] },
    { id: 'agara', name: 'Agara Junction', sub: 'Outer Ring Road', at: [12.9234, 77.6386] },
    { id: 'club', name: 'HSR Club', sub: 'Sector 2', at: [12.9150, 77.6430] }
  ],
  // no public tree inventory for Bengaluru: tools/city/gen-trees.mjs plants avenue and park trees from OpenStreetMap
  trees: {
    source: 'generated',
    credit: 'Trees planted along OpenStreetMap streets and parks',
    shape: 'evergreen',
    shapes: { 'Fabaceae (Leguminosae)': 'raintree', Bignoniaceae: 'weeping', 'Arecaceae (Palmae)': 'palm', Moraceae: 'evergreen' }
  },
  // white and silver cars, yellow-green autos as taxis, BMTC's blue buses, white plates with black letters
  vehicles: {
    taxis: [0xf2f2ee, 0xf2f2ee, 0xc9cdd2, 0xc9cdd2, 0x2b2d31, 0x7a1e1e, 0x1f3d6b, 0xd9d4c7, 0xf2c200],
    taxiBadge: null,
    taxiLettering: 0x111111,
    taxiMedallion: false,
    plate: { front: 0xf4f4f0, bg: '#f4f4f0', ink: '#111111', labels: ['KA 01 MK 4721', 'KA 51 AB 3180', 'KA 03 HX 5062', 'KA 05 MZ 8420'] },
    playerTaxi: {
      door: { bg: '#f2c200', ink: '#111111', emblem: '', title: 'Auto', lines: ['KA 01 C 7948'] },
      plate: { bg: '#f2c200', ink: '#111111', top: '', number: 'KA 01 C 7948', bottom: '' }
    },
    bus: { body: 0x2f5fa8, stripe: 0x1d3c78, ribbon: 0xd8e4f6, skirt: 0x1c2026, route: '500D', routeBadge: '#1c1c1c', destination: 'SILK BOARD' },
    labels: { car: 'Car', cyclist: 'Cyclist' }
  },
  landmarks: [],
  labels: [
    { name: 'HSR LAYOUT', at: [12.9128, 77.6400], kind: 2 },
    { name: 'AGARA LAKE', at: [12.9235, 77.6440], kind: 1 },
    { name: 'OUTER RING ROAD', at: [12.9180, 77.6330], kind: 0 }
  ]
};
