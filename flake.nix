{
  description = "pi-monorepo development environment";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
  };

  outputs = { self, nixpkgs }:
    let
      forAllSystems = nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed;
      mkShell = { system, withBun ? true }:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        pkgs.mkShell {
          name = "pi-monorepo";

          buildInputs = [
            pkgs.nodejs_22
          ] ++ pkgs.lib.optionals withBun [
            pkgs.bun
          ];

          shellHook = ''
            echo "pi-monorepo dev shell"
            echo "  node: $(node --version)"
            echo "  npm:  $(npm --version)"
            ${if withBun then ''echo "  bun:  $(bun --version)"'' else ""}
            echo ""
          '';
        };
    in
    {
      devShells = forAllSystems (system: {
        default = mkShell { inherit system; };
        no-bun = mkShell { inherit system; withBun = false; };
      });
    };
}