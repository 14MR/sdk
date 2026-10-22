// An in-process mock of the node API routes the SDK uses to resolve programs,
// serving a synthetic import graph. Shared by network-bench.mjs and
// verify-proving.mjs.

export const MOCK_HOST = "https://sdk-bench.invalid/api/v2";
export const ROOT_PROGRAM = "bench_root.aleo";

// Returns the URL of a fetch resource (string, URL or Request).
export function resourceUrl(resource) {
    if (typeof resource === "string") return resource;
    return resource instanceof URL ? resource.href : resource.url;
}

// A root program over `depth` levels of `width` programs. Each program imports
// every program on the level below, so the import graph is a layered DAG with
// shared dependencies, and `main` calls one chain down to a leaf so the
// execution stays within the transition limit. The unused functions only make
// the sources bigger, so parsing them costs about what a real program does.
// snarkVM allows 31 functions per program, so `functions` is at most 30.
export function syntheticPrograms({ depth, width, functions, instructions }) {
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
            } else {
                lines.push("    add r0 1u32 into r1;");
            }
            lines.push("    output r1 as u32.public;", "");
            for (let f = 0; f < functions; f++) {
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

// Answers a request to MOCK_HOST, or returns undefined when the mock has no
// route for it. Programs are reported at edition 1, as a fresh deployment is;
// snarkVM refuses to execute edition 0 programs other than credits.aleo.
export function mockResponse(url, network, programs) {
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
        return programs[match[1]] ? json(1) : undefined;
    if ((match = route.match(/^\/program\/([\w.]+)\/amendment_count$/)))
        return programs[match[1]]
            ? json({ program_id: match[1], edition: 1, amendment_count: 0 })
            : undefined;
    if (route.startsWith("/program/credits.aleo/mapping/account/"))
        return json("1000000000000u64");
    return undefined;
}
