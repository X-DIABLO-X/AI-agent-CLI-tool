import "dotenv/config";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import fs from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { createGroqChatCompletion, hasGroqApiKeys } from "./groq.js";
import { tools, toolMap } from "./tools.js";
import { SYSTEM_PROMPT } from "./prompt.js";

const MODEL =
  process.env.GROQ_MODEL ||
  process.env.OPENAI_MODEL ||
  "qwen/qwen3-32b";
const MAX_STEPS = 80;

function extractProjectFolder(userInstruction) {
  const patterns = [
    /folder named\s+["']?([a-zA-Z0-9._\-\/]+)["']?/i,
    /into\s+(?:a\s+folder\s+named\s+)?["']?([a-zA-Z0-9._\-\/]+)["']?/i,
    /inside\s+(?:a\s+folder\s+named\s+)?["']?([a-zA-Z0-9._\-\/]+)["']?/i,
  ];

  for (const pattern of patterns) {
    const match = userInstruction.match(pattern);
    if (match?.[1]) {
      const value = match[1].replace(/[.,!?]+$/, "");
      if (!/^(a|an|the|folder)$/i.test(value)) return value;
    }
  }

  return null;
}

function isWebsiteTask(userInstruction) {
  return /website|webpage|landing page|html|css|javascript|js|clone/i.test(
    userInstruction
  );
}

function extractReferenceUrl(userInstruction) {
  const explicitUrl = userInstruction.match(/https?:\/\/[^\s)]+/i);
  if (explicitUrl?.[0]) return explicitUrl[0];

  const domainLike = userInstruction.match(
    /\b(?:www\.)?[a-z0-9-]+\.(?:com|in|org|net|io|ai|dev|co)\b/i
  );
  if (!domainLike?.[0]) return null;

  const raw = domainLike[0].replace(/[.,!?]+$/, "");
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function defaultTargetFolder(userInstruction) {
  return extractProjectFolder(userInstruction) || "output";
}

function printBanner() {
  console.log(
    chalk.magenta.bold(
      "\n========================================================="
    )
  );
  console.log(
    chalk.magenta.bold("   AI Agent CLI  -  Cursor / Windsurf style agent")
  );
  console.log(
    chalk.gray(
      "   Reasons step by step, calls tools, and writes real files."
    )
  );
  console.log(
    chalk.magenta.bold(
      "=========================================================\n"
    )
  );
  console.log(
    chalk.cyan(
      "Try:  Clone the landing page from the images in references/ into a folder named website_clone"
    )
  );
  console.log(chalk.gray("Type 'exit' or 'quit' to leave.\n"));
}

function renderStep(parsed) {
  const step = (parsed.step || "").toUpperCase();
  switch (step) {
    case "START":
      console.log(chalk.blue.bold("\n[START] ") + chalk.white(parsed.content));
      break;
    case "THINK":
      console.log(
        chalk.yellow.bold("\n[THINK] ") + chalk.whiteBright(parsed.content)
      );
      break;
    case "TOOL":
      console.log(
        chalk.magenta.bold(`\n[TOOL ] `) +
          chalk.white(`${parsed.tool_name}`) +
          chalk.gray(
            `  args=${
              typeof parsed.tool_args === "string"
                ? parsed.tool_args.slice(0, 120)
                : JSON.stringify(parsed.tool_args).slice(0, 120)
            }${
              JSON.stringify(parsed.tool_args || "").length > 120 ? "…" : ""
            }`
          )
      );
      break;
    case "OBSERVE":
      console.log(
        chalk.green.bold("\n[OBS  ] ") +
          chalk.gray(
            typeof parsed.content === "string"
              ? parsed.content.slice(0, 200)
              : JSON.stringify(parsed.content).slice(0, 200)
          )
      );
      break;
    case "OUTPUT":
      console.log(
        chalk.greenBright.bold("\n[FINAL] ") +
          chalk.whiteBright(parsed.content) +
          "\n"
      );
      break;
    default:
      console.log(chalk.gray(JSON.stringify(parsed)));
  }
}

function safeParseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch (_) {}
    }
    return null;
  }
}

async function fileExists(relPath) {
  try {
    await fs.access(path.resolve(process.cwd(), relPath));
    return true;
  } catch {
    return false;
  }
}

function prepareCloneAssets(html) {
  const styleBlocks = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)];
  const extractedCss = styleBlocks
    .map((match) => match[1].trim())
    .filter(Boolean)
    .join("\n\n");

  let cleanedHtml = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");

  if (!/href=["']styles\.css["']/i.test(cleanedHtml)) {
    cleanedHtml = cleanedHtml.replace(
      /<\/head>/i,
      '  <link rel="stylesheet" href="styles.css" />\n</head>'
    );
  }

  if (!/src=["']script\.js["']/i.test(cleanedHtml)) {
    cleanedHtml = cleanedHtml.replace(
      /<\/body>/i,
      '  <script src="script.js" defer></script>\n</body>'
    );
  }

  const css =
    extractedCss ||
    [
      "html { scroll-behavior: smooth; }",
      "body { margin: 0; }",
      "img { max-width: 100%; height: auto; }",
    ].join("\n");

  const js = [
    "document.documentElement.dataset.cloneReady = 'true';",
    "",
    "document.querySelectorAll('a[href^=\"#\"]').forEach((link) => {",
    "  link.addEventListener('click', (event) => {",
    "    const target = document.querySelector(link.getAttribute('href'));",
    "    if (!target) return;",
    "    event.preventDefault();",
    "    target.scrollIntoView({ behavior: 'smooth', block: 'start' });",
    "  });",
    "});",
  ].join("\n");

  return {
    html: cleanedHtml,
    css,
    js,
  };
}

function buildModelMessages(history) {
  if (history.length === 0) return history;
  const lastMessage = history[history.length - 1];
  if (lastMessage?.role === "user") return history;

  return [
    ...history,
    {
      role: "user",
      content:
        "Continue the reasoning loop and reply with exactly one JSON object in the required schema.",
    },
  ];
}

async function verifyCloneFiles({ html, css, js, referenceUrl }) {
  const prompt = [
    "Verify whether these generated clone files look usable for a browser-openable website clone.",
    `Reference URL: ${referenceUrl}`,
    "Return JSON only with keys: looksReady(boolean), issues(array of strings), summary(string).",
    "Mark looksReady=false if the output appears to be only a loading shell, missing core content, or broken file wiring.",
    "",
    "HTML snippet:",
    html.slice(0, 7000),
    "",
    "CSS snippet:",
    css.slice(0, 4000),
    "",
    "JS snippet:",
    js.slice(0, 2000),
  ].join("\n");

  const resp = await createGroqChatCompletion({
    model: MODEL,
    messages: [{ role: "user", content: prompt }],
  });

  const raw = resp.choices[0].message.content || "";
  const parsed = safeParseJSON(raw);
  return (
    parsed || {
      looksReady: true,
      issues: [],
      summary: "Verification response was not valid JSON, but file generation completed.",
    }
  );
}

async function requestAgentStep(messages) {
  const requestMessages = buildModelMessages(messages);
  try {
    return await createGroqChatCompletion(
      {
        model: MODEL,
        response_format: { type: "json_object" },
        messages: requestMessages,
      },
      {
        logger: (message) => console.log(chalk.yellow(`\n${message}`)),
      }
    );
  } catch (err) {
    const errorText = [
      err?.message,
      err?.error?.message,
      err?.code,
      err?.type,
      err?.error?.code,
      err?.error?.type,
    ]
      .filter(Boolean)
      .join(" ");
    if (
      /response_format|json_object|unsupported|json_validate_failed|failed to generate json|failed_generation/i.test(
        errorText
      )
    ) {
      return await createGroqChatCompletion(
        {
          model: MODEL,
          messages: requestMessages,
        },
        {
          logger: (message) => console.log(chalk.yellow(`\n${message}`)),
        }
      );
    }
    throw err;
  }
}

async function tryDirectClone(userInstruction) {
  const referenceUrl = extractReferenceUrl(userInstruction);
  if (!referenceUrl || !isWebsiteTask(userInstruction)) return null;

  const targetFolder = defaultTargetFolder(userInstruction);
  const scrapeResult = await toolMap.scrapeSite({
    url: referenceUrl,
    saveClone: true,
    targetFolder,
  });

  if (typeof scrapeResult !== "string") {
    return {
      mode: "direct-clone-failed",
      referenceUrl,
      targetFolder,
      error: "scrapeSite did not return a valid response.",
    };
  }
  if (/^scrapeSite failed:/i.test(scrapeResult) || /^Error:/i.test(scrapeResult)) {
    return {
      mode: "direct-clone-failed",
      referenceUrl,
      targetFolder,
      error: scrapeResult,
    };
  }

  try {
    const parsed = JSON.parse(scrapeResult);
    const clonePath = parsed?.artifacts?.cloneHtmlPath;
    if (!clonePath) {
      return {
        mode: "direct-clone-failed",
        referenceUrl,
        targetFolder,
        error: "scrapeSite completed but did not provide a cloneHtmlPath.",
      };
    }

    return {
      mode: "direct-clone-success",
      referenceUrl,
      clonePath,
      targetFolder,
    };
  } catch {
    return {
      mode: "direct-clone-failed",
      referenceUrl,
      targetFolder,
      error: "scrapeSite returned non-JSON output.",
    };
  }
}

async function runAgent(userInstruction, history) {
  history.push({ role: "user", content: userInstruction });

  const targetFolder = defaultTargetFolder(userInstruction);
  const needsWebBuildGate = isWebsiteTask(userInstruction) && targetFolder;
  const writtenFiles = new Set();

  const directClone = await tryDirectClone(userInstruction);
  if (directClone?.mode === "direct-clone-failed") {
    renderStep({
      step: "START",
      content: `User wants to clone ${directClone.referenceUrl}.`,
    });
    renderStep({
      step: "THINK",
      content:
        "Direct clone mode detected. I tried scraping the live site first, but the scrape step failed.",
    });
    console.log(
      chalk.red(`\n[Model error] ${directClone.error}`)
    );
    return;
  }

  if (directClone?.mode === "direct-clone-success") {
    renderStep({
      step: "START",
      content: `User wants to clone ${directClone.referenceUrl}.`,
    });
    renderStep({
      step: "THINK",
      content:
        "I'll inspect the live site first, then write a browser-openable clone into local files.",
    });
    renderStep({
      step: "TOOL",
      tool_name: "scrapeSite",
      tool_args: {
        url: directClone.referenceUrl,
        saveClone: true,
        targetFolder: directClone.targetFolder,
      },
    });

    const scrapeObservation = await toolMap.scrapeSite({
      url: directClone.referenceUrl,
      saveClone: true,
      targetFolder: directClone.targetFolder,
    });
    renderStep({
      step: "OBSERVE",
      content:
        typeof scrapeObservation === "string"
          ? scrapeObservation
          : JSON.stringify(scrapeObservation),
    });

    const cloneTarget = path.resolve(process.cwd(), directClone.clonePath);
    const clonedHtml = await fs.readFile(cloneTarget, "utf8");
    const prepared = prepareCloneAssets(clonedHtml);

    renderStep({
      step: "THINK",
      content:
        "The live clone is ready. Now I'll split the result into HTML, CSS, and JS files for a cleaner local workflow.",
    });

    renderStep({
      step: "TOOL",
      tool_name: "createFolder",
      tool_args: { path: directClone.targetFolder },
    });
    const folderObs = await toolMap.createFolder({ path: directClone.targetFolder });
    renderStep({ step: "OBSERVE", content: folderObs });

    renderStep({
      step: "TOOL",
      tool_name: "writeFile",
      tool_args: {
        path: `${directClone.targetFolder}/index.html`,
        content: prepared.html,
      },
    });
    const htmlObs = await toolMap.writeFile({
      path: `${directClone.targetFolder}/index.html`,
      content: prepared.html,
    });
    renderStep({ step: "OBSERVE", content: htmlObs });

    renderStep({
      step: "TOOL",
      tool_name: "writeFile",
      tool_args: {
        path: `${directClone.targetFolder}/styles.css`,
        content: prepared.css,
      },
    });
    const cssObs = await toolMap.writeFile({
      path: `${directClone.targetFolder}/styles.css`,
      content: prepared.css,
    });
    renderStep({ step: "OBSERVE", content: cssObs });

    renderStep({
      step: "TOOL",
      tool_name: "writeFile",
      tool_args: {
        path: `${directClone.targetFolder}/script.js`,
        content: prepared.js,
      },
    });
    const jsObs = await toolMap.writeFile({
      path: `${directClone.targetFolder}/script.js`,
      content: prepared.js,
    });
    renderStep({ step: "OBSERVE", content: jsObs });

    renderStep({
      step: "THINK",
      content:
        "The files are written. I'll verify the generated HTML, CSS, and JS together before finishing.",
    });
    const verification = await verifyCloneFiles({
      html: prepared.html,
      css: prepared.css,
      js: prepared.js,
      referenceUrl: directClone.referenceUrl,
    });
    renderStep({
      step: "OBSERVE",
      content: JSON.stringify(verification),
    });

    renderStep({
      step: "TOOL",
      tool_name: "listFiles",
      tool_args: { path: directClone.targetFolder },
    });
    const listObs = await toolMap.listFiles({ path: directClone.targetFolder });
    renderStep({ step: "OBSERVE", content: listObs });

    renderStep({
      step: "OUTPUT",
      content: `Clone completed in ${directClone.targetFolder}. Open ${directClone.targetFolder}/index.html in your browser.`,
    });
    return;
  }

  let steps = 0;
  while (steps++ < MAX_STEPS) {
    let response;
    try {
      response = await requestAgentStep(history);
    } catch (err) {
      console.log(chalk.red(`\n[Model error] ${err.message}`));
      if (err.status) console.log(chalk.red(`  status: ${err.status}`));
      if (err.code) console.log(chalk.red(`  code:   ${err.code}`));
      if (err.type) console.log(chalk.red(`  type:   ${err.type}`));
      if (err.cause?.code)
        console.log(chalk.red(`  cause:  ${err.cause.code}`));
      if (err.error?.message)
        console.log(chalk.red(`  detail: ${err.error.message}`));
      return;
    }

    const raw = response.choices[0].message.content;
    const parsed = safeParseJSON(raw);

    if (!parsed || !parsed.step) {
      history.push({
        role: "user",
        content: JSON.stringify({
          step: "OBSERVE",
          content:
            "Your last reply was not valid JSON in the required schema. Reply again with a single JSON object using fields { step, content, tool_name, tool_args }.",
        }),
      });
      continue;
    }

    history.push({ role: "assistant", content: JSON.stringify(parsed) });
    renderStep(parsed);

    const step = parsed.step.toUpperCase();

    if (step === "OUTPUT") {
      if (needsWebBuildGate) {
        const required = [
          `${targetFolder}/index.html`,
          `${targetFolder}/styles.css`,
          `${targetFolder}/script.js`,
        ];
        const missing = [];
        for (const f of required) {
          if (!(await fileExists(f))) missing.push(f);
        }
        if (missing.length > 0) {
          console.log(
            chalk.red.bold(
              `\n[GATE ] OUTPUT rejected - these files do not exist on disk: ${missing.join(", ")}`
            )
          );
          history.push({
            role: "user",
            content: JSON.stringify({
              step: "OBSERVE",
              content: `BLOCKED: Your OUTPUT claims the build is done, but these files do NOT exist on disk: ${missing.join(", ")}. You skipped the build phase. You MUST now resume by calling createFolder for "${targetFolder}", then writeFile for each missing file with full HTML/CSS/JS content, then listFiles. Only after listFiles confirms all three files may you emit OUTPUT.`,
            }),
          });
          continue;
        }
      }
      return;
    }

    if (step === "TOOL") {
      const fn = toolMap[parsed.tool_name];
      let observation;
      if (!fn) {
        observation = `Tool "${parsed.tool_name}" is not available. Available tools: ${Object.keys(
          toolMap
        ).join(", ")}.`;
      } else {
        try {
          observation = await fn(parsed.tool_args);
          if (parsed.tool_name === "writeFile") {
            const a = parsed.tool_args || {};
            const p = (a.path || a.file || "").toString();
            if (p) writtenFiles.add(p.replace(/\\/g, "/"));
          }
        } catch (err) {
          observation = `Tool "${parsed.tool_name}" threw an error: ${err.message}`;
        }
      }

      const obsString =
        typeof observation === "string"
          ? observation
          : JSON.stringify(observation);

      history.push({
        role: "user",
        content: JSON.stringify({ step: "OBSERVE", content: obsString }),
      });
    }
  }

  console.log(
    chalk.red(`\n[Stop] Reached max step limit (${MAX_STEPS}).`)
  );
}

async function main() {
  if (!hasGroqApiKeys()) {
    console.log(
      chalk.red(
        "Missing Groq keys. Copy .env.example to .env and set GROQ_API_KEYS or GROQ_API_KEY."
      )
    );
    process.exit(1);
  }

  printBanner();

  const rl = readline.createInterface({ input, output });
  const history = [{ role: "system", content: SYSTEM_PROMPT(tools) }];

  while (true) {
    const userInput = (await rl.question(chalk.cyan.bold("you > "))).trim();
    if (!userInput) continue;
    if (["exit", "quit", ":q"].includes(userInput.toLowerCase())) {
      console.log(chalk.gray("bye."));
      rl.close();
      return;
    }
    await runAgent(userInput, history);
  }
}

main().catch((err) => {
  console.error(chalk.red("Fatal:"), err);
  process.exit(1);
});
