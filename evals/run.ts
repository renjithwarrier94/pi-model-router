import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { parseModelRouterConfigJson } from "../src/adapters/config/config-schema.js";
import { syntheticCases } from "./cases/synthetic.js";
import { evaluateCases, type ExpectedDecision } from "./evaluate.js";
import { parseEvaluationCasesJson } from "./parse-cases.js";

function describe(decision: ExpectedDecision): string {
  return decision.status === "unchanged"
    ? `unchanged (${decision.reason})`
    : `${decision.status} (${decision.optionId})`;
}

async function main(): Promise<void> {
  const argumentsList = process.argv.slice(2);
  let configPath = fileURLToPath(new URL("../examples/router.config.json", import.meta.url));
  let json = false;
  let casesPath: string | undefined;
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === "--json") json = true;
    else if (argument === "--config" && argumentsList[index + 1]) configPath = resolve(argumentsList[++index]!);
    else if (argument === "--cases" && argumentsList[index + 1]) casesPath = resolve(argumentsList[++index]!);
    else throw new Error(`Unknown or incomplete argument: ${argument}`);
  }
  const config = parseModelRouterConfigJson(await readFile(configPath, "utf8"));
  const cases = casesPath ? parseEvaluationCasesJson(await readFile(casesPath, "utf8")) : syntheticCases;
  if (cases.length === 0) throw new Error("At least one evaluation case is required.");
  const results = evaluateCases(cases, config);
  const passed = results.filter(result => result.decisionMatches && result.categoryMatches).length;
  const fallbacks = results.filter(result => result.actual.status === "threshold-unmet").length;
  const recorded = results.filter(result => result.source === "recorded-jev");
  const summary = {
    total: results.length, passed, fallbacks,
    recordedCategoryMatches: recorded.filter(result => result.categoryMatches).length,
    recordedCategoryTotal: recorded.length,
    warning: recorded.length === 0
      ? "Synthetic judgments and illustrative model scores/costs; no Jev accuracy or model quality measured."
      : "Recorded classification is measured against labels, but model quality/cost are not measured; policy scores/costs remain illustrative.",
  };
  if (json) console.log(JSON.stringify({ summary, results }, null, 2));
  else {
    for (const result of results) {
      const outcome = result.decisionMatches && result.categoryMatches ? "PASS" : "FAIL";
      console.log(`${outcome} ${result.id}: ${describe(result.actual)}${outcome === "FAIL" ? `; expected ${describe(result.expected)}` : ""}`);
    }
    console.log(`\n${passed}/${results.length} policy cases passed; ${fallbacks} threshold-unmet fallbacks.`);
    if (recorded.length) console.log(`${summary.recordedCategoryMatches}/${recorded.length} recorded categories matched independent labels.`);
    console.log(summary.warning);
  }
  if (passed !== results.length) process.exitCode = 1;
}

main().catch(error => {
  // Parser errors contain a config field path/rule, never user-supplied values.
  console.error(error instanceof Error ? error.message : "Offline evaluation failed.");
  process.exitCode = 1;
});
