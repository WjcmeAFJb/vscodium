# A minimal flake so users can `nix run github:WjcmeAFJb/vscodium/dance-embed`
# or splice the override into their own NixOS configuration.

{
  description = "VSCodium with Dance (Kakoune-style modal editing) embedded as a patch";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; config.allowUnfree = true; };
        dance = import ./nix { inherit pkgs; };
      in
      {
        packages = {
          default = dance.vscodium-dance;
          vscodium-dance = dance.vscodium-dance;
          # Expose the patch-mode helper too, for users who build vscodium themselves.
          apply-dance = dance.dance-overlay.applyTo;
        };

        apps.default = {
          type = "app";
          program = "${dance.vscodium-dance}/bin/codium";
        };

        # Re-exported so a downstream `overlays.default` can do `super.dance-overlay`.
        legacyPackages.dance-overlay = dance.dance-overlay;
      });
}
