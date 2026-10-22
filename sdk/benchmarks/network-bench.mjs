#!/usr/bin/env node
// Benchmarks the network side of the SDK: how many requests a call makes, how
// many of them repeat a URL already fetched in the same call, how many run at
// once, and how long the call takes when every request pays a round trip.
//
// The default scenarios run against an in-process mock of the node API that
// serves a synthetic import graph, so they need no network and every request
// costs exactly --latency ms (plus up to --jitter ms). Request counts are
// deterministic; wall time is dominated by how many round trips sit on the
// critical path, which is what SDK changes to request ordering affect.
//
// Run against the local build (after `yarn build:all`):
//   yarn bench:network
//   yarn bench:network --latency 300 --jitter 100 --rounds 10
//
// Compare builds (each round runs every build in its own process, in a random
// order, so the wasm instances never share a heap):
//   yarn bench:network --sdk base=/tmp/base/dist/mainnet/node.js \
//       --compare pr=../dist/mainnet/node.js
//
// Hit the real network instead of the mock (results depend on the network):
//   yarn bench:network --scenario live-imports --live-program shield_swap_router.aleo
//
// Options:
//   --network <mainnet|testnet>  which dist entry to load (default mainnet)
//   --sdk [label=]<path>         entry to benchmark instead of ../dist/<network>/node.js
//   --compare [label=]<path>     entry of another build to benchmark; repeatable
//   --scenario <name>            scenario to run; repeatable (default: all mock scenarios)
//   --rounds <n>                 process rounds per build (default 5)
//   --latency <ms>               delay added to every request (default 150)
//   --jitter <ms>                extra uniform random delay per request (default 0)
//   --depth <n>                  import levels below the root program (default 3)
//   --width <n>                  programs per import level (default 3)
//   --functions <n>              unused functions per synthetic program, at most 30 (default 20)
//   --instructions <n>           instructions per unused function (default 1)
//   --live-host <url>            API host for live scenarios (default https://edge.provable.com/api/v2)
//   --live-program <id>          program for live scenarios (default shield_swap_router.aleo)
//   --trace                      print every request each scenario makes, with its start time
//   --json                       print the raw JSON instead of tables
import { performance } from "node:perf_hooks";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import path from "node:path";

const MOCK_SCENARIOS = ["imports", "authorize", "proving-request"];
const LIVE_SCENARIOS = ["live-imports"];

const { values: args } = parseArgs({
    options: {
        network: { type: "string", default: "mainnet" },
        sdk: { type: "string" },
        compare: { type: "string", multiple: true, default: [] },
        scenario: { type: "string", multiple: true, default: [] },
        rounds: { type: "string", default: "5" },
        latency: { type: "string", default: "150" },
        jitter: { type: "string", default: "0" },
        depth: { type: "string", default: "3" },
        width: { type: "string", default: "3" },
        functions: { type: "string", default: "20" },
        instructions: { type: "string", default: "1" },
        "live-host": {
            type: "string",
            default: "https://edge.provable.com/api/v2",
        },
        "live-program": { type: "string", default: "shield_swap_router.aleo" },
        trace: { type: "boolean", default: false },
        json: { type: "boolean", default: false },
        child: { type: "boolean", default: false },
    },
});
const here = path.dirname(fileURLToPath(import.meta.url));
const network = args.network;
if (network !== "mainnet" && network !== "testnet")
    throw new Error(`--network must be mainnet or testnet, got ${network}`);
const rounds = positiveInt("--rounds", args.rounds);
const latency = nonNegativeInt("--latency", args.latency);
const jitter = nonNegativeInt("--jitter", args.jitter);
const depth = positiveInt("--depth", args.depth);
const width = positiveInt("--width", args.width);
const unusedFunctions = nonNegativeInt("--functions", args.functions);
// snarkVM allows 31 functions per program, and `main` is one of them.
if (unusedFunctions > 30)
    throw new Error(`--functions must be at most 30, got ${unusedFunctions}`);
const instructions = positiveInt("--instructions", args.instructions);
const scenarios = args.scenario.length ? args.scenario : MOCK_SCENARIOS;
for (const name of scenarios) {
    if (!MOCK_SCENARIOS.includes(name) && !LIVE_SCENARIOS.includes(name))
        throw new Error(
            `unknown scenario ${name}; expected one of ${[...MOCK_SCENARIOS, ...LIVE_SCENARIOS].join(", ")}`,
        );
}

const MOCK_HOST = "https://sdk-bench.invalid/api/v2";
const PRIVATE_KEY =
    "APrivateKey1zkpJkyYRGYtkeHDaFfwsKtUJzia7csiWhfBWPXWhXJzy9Ls";
const ROOT_PROGRAM = "bench_root.aleo";
const programs = syntheticPrograms();

const builds = [
    parseBuild(
        args.sdk ?? path.join(here, "..", "dist", network, "node.js"),
        "A",
    ),
    ...args.compare.map((spec, i) =>
        parseBuild(spec, String.fromCharCode(66 + i)),
    ),
];

if (args.child) {
    console.log(JSON.stringify(await benchmark(builds[0].entry)));
} else {
    run();
}

// Wraps fetch before the SDK is imported, so the SDK's fetch polyfill and
// default transport both go through it. Requests to MOCK_HOST are answered
// locally; every other http(s) request goes to the network. Both pay the
// injected latency.
function installFetchTrace() {
    const realFetch = globalThis.fetch;
    const trace = {
        requests: [],
        started: [],
        inFlight: 0,
        maxInFlight: 0,
        unhandled: [],
    };
    globalThis.fetch = async (resource, init) => {
        const url =
            typeof resource === "string"
                ? resource
                : resource instanceof URL
                  ? resource.href
                  : resource.url;
        if (!url.startsWith("http")) return realFetch(resource, init);
        trace.requests.push(url);
        trace.started.push(performance.now());
        trace.inFlight++;
        trace.maxInFlight = Math.max(trace.maxInFlight, trace.inFlight);
        try {
            await sleep(latency + Math.random() * jitter);
            if (url.startsWith(MOCK_HOST)) return mockResponse(url, trace);
            return await realFetch(resource, init);
        } finally {
            trace.inFlight--;
        }
    };
    return trace;
}

async function benchmark(sdkEntry) {
    const trace = installFetchTrace();
    const sdk = await import(sdkEntry);
    const { AleoNetworkClient, ProgramManager, PrivateKey } = sdk;
    const privateKey = PrivateKey.from_string(PRIVATE_KEY);
    const runners = {
        imports: () =>
            new AleoNetworkClient(MOCK_HOST).getProgramImports(ROOT_PROGRAM),
        authorize: () =>
            new ProgramManager(MOCK_HOST).buildAuthorization({
                programName: ROOT_PROGRAM,
                functionName: "main",
                inputs: ["1u32"],
                privateKey,
            }),
        "proving-request": () =>
            new ProgramManager(MOCK_HOST).provingRequest({
                programName: ROOT_PROGRAM,
                functionName: "main",
                inputs: ["1u32"],
                priorityFee: 0,
                privateFee: false,
                broadcast: false,
                privateKey,
            }),
        "live-imports": () =>
            new AleoNetworkClient(args["live-host"]).getProgramImports(
                args["live-program"],
            ),
    };

    // Untimed pass so one-time wasm and JIT costs land outside the samples.
    // Live scenarios are skipped to keep traffic to the real network down.
    for (const name of scenarios) {
        if (MOCK_SCENARIOS.includes(name)) await runners[name]();
    }

    const result = {};
    for (const name of scenarios) {
        trace.requests = [];
        trace.started = [];
        trace.maxInFlight = 0;
        const start = performance.now();
        await runners[name]();
        const ms = performance.now() - start;
        if (args.trace) {
            const seen = new Set();
            const lines = trace.requests.map((url, i) => {
                const repeat = seen.has(url) ? "  (repeat)" : "";
                seen.add(url);
                const at = (trace.started[i] - start).toFixed(0).padStart(6);
                return `  +${at} ms  ${url}${repeat}`;
            });
            process.stderr.write(`${name}\n${lines.join("\n")}\n`);
        }
        result[name] = {
            ms: round(ms),
            requests: trace.requests.length,
            repeated: trace.requests.length - new Set(trace.requests).size,
            maxInFlight: trace.maxInFlight,
        };
    }
    if (trace.unhandled.length)
        process.stderr.write(
            `mock had no route for:\n  ${[...new Set(trace.unhandled)].join("\n  ")}\n`,
        );
    return result;
}

// Answers the node API routes the SDK uses for program resolution.
function mockResponse(url, trace) {
    const route = new URL(url).pathname.replace(
        new URL(MOCK_HOST).pathname + "/" + network,
        "",
    );
    const json = (body) =>
        new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
        });
    let match;
    if ((match = route.match(/^\/program\/([\w.]+)$/)) && programs[match[1]])
        return json(programs[match[1]]);
    if ((match = route.match(/^\/program\/([\w.]+)\/latest_edition$/)))
        return json(0);
    if ((match = route.match(/^\/program\/([\w.]+)\/amendment_count$/)))
        return json({ program_id: match[1], edition: 0, amendment_count: 0 });
    if (route === "/block/height/latest") return json(20_000_000);
    if (route.startsWith("/program/credits.aleo/mapping/account/"))
        return json("1000000000000u64");
    trace.unhandled.push(route);
    return new Response("not found", { status: 404 });
}

// A root program over `depth` levels of `width` programs. Each program imports
// every program on the level below, so the import graph is a layered DAG with
// shared dependencies, and `main` calls one chain down to a leaf so the
// execution stays within the transition limit. The unused functions only make
// the sources bigger, so parsing them costs about what a real program does.
function syntheticPrograms() {
    const level = (l) =>
        l === 0
            ? [ROOT_PROGRAM]
            : Array.from({ length: width }, (_, i) => `bench_l${l}_${i}.aleo`);
    const sources = {};
    for (let l = 0; l <= depth; l++) {
        const children = l < depth ? level(l + 1) : [];
        for (const id of level(l)) {
            const lines = children.map((child) => `import ${child};`);
            lines.push("", `program ${id};`, "");
            lines.push("function main:", "    input r0 as u32.public;");
            if (children.length) {
                lines.push(`    call ${children[0]}/main r0 into r1;`);
                lines.push("    output r1 as u32.public;", "");
            } else {
                lines.push("    add r0 1u32 into r1;");
                lines.push("    output r1 as u32.public;", "");
            }
            for (let f = 0; f < unusedFunctions; f++) {
                lines.push(`function unused_${f}:`);
                lines.push("    input r0 as u32.public;");
                for (let i = 0; i < instructions; i++)
                    lines.push(
                        `    add.w r${i} ${f + i + 1}u32 into r${i + 1};`,
                    );
                lines.push(`    output r${instructions} as u32.public;`, "");
            }
            sources[id] = lines.join("\n");
        }
    }
    return sources;
}

function run() {
    const samples = builds.map(() =>
        Object.fromEntries(scenarios.map((name) => [name, []])),
    );
    for (let r = 0; r < rounds; r++) {
        for (const i of shuffle(builds.map((_, i) => i))) {
            const build = builds[i];
            process.stderr.write(`round ${r + 1}/${rounds}: ${build.label}\n`);
            const child = spawnSync(
                process.execPath,
                [
                    fileURLToPath(import.meta.url),
                    "--child",
                    "--sdk",
                    build.entry,
                    ...passthroughArgs(),
                ],
                { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
            );
            if (child.status !== 0)
                throw new Error(`benchmark of ${build.entry} failed`);
            const lines = child.stdout.trim().split("\n");
            const result = JSON.parse(lines[lines.length - 1]);
            for (const name of scenarios) samples[i][name].push(result[name]);
        }
    }

    const summary = builds.map((build, i) => ({
        label: build.label,
        entry: build.entry,
        scenarios: Object.fromEntries(
            scenarios.map((name) => [name, summarize(samples[i][name])]),
        ),
    }));
    if (args.json) {
        console.log(JSON.stringify(summary, null, 2));
        return;
    }
    console.log(
        `latency ${latency} ms + jitter 0-${jitter} ms per request, ${rounds} rounds, ` +
            `synthetic graph depth ${depth} x width ${width}, ${unusedFunctions} unused functions ` +
            `of ${instructions} instructions per program`,
    );
    summary.forEach((b) => console.log(`${b.label}: ${b.entry}`));
    for (const name of scenarios) {
        console.log(`\n${name}`);
        printTable(summary, name);
    }
}

function summarize(values) {
    const ms = values.map((v) => v.ms);
    return {
        medianMs: round(median(ms)),
        minMs: round(Math.min(...ms)),
        maxMs: round(Math.max(...ms)),
        requests: median(values.map((v) => v.requests)),
        repeated: median(values.map((v) => v.repeated)),
        maxInFlight: median(values.map((v) => v.maxInFlight)),
        n: values.length,
    };
}

function printTable(summary, name) {
    const header = [
        "build",
        "median ms",
        "min ms",
        "max ms",
        "requests",
        "repeated",
        "max in flight",
    ];
    if (summary.length > 1) header.push("median vs A");
    const base = summary[0].scenarios[name].medianMs;
    const rows = summary.map((b) => {
        const s = b.scenarios[name];
        const row = [
            b.label,
            s.medianMs.toFixed(1),
            s.minMs.toFixed(1),
            s.maxMs.toFixed(1),
            String(s.requests),
            String(s.repeated),
            String(s.maxInFlight),
        ];
        if (summary.length > 1) row.push((s.medianMs / base).toFixed(2) + "x");
        return row;
    });
    const widths = header.map((h, c) =>
        Math.max(h.length, ...rows.map((r) => r[c].length)),
    );
    const line = (cells) =>
        cells
            .map((c, i) =>
                i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]),
            )
            .join("  ");
    console.log(line(header));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    rows.forEach((r) => console.log(line(r)));
}

function passthroughArgs() {
    const out = ["--network", network];
    if (args.trace) out.push("--trace");
    for (const flag of [
        "latency",
        "jitter",
        "depth",
        "width",
        "functions",
        "instructions",
        "live-host",
        "live-program",
    ])
        out.push(`--${flag}`, String(args[flag]));
    for (const name of scenarios) out.push("--scenario", name);
    return out;
}

function parseBuild(spec, letter) {
    const match = spec.match(/^([\w.-]+)=(.+)$/);
    const entry = path.resolve(match ? match[2] : spec);
    return { label: match ? `${letter}: ${match[1]}` : letter, entry };
}

function shuffle(items) {
    for (let i = items.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveInt(flag, value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1)
        throw new Error(`${flag} must be a positive integer, got ${value}`);
    return n;
}

function nonNegativeInt(flag, value) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 0)
        throw new Error(`${flag} must be a non-negative integer, got ${value}`);
    return n;
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
        ? sorted[mid]
        : (sorted[mid - 1] + sorted[mid]) / 2;
}

function round(ms) {
    return Math.round(ms * 10) / 10;
}
