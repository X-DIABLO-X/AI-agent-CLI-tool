import { exec } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import axios from "axios";
import { load } from "cheerio";
import { createGroqChatCompletion, hasGroqApiKeys } from "./groq.js";

const execAsync = promisify(exec);

const ROOT = process.cwd();
const DEFAULT_VISION_MODEL =
  process.env.GROQ_VISION_MODEL ||
  "meta-llama/llama-4-scout-17b-16e-instruct";
const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (compatible; AI-Agent-CLI/1.0; +https://example.local)",
  Accept: "text/html,application/xhtml+xml,text/css,*/*",
};

function resolveSafe(relPath = "") {
  const target = path.resolve(ROOT, relPath);
  if (!target.startsWith(ROOT)) {
    throw new Error(
      `Path "${relPath}" escapes the working directory and is not allowed.`
    );
  }
  return target;
}

function parseArgs(args) {
  if (args && typeof args === "object") return args;
  if (typeof args === "string") {
    const trimmed = args.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        return JSON.parse(trimmed);
      } catch (_) {}
    }
    return { value: args };
  }
  return {};
}

async function createFolder(args) {
  const a = parseArgs(args);
  const folderPath = a.path || a.folder || a.name || a.value;
  if (!folderPath) return "Error: 'path' is required.";
  const target = resolveSafe(folderPath);
  await fs.mkdir(target, { recursive: true });
  return `Created folder: ${path.relative(ROOT, target) || "."}`;
}

async function writeFile(args) {
  const a = parseArgs(args);
  const filePath = a.path || a.file;
  const content = a.content ?? a.body ?? "";
  if (!filePath) return "Error: 'path' is required.";
  const target = resolveSafe(filePath);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, content, "utf8");
  const bytes = Buffer.byteLength(content, "utf8");
  return `Wrote ${bytes} bytes to ${path.relative(ROOT, target)}`;
}

async function readFile(args) {
  const a = parseArgs(args);
  const filePath = a.path || a.file || a.value;
  if (!filePath) return "Error: 'path' is required.";
  const target = resolveSafe(filePath);
  const data = await fs.readFile(target, "utf8");
  if (data.length > 4000) {
    return data.slice(0, 4000) + `\n... [truncated ${data.length - 4000} chars]`;
  }
  return data;
}

async function listFiles(args) {
  const a = parseArgs(args);
  const dir = a.path || a.dir || a.value || ".";
  const target = resolveSafe(dir);
  const entries = await fs.readdir(target, { withFileTypes: true });
  return entries
    .map((e) => `${e.isDirectory() ? "[DIR] " : "      "}${e.name}`)
    .join("\n");
}

async function executeCommand(args) {
  const a = parseArgs(args);
  const cmd = a.cmd || a.command || a.value;
  if (!cmd) return "Error: 'cmd' is required.";

  const lowered = String(cmd).toLowerCase();
  const banned = [
    "rm -rf /",
    "rm -rf ~",
    "format ",
    "shutdown",
    "mkfs",
    ":(){:|:&};:",
    "del /f /s /q c:\\",
  ];
  if (banned.some((b) => lowered.includes(b))) {
    return `Refused to run dangerous command: ${cmd}`;
  }

  try {
    const { stdout, stderr } = await execAsync(cmd, {
      cwd: ROOT,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
      shell: os.platform() === "win32" ? "powershell.exe" : "/bin/sh",
    });
    const out = (stdout || "") + (stderr ? `\n[stderr]\n${stderr}` : "");
    return out.trim() ? out.slice(0, 4000) : `Command finished: ${cmd}`;
  } catch (err) {
    return `Command failed: ${err.message.slice(0, 600)}`;
  }
}

function extractDesignSummary(html, baseUrl) {
  const $ = load(html);
  const summary = {
    title: "",
    headings: [],
    sectionCount: 0,
    colors: [],
    fonts: [],
    buttonLabels: [],
    navLinks: [],
    metaDescription: "",
    sourceUrl: baseUrl,
  };

  const pageTitle = $("title").first().text().trim();
  if (pageTitle) summary.title = pageTitle.slice(0, 160);

  const metaDescription = $('meta[name="description"]').attr("content") || "";
  if (metaDescription) summary.metaDescription = metaDescription.slice(0, 200);

  summary.headings = $("h1, h2, h3")
    .slice(0, 20)
    .toArray()
    .map((el) => {
      const tag = el.tagName.toLowerCase();
      const text = $(el).text().replace(/\s+/g, " ").trim().slice(0, 80);
      return `${tag}: ${text}`;
    })
    .filter((s) => s.length > 4);

  summary.sectionCount = (html.match(/<section\b/gi) || []).length;

  const colorRegex = /#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b|rgba?\([^)]+\)/g;
  const colorSet = new Set();
  for (const m of html.matchAll(colorRegex)) {
    colorSet.add(m[0].toLowerCase());
    if (colorSet.size >= 25) break;
  }
  summary.colors = [...colorSet];

  const fontRegex = /font-family\s*:\s*([^;"}<]+)/gi;
  const fontSet = new Set();
  for (const m of html.matchAll(fontRegex)) {
    fontSet.add(m[1].trim().replace(/['"]/g, "").slice(0, 80));
    if (fontSet.size >= 6) break;
  }
  summary.fonts = [...fontSet];

  const btnRegex =
    /<(?:button|a)[^>]*class=["'][^"']*(btn|button|cta)[^"']*["'][^>]*>([\s\S]*?)<\/(?:button|a)>/gi;
  const btnSet = new Set();
  for (const m of html.matchAll(btnRegex)) {
    const txt = m[2].replace(/<[^>]+>/g, "").trim();
    if (txt && txt.length < 40) btnSet.add(txt);
    if (btnSet.size >= 10) break;
  }
  summary.buttonLabels = [...btnSet];

  const navMatch = html.match(/<nav[\s\S]*?<\/nav>/i);
  if (navMatch) {
    const linkSet = new Set();
    for (const m of navMatch[0].matchAll(/<a[^>]*>([\s\S]*?)<\/a>/gi)) {
      const txt = m[1].replace(/<[^>]+>/g, "").trim();
      if (txt && txt.length < 30) linkSet.add(txt);
      if (linkSet.size >= 10) break;
    }
    summary.navLinks = [...linkSet];
  }

  return summary;
}

async function fetchTextResource(url) {
  const { data } = await axios.get(url, {
    timeout: 20_000,
    maxContentLength: 5 * 1024 * 1024,
    headers: DEFAULT_HEADERS,
    responseType: "text",
  });
  return String(data);
}

async function renderPageHtml(url) {
  const puppeteer = await import("puppeteer");
  const browser = await puppeteer.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1024 });
    await page.goto(url, { waitUntil: "networkidle2", timeout: 45000 });

    // Give client-side rendering time to replace skeleton/loading states.
    await new Promise((resolve) => setTimeout(resolve, 5000));

    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let totalHeight = 0;
        const distance = 700;
        const timer = setInterval(() => {
          const scrollHeight = document.body.scrollHeight;
          window.scrollBy(0, distance);
          totalHeight += distance;
          if (totalHeight >= scrollHeight - window.innerHeight) {
            clearInterval(timer);
            window.scrollTo(0, 0);
            resolve();
          }
        }, 120);
      });
    });

    await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 }).catch(
      () => undefined
    );
    await new Promise((resolve) => setTimeout(resolve, 5000));

    return await page.content();
  } finally {
    await browser.close();
  }
}

function absoluteUrl(maybeUrl, baseUrl) {
  try {
    return new URL(maybeUrl, baseUrl).toString();
  } catch {
    return null;
  }
}

function rewriteSrcset(value, baseUrl) {
  return value
    .split(",")
    .map((part) => {
      const pieces = part.trim().split(/\s+/);
      const url = pieces.shift();
      if (!url) return part;
      return [absoluteUrl(url, baseUrl) || url, ...pieces].join(" ");
    })
    .join(", ");
}

function sanitizeCloneHtml(html, sourceUrl) {
  const $ = load(html, { decodeEntities: false });

  $("base").remove();
  $("script").remove();
  $("link[rel='preload'][as='script'], link[rel='modulepreload'], link[rel='prefetch']").remove();

  $("[onload], [onclick], [onerror], [onmouseover], [onmouseenter], [onmouseleave]").each(
    (_, el) => {
      const node = $(el);
      for (const attr of [
        "onload",
        "onclick",
        "onerror",
        "onmouseover",
        "onmouseenter",
        "onmouseleave",
      ]) {
        node.removeAttr(attr);
      }
    }
  );

  $("[src], [href], [poster], [action]").each((_, el) => {
    const node = $(el);
    for (const attr of ["src", "href", "poster", "action"]) {
      const value = node.attr(attr);
      if (value) {
        node.attr(attr, absoluteUrl(value, sourceUrl) || value);
      }
    }
  });

  $("[srcset]").each((_, el) => {
    const node = $(el);
    const value = node.attr("srcset");
    if (value) {
      node.attr("srcset", rewriteSrcset(value, sourceUrl));
    }
  });

  return $.html();
}

function injectCloneMetadata(html, sourceUrl) {
  return [
    "<!--",
    "  Generated by AI Agent CLI static clone mode.",
    `  Source: ${sourceUrl}`,
    "  Source-site scripts were stripped so the page can be previewed locally more safely.",
    "-->",
    "",
    html,
  ].join("\n");
}

function extractThemeFromCss(cssText) {
  const cssVars = [...cssText.matchAll(/--([a-zA-Z0-9\-_]+)\s*:\s*([^;}{]+)/g)]
    .slice(0, 30)
    .map((m) => `--${m[1]}: ${m[2].trim()}`);
  const colors = [...new Set(
    [...cssText.matchAll(/#([0-9a-fA-F]{3,8})\b|rgba?\([^)]+\)|hsla?\([^)]+\)/g)]
      .map((m) => m[0].toLowerCase())
      .slice(0, 25)
  )];
  const fonts = [...new Set(
    [...cssText.matchAll(/font-family\s*:\s*([^;}{]+)/gi)]
      .map((m) => m[1].replace(/['"]/g, "").trim())
      .slice(0, 10)
  )];

  return { cssVars, colors, fonts };
}

async function fetchUrl(args) {
  const a = parseArgs(args);
  const url = a.url || a.value;
  if (!url) return "Error: 'url' is required.";
  if (!/^https?:\/\//i.test(url)) {
    return "Error: only http(s) URLs are allowed.";
  }
  try {
    const data = await fetchTextResource(url);
    const summary = extractDesignSummary(data, url);
    return JSON.stringify(
      {
        note:
          "Use this only as STRUCTURAL inspiration (palette, layout, section types). Do NOT verbatim copy headings, taglines, or paragraphs into your generated site - write your own original placeholder copy.",
        ...summary,
      },
      null,
      2
    );
  } catch (err) {
    return `fetchUrl failed: ${err.message.slice(0, 300)}`;
  }
}

async function fetchPageHtml(args) {
  const a = parseArgs(args);
  const url = a.url || a.value;
  if (!url) return "Error: 'url' is required.";
  if (!/^https?:\/\//i.test(url)) {
    return "Error: only http(s) URLs are allowed.";
  }
  try {
    const html = await fetchTextResource(url);
    return html.slice(0, 12000);
  } catch (err) {
    return `fetchPageHtml failed: ${err.message.slice(0, 300)}`;
  }
}

async function fetchStylesheet(args) {
  const a = parseArgs(args);
  const url = a.url || a.value;
  if (!url) return "Error: 'url' is required.";
  if (!/^https?:\/\//i.test(url)) {
    return "Error: only http(s) URLs are allowed.";
  }
  try {
    const css = await fetchTextResource(url);
    return css.slice(0, 12000);
  } catch (err) {
    return `fetchStylesheet failed: ${err.message.slice(0, 300)}`;
  }
}

async function scrapeSite(args) {
  const a = parseArgs(args);
  const url = a.url || a.value;
  if (!url) return "Error: 'url' is required.";
  if (!/^https?:\/\//i.test(url)) {
    return "Error: only http(s) URLs are allowed.";
  }

  try {
    const html = await renderPageHtml(url);
    const $ = load(html);
    const structural = extractDesignSummary(html, url);
    const saveClone = a.saveClone !== false;
    const targetFolder =
      a.targetFolder || a.outputFolder || a.path || a.folder || "cloned-site";
    const stylesheets = $('link[rel="stylesheet"]')
      .slice(0, 5)
      .toArray()
      .map((el) => absoluteUrl($(el).attr("href"), url))
      .filter(Boolean);
    const inlineStyleBlocks = $("style")
      .slice(0, 3)
      .toArray()
      .map((el) => $(el).html() || "")
      .filter(Boolean);
    const cssSamples = [];

    for (const href of stylesheets.slice(0, 3)) {
      try {
        const css = await fetchTextResource(href);
        cssSamples.push({
          url: href,
          preview: css.slice(0, 2000),
          ...extractThemeFromCss(css),
        });
      } catch {}
    }

    const inlineTheme = extractThemeFromCss(inlineStyleBlocks.join("\n"));
    const classes = [...new Set(
      $("[class]")
        .slice(0, 120)
        .toArray()
        .flatMap((el) => String($(el).attr("class") || "").split(/\s+/))
        .map((s) => s.trim())
        .filter(Boolean)
    )].slice(0, 60);
    let cloneHtmlPath = null;

    if (saveClone) {
      const cloneTarget = resolveSafe(
        path.posix.join(String(targetFolder).replace(/\\/g, "/"), "index.html")
      );
      await fs.mkdir(path.dirname(cloneTarget), { recursive: true });
      const staticCloneHtml = sanitizeCloneHtml(html, url);
      await fs.writeFile(
        cloneTarget,
        injectCloneMetadata(staticCloneHtml, url),
        "utf8"
      );
      cloneHtmlPath = path.relative(ROOT, cloneTarget).replace(/\\/g, "/");
    }

    return JSON.stringify(
      {
        note:
          "Use this scraped data to understand layout, theme tokens, class patterns, and CSS architecture. Do not copy proprietary text verbatim.",
        url,
        structural,
        stylesheets,
        inlineStylePreview: inlineStyleBlocks.join("\n").slice(0, 3000),
        inlineTheme,
        cssSamples,
        classes,
        artifacts: cloneHtmlPath ? { cloneHtmlPath } : {},
      },
      null,
      2
    );
  } catch (err) {
    return `scrapeSite failed: ${err.message.slice(0, 300)}`;
  }
}

async function analyzeImage(args) {
  const a = parseArgs(args);
  const filePath = a.path || a.file || a.value;
  const question =
    a.question ||
    "Describe this UI screenshot for a developer cloning the design: list the dominant colors (hex if possible), font style, layout structure (header/hero/sections/footer), button styles, and any key components. Be concise and structured.";
  if (!filePath) return "Error: 'path' is required.";
  if (!hasGroqApiKeys()) {
    return "analyzeImage failed: GROQ_API_KEYS or GROQ_API_KEY is not configured.";
  }
  const target = resolveSafe(filePath);
  let buf;
  try {
    buf = await fs.readFile(target);
  } catch (err) {
    return `Could not read image at ${filePath}: ${err.message}`;
  }

  const ext = path.extname(target).toLowerCase().replace(".", "") || "png";
  const mime =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "webp"
        ? "image/webp"
        : ext === "gif"
          ? "image/gif"
          : "image/png";
  const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;

  try {
    const preferredVisionModel =
      process.env.GROQ_VISION_MODEL ||
      process.env.OPENAI_VISION_MODEL ||
      DEFAULT_VISION_MODEL;
    const visionModels = [
      preferredVisionModel,
      DEFAULT_VISION_MODEL,
    ].filter((model, index, all) => model && all.indexOf(model) === index);

    let lastErr;
    for (const visionModel of visionModels) {
      try {
        const resp = await createGroqChatCompletion(
          {
            model: visionModel,
            messages: [
              {
                role: "user",
                content: [
                  { type: "text", text: question },
                  { type: "image_url", image_url: { url: dataUrl } },
                ],
              },
            ],
          },
          {
            maxRetries: 8,
          }
        );
        return (
          resp.choices[0].message.content?.slice(0, 1200) ||
          "(no description)"
        );
      } catch (err) {
        lastErr = err;
        const message = String(err?.message || "");
        const shouldRetryWithFallback =
          /decommissioned|no longer supported|model/i.test(message) &&
          visionModel !== DEFAULT_VISION_MODEL;
        if (!shouldRetryWithFallback) {
          throw err;
        }
      }
    }

    throw lastErr;
  } catch (err) {
    return `analyzeImage failed: ${err.message.slice(0, 300)}`;
  }
}

export const tools = [
  {
    name: "createFolder",
    description: "Create a new folder (recursive). args: { path: string }",
  },
  {
    name: "writeFile",
    description:
      "Create or overwrite a file with the given content. args: { path: string, content: string }",
  },
  {
    name: "readFile",
    description: "Read the contents of a text file. args: { path: string }",
  },
  {
    name: "listFiles",
    description:
      "List files and folders inside a directory. args: { path: string }",
  },
  {
    name: "executeCommand",
    description:
      "Run a shell command in the project root (PowerShell on Windows, sh on *nix). args: { cmd: string }",
  },
  {
    name: "fetchUrl",
    description:
      "Fetch a public web page and return a STRUCTURAL summary (title, headings, section count, color palette, fonts, button/nav labels). Use it for design INSPIRATION only - do not verbatim copy text. args: { url: string }",
  },
  {
    name: "scrapeSite",
    description:
      "Scrape a website and return structured design info, stylesheet URLs, theme hints, class patterns, and CSS samples. Use this first when a live reference URL is provided. args: { url: string }",
  },
  {
    name: "fetchPageHtml",
    description:
      "Fetch the raw HTML of a public webpage for structural inspection. args: { url: string }",
  },
  {
    name: "fetchStylesheet",
    description:
      "Fetch the raw CSS of a stylesheet URL for theme and component analysis. args: { url: string }",
  },
  {
    name: "analyzeImage",
    description:
      "Look at a local screenshot/image using a vision model and return a textual description of layout, colors, fonts, and components. args: { path: string, question?: string }",
  },
];

export const toolMap = {
  createFolder,
  writeFile,
  readFile,
  listFiles,
  executeCommand,
  fetchUrl,
  scrapeSite,
  fetchPageHtml,
  fetchStylesheet,
  analyzeImage,
};
