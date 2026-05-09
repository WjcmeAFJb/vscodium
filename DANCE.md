# VSCodium with Dance (embedded)

This fork of [VSCodium](https://github.com/VSCodium/vscodium) embeds
[Dance](https://github.com/71/dance) — Kakoune/Helix-style modal editing — directly
into the editor as a built-in extension and a renderer-side workbench contribution.
Dance does not need to be installed from the marketplace; it ships in the binary.

## Why a fork instead of an extension?

Running Dance as a regular extension means every keystroke that mutates state
crosses the extension-host RPC boundary several times (selection update, edit
batch, context-key flip). On low-end hardware those round-trips dominate latency.
By living inside the build we can:

- bundle Dance as a built-in extension that loads at startup with no marketplace
  cost and no first-keystroke activation lag;
- expose a small renderer-side contribution (`src/vs/workbench/contrib/dance/`)
  that handles the hottest operations directly against `ICodeEditor` /
  `ITextModel`, bypassing the ext-host RPC for those calls;
- key per-buffer caches on `WeakMap<ITextModel, …>` so they vanish with the model
  and never hold memory after a buffer is closed.

## Layout (additions on top of upstream VSCodium)

```
src/stable/
├── extensions/dance/                                 ← built-in extension overlay
│   ├── package.json                                  manifest (stripped of devDeps)
│   ├── README.md, LICENSE, .vscodeignore
│   ├── assets/dance.{png,svg}
│   └── out/{extension,web-extension}.js              pre-bundled with esbuild
└── src/vs/workbench/contrib/dance/browser/
    └── dance.contribution.ts                         renderer-side fast paths

patches/user/
└── 01-dance-register-contrib.patch                   imports the contribution

.github/workflows/
└── release-dance.yml                                 build & publish to Releases
```

The `src/stable/` directory is VSCodium's vanilla overlay that gets `cp -rp`'d on
top of the upstream vscode source before any patches are applied. We use it for
the bulky additions; only the small workbench-main wire-up needs a real `.patch`.

## Fast paths exposed by the contribution

The bundled Dance extension can call these via `vscode.commands.executeCommand` —
each one collapses what would otherwise be several ext-host round-trips into a
single in-renderer call:

| Command             | Purpose                                                 |
| ------------------- | ------------------------------------------------------- |
| `_dance.setMode`    | flip the `dance.mode` context key synchronously         |
| `_dance.atomicEdit` | apply edits + final selections in one transaction       |
| `_dance.regex.exec` | run a regex against a model with per-model LRU cache    |
| `_dance.pushSelections` / `_dance.popSelections` | bounded selection ring   |
| `_dance.diag`       | sanity check — returns counts of tracked editors/models |

## How "must not slow down with time" is enforced

- **Per-model regex cache** — `WeakMap<ITextModel, …>` so the cache is garbage
  collected the moment the model is. A 64-entry per-model LRU cap also guards
  against runaway accumulation inside a single long-lived buffer.
- **Per-editor state** — kept in a `Map` keyed on `editor.getId()`, but proactively
  removed on `ICodeEditorService.onCodeEditorRemove` AND `editor.onDidDispose`,
  so a closed editor frees its scratch state immediately.
- **Bounded selection ring** — fixed-size circular buffer instead of an
  ever-growing array.
- **No global listeners on text models** — every listener lives inside the
  per-editor `DisposableStore` and dies with the editor.

## Building locally

```bash
./get_repo.sh           # clone upstream vscode at upstream/stable.json's commit
./build.sh              # apply patches + run gulp min-prepack
```

## Building in CI

The `release-dance.yml` workflow runs in two jobs:

1. **compile** — applies patches, runs `gulp vscode-min-prepack` (~12 min on
   `ubuntu-22.04`)
2. **package** — runs inside `vscodium/vscodium-linux-build-agent:focal-x64`
   to produce installable artifacts (~20 min)

Triggers:
- push to `dance-embed` (skipping `**/*.md` and `dev/**`) → uploads artefacts
  to the run for download
- push of a `v*` tag → publishes a GitHub Release with the same artefacts
- manual `workflow_dispatch` (with `generate_assets=true` for download-only)

Releases land at https://github.com/{owner}/vscodium/releases.

## Cutting a release

```bash
./dev/cut-release.sh                # auto-derives version from upstream/stable.json
./dev/cut-release.sh 1.116.05012    # or supply RELEASE_VERSION explicitly
```

The script tags `vN` and pushes; CI takes it from there.

## Trying it out

After a build run completes (manual or pushed):

1. open the run on the Actions tab
2. download the `vscodium-dance-linux-x64` artefact (a `.zip` containing the
   actual `.deb` / `.rpm` / `.tar.gz`)
3. extract the `.tar.gz` and run `./VSCodium-linux-x64-*/bin/codium`

To verify Dance is alive:

- the Extensions sidebar should list **Dance** (publisher `gregoire`,
  marked "built-in")
- run command `_dance.diag` from the Command Palette — its return value goes
  to `Help → Toggle Developer Tools → Console`. A response like
  `{ runtimeReady: true, editorsTracked: 0, modelsOpen: …, mode: 'normal' }`
  means the workbench contribution is online
- press `Escape` in any text editor to enter normal mode; `hjkl` should now
  move the caret without inserting characters

## Updating the embedded Dance source

`src/stable/extensions/dance/out/*.js` is the pre-bundled output. To refresh:

```bash
git clone https://github.com/71/dance ../dance-source
cd ../dance-source
yarn install && yarn run compile && yarn run compile-web
cp out/extension.js out/web-extension.js \
   ../this-fork/src/stable/extensions/dance/out/
# the manifest can be regenerated similarly via dance/meta.ts
```
