# city/

The 3D city behind ToTheDoor's live map: real streets, buildings, lakes and trees from OpenStreetMap, drawn with three.js (WebGPU) through the day and night. The dashboard shows it in an iframe at `/map3d/` and drives it through `js/ttd-bridge.js` (home, door path, rider, camera, time of day).

## Build a city

Describe the area in `tools/city/cities/<id>.mjs` (bounding box, origin, driving side, neighbourhoods, places), then:

```sh
node tools/city/fetch.mjs <id>                               # OpenStreetMap layers from Overpass
node tools/city/gen-trees.mjs <id>                           # avenue and park trees
node --max-old-space-size=8192 tools/city/build.mjs <id>     # writes js/<id>-geodata.js
```

Open `/map3d/?city=<id>`. Bengaluru (HSR Layout) is built and is the default.
