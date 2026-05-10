# Nix / NixOS support

This directory packages the Dance-embedded VSCodium fork in a way that drops
straight into a NixOS configuration. Two flavours are supported:

## 1. Binary overlay (recommended)

`pkgs.vscodium` is overridden so its `src` is the `.tar.gz` of our prebuilt
release rather than upstream VSCodium's. All of nixpkgs's wrapping
(`buildVscode`, desktop file, etc.) is reused unchanged — Dance just rides
along inside the binary.

### Flake users

```nix
{
  inputs.dance-vscodium.url = "github:WjcmeAFJb/vscodium/dance-embed";
  outputs = { self, nixpkgs, dance-vscodium, ... }: {
    nixosConfigurations.my-host = nixpkgs.lib.nixosSystem {
      modules = [
        ({ pkgs, ... }: {
          environment.systemPackages = [
            dance-vscodium.packages.${pkgs.system}.default
          ];
        })
      ];
    };
  };
}
```

Or as a one-shot:

```bash
nix run github:WjcmeAFJb/vscodium/dance-embed
```

### Channel users (no flakes)

```nix
let
  dance = import (fetchTarball "https://github.com/WjcmeAFJb/vscodium/archive/dance-embed.tar.gz") { inherit pkgs; };
in
{
  environment.systemPackages = [ dance.vscodium-dance ];
}
```

## 2. Source patch

If you build VSCodium yourself (custom derivation, fresh upstream, etc.) the
overlay is exposed as a `postPatch` helper:

```nix
{ pkgs, ... }: let
  dance = import (fetchTarball "...") { inherit pkgs; };
in
pkgs.vscodium.overrideAttrs (old: {
  postPatch = (old.postPatch or "") + ''
    ${dance.dance-overlay.applyTo}/bin/apply-dance .
  '';
})
```

The script copies `extensions/dance/` and `src/vs/workbench/contrib/dance/`
into the target tree and inserts the `import` line into
`workbench.common.main.ts`. It's idempotent.

## Bumping the version

The binary mode pins the release tag and SHA-256 in `nix/default.nix`. To
move forward:

```bash
ver=1.116.03200   # whichever release you cut
url=https://github.com/WjcmeAFJb/vscodium/releases/download/$ver/VSCodium-linux-x64-$ver.tar.gz
nix-prefetch-url --type sha256 "$url"
# Substitute version + hash into nix/default.nix and commit.
```

## What about other architectures?

Right now the release CI only builds `linux-x64`. The Nix expression throws
on other systems with a clear message. As CI grows to cover `aarch64-linux`,
`darwin-*`, etc., the `hashes` table in `nix/default.nix` and the `plat`
mapping below it pick those up automatically.
