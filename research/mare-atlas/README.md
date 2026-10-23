# Mare — Roman setting atlas

Standalone, buildless setting-research explorer for BoatSim. No gameplay files are modified.

Serve `dist/` with any static HTTP server. Main files: `dist/index.html`, `dist/style.css`, `dist/app.js`, `dist/data.js`. History and fictional premises are separated in the inspector. Sources and qualifications are included in the application.

Seven snapshots (39 BCE, 60, 69, 117, 207, 268, 293 CE), eleven locations, three navigational regions, five character profiles, Sumerian Gulf comparison, shortlist with browser-local persistence and Markdown export, adjustable 40–500 km study diameters, and real modern elevation preview.

Geography uses bundled public-domain Natural Earth 1:10 million modern land polygons. This is cartographic scale, not 10-metre resolution. Optional relief streams Terrarium elevation tiles from Mapzen/AWS. The custom protocol clamps elevations below sea level to zero before terrain rendering, to avoid presenting seabed relief as a deformed sea surface. No bathymetry or ancient harbor reconstruction is claimed. Connections are illustrative design references, not historical routes or navigation instructions.

MapLibre GL JS 4.7.1 is bundled. Flat map and research work without third-party tile requests. WebGL is required for map rendering; the inspector remains accessible when it is unavailable. Shortlists are local to a browser/origin and do not sync across devices.

QA: JavaScript syntax checks passed. Desktop browser inspection at narrow and wider widths; manually verified period change, region filtering, location selection, character ordering, real 3D terrain, live radius/sailing estimate changes, shortlist contents and persistence after reload. Browser console showed no errors or warnings in the tested flat and relief states. Mobile CSS provided; phone emulation was not available in the test interface. Download button invoked in browser; the downloaded file was not independently retrieved.
