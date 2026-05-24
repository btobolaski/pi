{
  description = "Pi coding agent";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    # nixpkgs unstable no longer supports Intel macOS. Keep using the final
    # Darwin branch that does so for pi's x86_64-darwin package.
    nixpkgs-darwin-x64.url = "github:NixOS/nixpkgs/nixpkgs-26.05-darwin";

  };

  outputs =
    {
      self,
      nixpkgs,
      nixpkgs-darwin-x64,
    }:
    let
      systems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-darwin"
        "x86_64-linux"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      nixpkgsFor = system: if system == "x86_64-darwin" then nixpkgs-darwin-x64 else nixpkgs;
      # npm's prebuilt Linux binaries require standard FHS loader paths.
      # macOS binaries do not, so Darwin keeps a plain development shell.
      mkShell =
        {
          system,
          withBun ? true,
        }:
        let
          pkgs = import (nixpkgsFor system) { inherit system; };
          shellPackages = [ pkgs.nodejs_22 ] ++ pkgs.lib.optionals withBun [ pkgs.bun ];
          banner = ''
            echo "pi-monorepo dev shell"
            echo "  node: $(node --version)"
            echo "  npm:  $(npm --version)"
            ${if withBun then ''echo "  bun: $(bun --version)"'' else ""}
            echo ""
          '';
        in
        if pkgs.stdenv.hostPlatform.isLinux then
          (pkgs.buildFHSEnv {
            name = "pi-monorepo";
            targetPkgs = _: shellPackages;
            profile = banner;
            runScript = "bash";
          }).env
        else
          pkgs.mkShell {
            name = "pi-monorepo";
            buildInputs = shellPackages;
            shellHook = banner;
          };
      packageFor =
        system:
        let
          pkgs = import (nixpkgsFor system) { inherit system; };
        in
        pkgs.callPackage ./nix/package.nix { source = self; };
    in
    {
      devShells = forAllSystems (system: {
        default = mkShell { inherit system; };
        no-bun = mkShell {
          inherit system;
          withBun = false;
        };
      });

      packages = forAllSystems (system: {
        default = packageFor system;
        pi = packageFor system;
      });

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/pi";
          meta.description = "Pi coding agent";
        };
        pi = self.apps.${system}.default;
      });

      overlays.default = final: _previous: {
        pi = final.callPackage ./nix/package.nix { source = self; };
      };
    };
}
