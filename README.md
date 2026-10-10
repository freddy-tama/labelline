# LabelLine

A pesticide label is the law, and its water buffers depend on how the product is applied. LabelLine reads an EPA label PDF, pulls out each restriction (distance buffers, wind limits, filter strips) with the exact sentence and page it came from, and checks every quote against the PDF's own text before the applicator confirms it. The applicator draws the field on an aerial map; LabelLine loads federally mapped water, lets the applicator add water the maps miss, and draws each confirmed buffer for the chosen application method. It reports the acres outside the buffers drawn so far and produces a printable screening record.

**Status:** in progress during CodeRED: Orion (Environment track).

**Timeline:** Planning, research and the build spec (hackathon/) were written before the hacking window; all application code was written from 2026-10-10 1:00 PM CDT.

## Run it locally

```bash
npm install
cp .env.example .env   # add GEMINI_API_KEY; it is read only by the server
npm run dev            # app + /api/* handlers on http://localhost:5173
npm test
```

## Data sources and credits

- **Pesticide labels:** U.S. EPA Pesticide Product Label System (PPLS). The sample labels in `public/demo/labels/` are real archived EPA label PDFs; `manifest.json` lists each source URL and retrieval date.
- **Mapped water:** U.S. Geological Survey, National Hydrography Dataset (NHD) flowlines and waterbodies. NHD was retired in October 2023 and is no longer maintained.
- **Wetlands:** U.S. Fish and Wildlife Service, National Wetlands Inventory (NWI). NWI excludes farmed wetlands.
- **Aerial imagery:** Esri World Imagery (Powered by Esri).
- **Weather:** Weather data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0).

Mapped layers are incomplete, which is why the applicator can add observed water.

## Not a legal determination

LabelLine is a screening aid. It does not decide whether an application is legal or permitted. The label and the applicator's judgment govern; wind is a forecast screen only and must be measured on site.

## License

MIT. See [LICENSE](LICENSE).
