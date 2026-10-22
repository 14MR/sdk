#!/usr/bin/env node
// Checks that the authorizations the SDK builds for local and delegated
// proving still prove, so changes to program resolution can be checked
// end to end. Each build proves two flows over the synthetic import graph
// from mock-node.mjs:
//
//   local   buildAuthorization -> buildFeeAuthorization
//           -> buildTransactionFromAuthorization
//   remote  provingRequest, serialized and parsed back as the prover receives
//           it -> buildTransactionFromAuthorization on its authorizations,
//           which is the proving work the prover does
//
// Program routes are served by the mock. Other routes under the mock host
// (state root, block height) are forwarded to --api-host, and credits.aleo
// keys are downloaded as usual, so this needs network access. Proving takes a
// few minutes per build.
//
//   yarn verify:proving
//   yarn verify:proving --sdk base=/tmp/base/dist/mainnet/node.js \
//       --compare pr=../dist/mainnet/node.js
//
// Options:
//   --network <mainnet|testnet>  which dist entry to load (default mainnet)
//   --sdk [label=]<path>         entry to check instead of ../dist/<network>/node.js
//   --compare [label=]<path>     entry of another build to check; repeatable
//   --api-host <url>             API host for routes the mock does not serve
//                                (default https://edge.provable.com/api/v2)
//   --json                       print the raw JSON instead of a table
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import path from "node:path";
import {
    MOCK_HOST,
    ROOT_PROGRAM,
    mockResponse,
    resourceUrl,
    syntheticPrograms,
} from "./mock-node.mjs";

const { values: args } = parseArgs({
    options: {
        network: { type: "string", default: "mainnet" },
        sdk: { type: "string" },
        compare: { type: "string", multiple: true, default: [] },
        "api-host": {
            type: "string",
            default: "https://edge.provable.com/api/v2",
        },
        json: { type: "boolean", default: false },
        child: { type: "boolean", default: false },
    },
});
const here = path.dirname(fileURLToPath(import.meta.url));
const network = args.network;
if (network !== "mainnet" && network !== "testnet")
    throw new Error(`--network must be mainnet or testnet, got ${network}`);

const PRIVATE_KEY =
    "APrivateKey1zkpJkyYRGYtkeHDaFfwsKtUJzia7csiWhfBWPXWhXJzy9Ls";
const INPUT = "1u32";
const programs = syntheticPrograms({
    depth: 3,
    width: 3,
    functions: 5,
    instructions: 1,
});

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
    console.log(JSON.stringify(await verify(builds[0].entry)));
} else {
    run();
}

async function verify(sdkEntry) {
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (resource, init) => {
        const url = resourceUrl(resource);
        if (!url.startsWith(MOCK_HOST)) return realFetch(resource, init);
        return (
            mockResponse(url, network, programs) ??
            realFetch(url.replace(MOCK_HOST, args["api-host"]), init)
        );
    };

    const sdk = await import(sdkEntry);
    const { ProgramManager, PrivateKey, ProvingRequest, Transaction } = sdk;
    const privateKey = PrivateKey.from_string(PRIVATE_KEY);
    const prove = (authorization, feeAuthorization) =>
        new ProgramManager(MOCK_HOST).buildTransactionFromAuthorization({
            programName: ROOT_PROGRAM,
            authorization,
            feeAuthorization,
        });

    const flows = {
        local: async () => {
            const pm = new ProgramManager(MOCK_HOST);
            const authorization = await pm.buildAuthorization({
                programName: ROOT_PROGRAM,
                functionName: "main",
                inputs: [INPUT],
                privateKey,
            });
            const feeAuthorization = await pm.buildFeeAuthorization({
                deploymentOrExecutionId: authorization
                    .toExecutionId()
                    .toString(),
                baseFeeCredits: 0.01,
                privateKey,
            });
            return prove(authorization, feeAuthorization);
        },
        remote: async () => {
            const request = await new ProgramManager(MOCK_HOST).provingRequest({
                programName: ROOT_PROGRAM,
                functionName: "main",
                inputs: [INPUT],
                priorityFee: 0,
                privateFee: false,
                broadcast: false,
                privateKey,
            });
            const received = ProvingRequest.fromString(request.toString());
            return prove(received.authorization(), received.feeAuthorization());
        },
    };

    const result = {};
    for (const [name, flow] of Object.entries(flows)) {
        try {
            const transaction = Transaction.fromString(
                (await flow()).toString(),
            );
            result[name] = {
                ok: true,
                transitions: transaction
                    .transitions()
                    .map((t) => `${t.programId()}/${t.functionName()}`),
                rootOutputs: transaction
                    .transitions()
                    .find((t) => t.programId() === ROOT_PROGRAM)
                    ?.outputs(true)
                    .map(formatValue),
                fee: transaction.feeAmount().toString(),
            };
        } catch (error) {
            result[name] = { ok: false, error: String(error) };
        }
    }
    return result;
}

function run() {
    const results = builds.map((build) => {
        process.stderr.write(`proving with ${build.label}\n`);
        const child = spawnSync(
            process.execPath,
            [
                fileURLToPath(import.meta.url),
                "--child",
                "--sdk",
                build.entry,
                "--network",
                network,
                "--api-host",
                args["api-host"],
            ],
            { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
        );
        if (child.status !== 0)
            throw new Error(`proving with ${build.entry} crashed`);
        const lines = child.stdout.trim().split("\n");
        return { ...build, flows: JSON.parse(lines[lines.length - 1]) };
    });

    if (args.json) console.log(JSON.stringify(results, null, 2));
    else printTable(results);
    const failed = results.some((r) =>
        Object.values(r.flows).some((f) => !f.ok),
    );
    process.exitCode = failed ? 1 : 0;
}

function printTable(results) {
    results.forEach((r) => console.log(`${r.label}: ${r.entry}`));
    const header = [
        "build",
        "flow",
        "result",
        "transitions",
        "root output",
        "fee",
    ];
    const rows = results.flatMap((r) =>
        Object.entries(r.flows).map(([name, f]) => [
            r.label,
            name,
            f.ok ? "proved" : `FAILED: ${f.error}`,
            f.ok ? f.transitions.join(" ") : "",
            f.ok ? (f.rootOutputs ?? []).join(", ") : "",
            f.ok ? f.fee : "",
        ]),
    );
    const widths = header.map((h, c) =>
        Math.max(h.length, ...rows.map((r) => r[c].length)),
    );
    const line = (cells) =>
        cells
            .map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i])))
            .join("  ");
    console.log(line(header));
    console.log(widths.map((w) => "-".repeat(w)).join("  "));
    rows.forEach((r) => console.log(line(r)));
}

// Transition outputs come back as plain objects whose fields may be bigints.
function formatValue(output) {
    if (output && typeof output === "object" && "value" in output)
        return String(output.value);
    return JSON.stringify(output, (_, v) =>
        typeof v === "bigint" ? v.toString() : v,
    );
}

function parseBuild(spec, letter) {
    const match = spec.match(/^([\w.-]+)=(.+)$/);
    const entry = path.resolve(match ? match[2] : spec);
    return { label: match ? `${letter}: ${match[1]}` : letter, entry };
}
