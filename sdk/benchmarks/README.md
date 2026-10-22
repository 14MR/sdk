# Benchmarks

## network-bench.mjs

Measures what the SDK does on the network for calls that resolve programs:
`getProgramImports`, `buildAuthorization` and `provingRequest`. For each call
it reports the wall time, the number of requests, how many repeat a URL already
fetched in the same call, and the most requests in flight at once.

It replaces `fetch` before the SDK loads. Every request waits `--latency` ms
(plus up to `--jitter` ms), so wall time follows the number of round trips on
the critical path. The default scenarios talk to an in-process mock of the node
API that serves a synthetic import graph: a root program over `--depth` levels
of `--width` programs, each importing every program on the level below. They
need no network, and their request counts are deterministic. The
`live-imports` scenario resolves a real program's imports against a real API
host instead.

```sh
yarn bench:network                                      # local build, mock scenarios
yarn bench:network --latency 300 --jitter 100 --rounds 10
yarn bench:network --trace --rounds 1                   # print every request
yarn bench:network --scenario live-imports --latency 0  # real network
```

See the header of `network-bench.mjs` for every option.

## Comparing branches

`build-variants.sh` builds the SDK once per variant into `bench-builds/` and
prints the command that compares them. A variant is HEAD with the `sdk/src`
changes of one or more refs applied; join refs with `+` to stack them.

```sh
yarn install
sdk/benchmarks/build-variants.sh base=HEAD \
    pr1436=fix/skip-unused-call-graphs \
    pr1437=fix/parallel-program-imports \
    both=fix/skip-unused-call-graphs+fix/parallel-program-imports
node sdk/benchmarks/network-bench.mjs --sdk base=... --compare pr1436=... # as printed
```

Each round runs every build in its own process, in a random order.
