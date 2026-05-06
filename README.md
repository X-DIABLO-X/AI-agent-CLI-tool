# AI Agent CLI Tool

A conversational CLI agent — in the style of Cursor / Windsurf — that runs in your terminal, reasons step by step through an `INPUT → THINK → TOOL → OBSERVE → OUTPUT` loop, calls real tools, and writes real files on disk.

Out of the box it can clone a **Scaler Academy–style landing page** (Header, Hero, Footer) into a folder you can open directly in the browser.

---

## Features

- **Chat-style CLI** — type natural-language instructions and keep the conversation going.
- **Reasoning loop** — the model produces explicit `START`, `THINK`, `TOOL`, `OBSERVE`, `OUTPUT` steps. You see every step it takes.
- **Tool use** — the agent can create folders, write/read files, list directories, and run shell commands.
- **Sandboxed paths** — file operations are restricted to the project working directory.
- **Strict JSON protocol** — the model is forced into `response_format: json_object` and the loop validates / repairs malformed replies.
- **Cross-platform** — works on Windows (PowerShell), macOS, and Linux.

---

## Project Structure

```
.
├── index.js          # CLI entry point + agent loop
├── tools.js          # Tool implementations (createFolder, writeFile, readFile, listFiles, executeCommand)
├── prompt.js         # System prompt with the website-cloning playbook
├── package.json
├── .env.example
├── .gitignore
└── README.md
```

When the agent runs, it will create additional folders like `scaler_clone/` containing the generated site.

---

## Prerequisites

- **Node.js 18 or newer** (uses native `fetch`-style ESM and `node:` prefixed modules).
- An **OpenAI API key** with access to a chat model (default: `gpt-4.1-mini`).

---

## Setup

```bash
git clone <your-fork-url>
cd AI-agent-CLI-tool

npm install

cp .env.example .env       # On Windows PowerShell:  Copy-Item .env.example .env
# then open .env and paste your OPENAI_API_KEY
```

`.env` example:

```
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4.1-mini
```

---

## Run

```bash
npm start
```

You will see a banner and a `you >` prompt. Type your instruction and press Enter.

---

## Example: clone the Scaler Academy site

At the `you >` prompt, type:

```
Clone the Scaler Academy website into a folder named scaler_clone. It must include a header, a hero section, and a footer, written in HTML, CSS and JavaScript.
```

The agent will:

1. Print `[START]` describing what you asked.
2. Print several `[THINK]` steps planning the project.
3. Call `createFolder` → `writeFile` (`index.html`) → `writeFile` (`styles.css`) → `writeFile` (`script.js`) → `listFiles`.
4. Print `[OBS  ]` after each tool call (the actual result).
5. Finish with a `[FINAL]` message telling you how to open the site.

Then open the generated page in your browser:

- Windows: `start scaler_clone\index.html`
- macOS:   `open scaler_clone/index.html`
- Linux:   `xdg-open scaler_clone/index.html`

---

## Other things you can ask it to do

The same agent is general-purpose. Examples:

- `Create a folder called todo_app and build a simple todo app with HTML, CSS and JS inside it.`
- `Read package.json and tell me what dependencies are installed.`
- `List the files in the current directory.`
- `Make a new file notes.md with a short summary of this project.`

Type `exit`, `quit`, or `:q` to leave.

---

## How the agent loop works

Each turn the agent must reply with **exactly one JSON object** of the form:

```json
{
  "step": "START | THINK | TOOL | OBSERVE | OUTPUT",
  "content": "string",
  "tool_name": "string",
  "tool_args": { "...": "..." }
}
```

- `START` — restates what the user asked.
- `THINK` — internal reasoning. The agent is required to do **at least two** THINK steps before any tool call.
- `TOOL` — the agent picks a tool and provides arguments. The CLI runs that tool.
- `OBSERVE` — the CLI feeds the tool's real return value back to the model as a developer/user message.
- `OUTPUT` — final answer to the user. Loop ends until the user types again.

If the model ever returns malformed JSON, the loop sends back a polite OBSERVE asking it to retry in the right schema, instead of crashing.

---

## Available tools


| Tool             | Purpose                                                             | Args                  |
| ---------------- | ------------------------------------------------------------------- | --------------------- |
| `createFolder`   | Create a folder (recursive).                                        | `{ path }`            |
| `writeFile`      | Create / overwrite a UTF-8 file.                                    | `{ path, content }`   |
| `readFile`       | Read a UTF-8 file (truncated to 4 KB).                              | `{ path }`            |
| `listFiles`      | List entries in a directory.                                        | `{ path }`            |
| `executeCommand` | Run a shell command in the project root.                            | `{ cmd }`             |
| `fetchUrl`       | Fetch a public webpage and return a structural design summary.      | `{ url }`             |
| `analyzeImage`   | Send a local screenshot to a vision model and get a layout summary. | `{ path, question? }` |


All filesystem paths are resolved against the project root and rejected if they try to escape it. `executeCommand` blocks a small list of obviously destructive commands (`rm -rf /`, `format`, `shutdown`, …) and applies a 60-second timeout.

### How `fetchUrl` and `analyzeImage` are used

When you ask the agent to clone a site, it now does a **reference-gathering phase** before writing any code:

1. `listFiles { path: "references" }` — checks if you've added any screenshots.
2. For each screenshot, `analyzeImage { path: "references/<file>" }` — a vision model returns a structured description of the layout, colors, fonts, and components.
3. `fetchUrl { url: "<live site>" }` — pulls the live page and returns a JSON summary: `{ title, headings, sectionCount, colors, fonts, buttonLabels, navLinks }`.

The agent then uses this **only for visual design** (palette, layout, section types, button shapes). It is explicitly instructed to write its **own original** placeholder copy — no headlines, taglines or paragraphs are copied from the source, and "minor substitution" rewrites are not allowed. Hex colors and font-family names (which are factual design tokens, not copyrightable) are reused so the clone looks visually accurate.

### Higher-fidelity Scaler clone workflow

```powershell
# 1. (optional) drop 1-3 screenshots into the references folder
#    e.g. references\scaler-hero.png, references\scaler-footer.png

# 2. (recommended) bump the model for layout-heavy work
#    edit .env -> OPENAI_MODEL=gpt-4.1

# 3. run the agent
npm start

# 4. at the prompt:
#    > Clone the Scaler Academy site (https://www.scaler.com/) into scaler_clone.
#    >  Use the screenshots in references/ and the live URL to match the design.

# 5. open the result
start scaler_clone\index.html
```

---

## Notes on the generated Scaler-style page

The output is an **original** landing page that visually resembles the Scaler website's structure (dark blue header, vivid accent CTAs, hero with headline + sub-headline + buttons, footer with link columns). It uses:

- Placeholder copy written by the model.
- CSS-drawn / emoji visuals so the site works fully **offline** with no external image or font dependencies.
- Plain HTML + CSS + a small JS file — open `index.html` directly in any modern browser.

No proprietary Scaler text, images, or source code is reproduced.

---

## License

ISC