#!/usr/bin/env bash
# Builds the SDK once per variant so network-bench.mjs can compare them.
#
# Each variant is HEAD's sdk/src with the sdk/src changes of one or more git
# refs applied on top (the diff from the merge base, like a PR diff), so
# branches based on an older commit still compare against the same base.
# Join refs with "+" to stack them.
#
#   sdk/benchmarks/build-variants.sh base=HEAD \
#       pr1436=fix/skip-unused-call-graphs \
#       pr1437=fix/parallel-program-imports \
#       both=fix/skip-unused-call-graphs+fix/parallel-program-imports
#
# Builds land in <repo>/bench-builds/<name>/dist, inside the repo so the
# builds resolve @provablehq/wasm and the other dependencies from the root
# node_modules. Run `yarn install` first. If wasm/dist is missing, the
# published @provablehq/wasm of the same version is unpacked into it instead
# of building the wasm from source.
#
# sdk/src must be clean; it is restored when the script exits. sdk/dist is
# left holding the last variant built.
set -euo pipefail

if [ $# -eq 0 ]; then
    echo "usage: $0 <name>=<ref>[+<ref>...] ..." >&2
    exit 1
fi

root=$(git rev-parse --show-toplevel)
cd "$root"
out="$root/bench-builds"
network=${NETWORK:-mainnet}

if [ -n "$(git status --porcelain -- sdk/src)" ]; then
    echo "sdk/src has uncommitted changes; commit or stash them first" >&2
    exit 1
fi
trap 'git checkout -- sdk/src' EXIT

if [ ! -d wasm/dist/mainnet ]; then
    version=$(node -p 'require("./wasm/package.json").version')
    echo "wasm/dist is missing; unpacking published @provablehq/wasm@$version" >&2
    tmp=$(mktemp -d)
    (cd "$tmp" && npm pack --silent "@provablehq/wasm@$version" > /dev/null)
    tar xzf "$tmp"/provablehq-wasm-*.tgz -C "$tmp"
    cp -R "$tmp/package/dist" wasm/dist
    rm -rf "$tmp"
fi

args=()
for spec in "$@"; do
    name=${spec%%=*}
    refs=${spec#*=}
    if [ "$name" = "$spec" ] || [ -z "$name" ] || [ -z "$refs" ]; then
        echo "bad variant '$spec'; expected <name>=<ref>[+<ref>...]" >&2
        exit 1
    fi

    git checkout -- sdk/src
    IFS=+ read -r -a ref_list <<< "$refs"
    for ref in "${ref_list[@]}"; do
        git diff "HEAD...$ref" -- sdk/src | git apply --allow-empty
    done

    echo "building $name ($refs)" >&2
    (cd sdk && npx rollup -c rollup.config.js --silent)
    rm -rf "$out/$name"
    mkdir -p "$out/$name"
    cp -R sdk/dist "$out/$name/dist"

    entry="$name=$out/$name/dist/$network/node.js"
    if [ ${#args[@]} -eq 0 ]; then
        args+=(--sdk "$entry")
    else
        args+=(--compare "$entry")
    fi
done

echo
echo "compare with:"
echo "  node sdk/benchmarks/network-bench.mjs ${args[*]}"
