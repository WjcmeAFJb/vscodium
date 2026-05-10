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
        runtimeInputs = [ pkgs.coreutils pkgs.gnused pkgs.gawk ];
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

          mkdir -p "$target/src/vs/workbench/contrib/dance"
          cp -rT "${contrib}" "$target/src/vs/workbench/contrib/dance"

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
