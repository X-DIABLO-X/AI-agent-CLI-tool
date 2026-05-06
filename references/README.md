# References folder

Drop screenshots of the website you want to clone into this folder
(e.g. `scaler-hero.png`, `scaler-footer.png`, `scaler-courses.png`).

When you start the agent and ask it to clone a site, it will:

1. Run `listFiles { path: "references" }` to see the screenshots.
2. Call `analyzeImage { path: "references/<file>" }` on each one — a vision
   model returns a description of the layout, colors, fonts, and components.
3. Optionally call `fetchUrl { url: "<the live site>" }` for additional
   structural data (palette, section count, nav labels).

The agent uses this information ONLY for the visual design (colors, layout,
component shapes). All placeholder text it writes into the generated site is
its own original copy — no headlines, taglines, or paragraphs from the
original site are copied or lightly reworded.

Supported image types: `.png`, `.jpg`, `.jpeg`, `.webp`, `.gif`.
