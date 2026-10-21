#!/bin/sh
# Builds one npm package per platform under dist/npm/, each holding the Go
# binary for that platform at the version in package.json.
set -eu

cd "$(dirname "$0")/.."
version=$(node -p 'require("./package.json").version')
node -e '
const p = require("./package.json");
const stale = Object.entries(p.optionalDependencies).filter(([, v]) => v !== p.version);
if (stale.length) {
	console.error(`optionalDependencies not at ${p.version}: ${stale.map(([n]) => n).join(", ")}`);
	process.exit(1);
}'

rm -rf dist/npm
for target in darwin/arm64 darwin/amd64 linux/arm64 linux/amd64; do
	goos=${target%/*}
	goarch=${target#*/}
	cpu=$goarch
	[ "$cpu" = amd64 ] && cpu=x64
	name=fleetwatch-$goos-$cpu
	dir=dist/npm/$name
	mkdir -p "$dir/bin"
	CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -trimpath -ldflags=-s -o "$dir/bin/fleetwatch" .
	cat >"$dir/package.json" <<EOF
{
  "name": "$name",
  "version": "$version",
  "description": "The fleetwatch binary for $goos-$cpu",
  "license": "MIT",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/davidrydberg/fleetwatch.git"
  },
  "os": ["$goos"],
  "cpu": ["$cpu"],
  "files": ["bin"]
}
EOF
	echo "built $dir"
done
