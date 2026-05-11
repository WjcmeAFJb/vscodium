# nix/default.nix
#
# A drop-in replacement for nixpkgs's `vscodium` derivation that ships our
# Dance-embedded build instead of upstream VSCodium.
#
# Two modes are supported:
#
# 1.  Binary mode (default).  Override `pkgs.vscodium` to pull our pre-built
#     `.tar.gz` from GitHub Releases.  This is exactly what nixpkgs does for
#     stock VSCodium — same `buildVscode` plumbing, different `src`.
#
# 2.  Patch mode.  Apply the dance overlay (`extension/`, `contrib/`, the
#     workbench-import patch) onto an existing VSCodium source tree as a
#     `postPatch` step.  Useful if you build VSCodium from source via your
#     own derivation; nixpkgs's vscodium uses prebuilt binaries so there is
#     no source tree to patch in that case.
#
# Usage with flakes:
#
#     {
#       inputs.dance.url = "github:WjcmeAFJb/vscodium/dance-embed?dir=nix";
#       outputs = { self, nixpkgs, dance, ... }: let
#         pkgs = import nixpkgs { system = "x86_64-linux"; };
#       in {
#         packages.x86_64-linux.default = (dance.lib pkgs).vscodium-dance;
#       };
#     }
#
# Without flakes (overlay-style):
#
#     let dance = (import (fetchTarball "https://github.com/WjcmeAFJb/vscodium/archive/dance-embed.tar.gz") {}); in
#     dance.vscodium-dance
#
{ pkgs ? import <nixpkgs> { }
, lib ? pkgs.lib
, fetchurl ? pkgs.fetchurl
}:
let
  # Pin the release to a known-good build on the fork.  Bump both `version`
  # and `hashes` together via `nix-prefetch-url`.
  version = "1.116.03119";
  baseUrl = "https://github.com/WjcmeAFJb/vscodium/releases/download/${version}";

  # Hashes were computed at release time with `sha256sum`.
  hashes = {
    "linux-x64"   = "15a8ddf15d2996b9e87486579180918bbd0f11aaefda657a066d0cd8ae758d2e";
    # Other arches would be filled in here as we extend the CI matrix.
  };

  inherit (pkgs.stdenv.hostPlatform) system;
  plat =
    {
      x86_64-linux = "linux-x64";
      # x86_64-darwin = "darwin-x64";   # TODO: when CI builds it
      # aarch64-linux = "linux-arm64";  # TODO
    }.${system} or (throw "vscodium-dance: unsupported system ${system}; only x86_64-linux is currently in the release matrix.");

  archiveHash = hashes.${plat} or (throw "vscodium-dance: no hash for ${plat}");
in
rec {
  # ----------------------------------------------------------------------------------
  # The headline package: nixpkgs's vscodium with our binary src.
  # ----------------------------------------------------------------------------------
  vscodium-dance = pkgs.vscodium.overrideAttrs (old: {
    pname = "vscodium-dance";
    inherit version;
    src = fetchurl {
      url = "${baseUrl}/VSCodium-${plat}-${version}.tar.gz";
      sha256 = archiveHash;
    };
    meta = (old.meta or { }) // {
      description = "VSCodium with Dance (Kakoune-style modal editing) embedded as a built-in extension";
      homepage = "https://github.com/WjcmeAFJb/vscodium";
      mainProgram = "codium";
    };
  });

  # ----------------------------------------------------------------------------------
  # Patch mode (for users who build VSCodium themselves).
  #
  # Returns an attrset suitable for splicing into a `derivation`'s `postPatch`:
  #
  #   stdenv.mkDerivation {
  #     ...
  #     postPatch = ''
  #       ${dance-overlay.applyTo}/bin/apply-dance ./vscode
  #     '';
  #   }
  #
  # `applyTo` is a small bash script that copies the bundled extension and
  # the workbench contribution into a target VS Code source tree and edits
  # `workbench.common.main.ts` to register the contribution.
  # ----------------------------------------------------------------------------------
  dance-overlay =
    let
      # The repo path that contains the overlay files.  When this nix file is
      # evaluated as part of a checkout, `..` is the fork root.
      forkRoot = ../.;
    in
    rec {
      extension = "${forkRoot}/src/stable/extensions/dance";
      contrib = "${forkRoot}/src/stable/src/vs/workbench/contrib/dance";
      registerPatch = "${forkRoot}/patches/user/01-dance-register-contrib.patch";

      applyTo = pkgs.writeShellApplication {
        name = "apply-dance";
        runtimeInputs = [ pkgs.coreutils pkgs.gnused pkgs.gawk pkgs.python3 ];
        text = ''
          set -euo pipefail
          if [[ $# -ne 1 ]]; then
            echo "usage: apply-dance <vscode-src-root>" >&2
            exit 64
          fi
          target="$1"
          if [[ ! -d "$target/src/vs/workbench" ]]; then
            echo "apply-dance: '$target' does not look like a vscode source tree" >&2
            exit 65
          fi

          mkdir -p "$target/extensions/dance"
          cp -rT "${extension}" "$target/extensions/dance"
          chmod -R u+w "$target/extensions/dance"

          mkdir -p "$target/src/vs/workbench/contrib/dance"
          cp -rT "${contrib}" "$target/src/vs/workbench/contrib/dance"
          chmod -R u+w "$target/src/vs/workbench/contrib/dance"

          # Neuter the on-disk extension so the extension host treats it as
          # manifest-only — contributes still register, but no code is loaded
          # via IPC. The actual code runs in the workbench's own JS thread.
          # We drop activationEvents entirely; the vsce manifest validator
          # refuses a manifest that declares activationEvents but no main/browser.
          python3 - "$target/extensions/dance/package.json" <<'PYEOF'
          import json, sys
          p = sys.argv[1]
          with open(p) as f: d = json.load(f)
          d.pop("main", None); d.pop("browser", None); d.pop("activationEvents", None)
          with open(p, "w") as f: json.dump(d, f, indent=2)
          PYEOF

          # Embed the JS bundle + manifest as string literals into the
          # workbench source tree so the workbench compile picks them up.
          python3 - "${extension}/out/web-extension.js" "${extension}/package.json" "$target/src/vs/workbench/contrib/dance/browser/danceBundle.ts" <<'PYEOF'
          import json, sys
          bundle_path, manifest_path, out_path = sys.argv[1:4]
          with open(bundle_path, encoding="utf-8") as f: bundle = f.read()
          with open(manifest_path, encoding="utf-8") as f: manifest = json.load(f)
          manifest["main"] = "./out/extension.js"
          manifest["browser"] = "./out/web-extension.js"
          manifest["activationEvents"] = ["*"]
          with open(out_path, "w", encoding="utf-8") as f:
              f.write("// auto-generated by apply-dance — do not edit\n")
              f.write("/* eslint-disable */\n")
              f.write("export const DANCE_BUNDLE_JS = " + json.dumps(bundle) + ";\n")
              f.write("export const DANCE_MANIFEST_JSON = " + json.dumps(json.dumps(manifest)) + ";\n")
          print(f"[apply-dance]   wrote {out_path} ({len(bundle)} bytes of bundle)")
          PYEOF

          main="$target/src/vs/workbench/workbench.common.main.ts"
          if grep -q "contrib/dance/browser/dance.contribution" "$main"; then
            echo "[apply-dance] already wired up — skipping import insertion"
          else
            anchor="import './contrib/performance/browser/performance.contribution.js';"
            grep -qF "$anchor" "$main" || {
              echo "apply-dance: anchor not found in $main" >&2
              exit 66
            }
            awk -v anchor="$anchor" '
              {print}
              $0 == anchor && !done {
                print ""
                print "// Dance (modal editing) core contribution"
                print "import '\'''./contrib/dance/browser/dance.contribution.js'\'''"';"
                done = 1
              }
            ' "$main" > "$main.tmp" && mv "$main.tmp" "$main"
          fi
          echo "[apply-dance] dance integration applied to $target"
        '';
      };
    };
}
