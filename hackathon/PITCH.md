# PITCH: LabelLine (locked 2026-10-11 00:40 UTC+8)

**Chosen by the Idea Forge.** 39 ideas from 6 dreamers (4 Claude, 2 GPT-6.1-Sol) plus 3 cross-pollinated hybrids went through a realist screen, two blind critics (Claude and Sol) and one repair round. In the round-robin tournament (2 Claude and 2 Sol judges, each pair shown in both orders):

| Idea | Win rate | Claude judges | Sol judges |
|---|---|---|---|
| **LabelLine** | **0.88** | 0.88 | 0.88 |
| The Tree in the Glass | 0.50 | | |
| SiltCheck | 0.44 | | |
| FillWatch | 0.44 | | |
| Casings In, Casings Out | 0.25 | | |

There were no position flips. The full record is in the scratchpad: `codered/forge/result.json`.

## One line
The pesticide label is the law. LabelLine reads it and draws it: every "do not apply within X feet of water" sentence becomes a buffer on your actual field.

## User and moment
5:30 AM on a rice or cotton field on the Texas Gulf Coast. A commercial applicator licensed by the Texas Department of Agriculture is about to spray a pyrethroid by air on a field next to a bayou. Under FIFRA, the label is the law, and its buffers depend on the application method. Typical values in EPA's 2015 pyrethroid drift language are 25 ft for ground, 150 ft for non-ULV aerial and 450 ft for ULV aerial, plus a 10-ft vegetative filter strip; they vary by label. A misread 20-page label means fish kills and drift complaints. The applicator still makes the call; LabelLine makes sure the label's distances were read correctly and drawn in the right place.

## Before → after
**Before:** the applicator reads a 20-plus-page PDF, remembers "150 ft", and estimates distances by eye. Small ditches and ponds that federal maps miss go unnoticed.

**After:** every restriction sits on the map with its source sentence highlighted. The buffers are drawn around mapped water and around water the applicator marked. The acres outside the buffers are computed, and a screening record shows what still needs checking on site.

## What a judge sees (illustrative values; demo labels are real archived EPA labels)
1. **Upload:** a pyrethroid label PDF goes in. Yellow highlights appear on its buffer sentences, for example "Do not apply within 150 feet of aquatic habitats" (aerial), each with a page number and ✓ "quote found in PDF".
2. **Field:** the applicator draws an 80-acre sample field. The creek from USGS NHD glows ("mapped"), and a red 150-ft buffer carves off N acres.
3. **Pond:** they tap a farm pond the federal map missed. A second buffer appears and the acreage drops.
4. **Method:** switching from aerial to ground redraws every buffer at 25 ft.
5. **Wind:** a wind strip screens the forecast against the label's wind limit.
6. **Checklist:** the header reads "Screening incomplete" (Bulletins Live! Two not checked, on-site wind not recorded) until each item is confirmed. Export gives a printable screening record.

## Wow
Text becomes geometry. The highlighted sentence on the PDF and the red buffer it creates sit side by side, and switching aerial to ground redraws every buffer live.

## Core loop
1. Upload the label PDF. Gemini extracts each restriction as structured data: type, distance, method, protected feature, weather limit, verbatim quote and page.
2. Each quote is verified against the PDF text layer, highlighted, and confirmed by the user.
3. The user draws the field. NHD and NWI features are fetched for the area and marked "mapped (incomplete)"; the user can add water they observed.
4. turf.js buffers the features by method and subtracts them from the field to give the acreage. Open-Meteo wind is screened against the label's limits.
5. The checklist state machine controls the export of the screening record.

## Removal test (why Gemini)
Labels are long PDFs with inconsistent wording, multi-column layouts and crop-specific tables. Gemini's long-context reading with structured output turns the free text into checkable restrictions.

Without Gemini, the product doesn't exist. A regex misses phrasing variants and method-specific exceptions.

**Trust:** every quote is verified against the PDF before it can draw a buffer. All geometry is computed in tested code.

## Data
- **Labels:** real label PDFs from EPA's Pesticide Product Label System.
- **Answer key:** EPA's 2015 pyrethroid spray drift letter and the Minnesota Department of Agriculture's setback summary, used to hand-check the extractions.
- **Water features:** USGS NHD and USFWS NWI.
- **Weather:** Open-Meteo.
- **Link-outs:** EPA Bulletins Live! Two and the Spray Drift Calculator.
- **Demo field:** a labelled sample location.

## Gap and wedge
- **US tools don't read the label.** EPA's Spray Drift Calculator and PALM start from a buffer distance the applicator has already read and typed in. Bulletins Live! Two covers endangered-species limits, not label drift buffers. FieldWatch maps sensitive sites.
- **Germany has structured data, the US doesn't.** Germany's Pesticide-Application-Manager uses structured authorisation codes. US labels hold the same rules as free text in each PDF.
- **LabelLine is the step before EPA's tools:** label sentence → verified distance → geometry on the field.

The pre-build research workflow is checking this.

## Criteria fit
| Criterion | How LabelLine scores |
|---|---|
| Originality | Label text becomes field geometry, a step no US tool does |
| Relevance (Environment) | Pesticide drift into water, aquatic life, pollinators |
| Impact | Every US label carries these restrictions; around 1M+ certified applicators (number to verify) |
| Demo | Deterministic geometry plus a cached replay of the extraction |
| Technical | Quote verification, unit-tested geometry, and a measured extraction eval on real labels |

## Honesty boundaries (fixed)
- No "legal go/no-go" and no "legally sprayable acres". The tool reports "acres outside buffers drawn so far" and is a screening record.
- Wind is a forecast screen only.
- Mapped layers are labelled incomplete.
- Sample locations and data are labelled as such.

## Biggest risks and first de-risking spikes
1. **CORS or reliability of the NHD/NWI endpoints.** Research is probing them now; the fallback is a serverless proxy plus a cached GeoJSON for the demo field.
2. **Gemini's extraction recall on real labels.** Spike in hour 1: run 2 labels against the answer key.
3. **Remote demo format.** The user is asking the organisers.
