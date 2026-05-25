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

      mkCodingAgent = system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          inherit (pkgs) lib;
          codingAgentPackageJson = lib.importJSON ./packages/coding-agent/package.json;
        in
        pkgs.buildNpmPackage (finalAttrs: {
          pname = "pi-coding-agent";
          version = codingAgentPackageJson.version;

          src = ./.;

          npmDepsHash = "sha256-X0qMLqAi5pgrtTw5+DfSPsgIEngUnHwGxqYE6PL8NJU=";

          npmWorkspace = "packages/coding-agent";

          # Skip native module rebuild for unneeded workspaces (e.g. canvas from web-ui)
          npmRebuildFlags = [ "--ignore-scripts" ];

          nativeBuildInputs = [
            pkgs.makeBinaryWrapper
          ];

          # Build workspace dependencies in order, then the coding-agent.
          # We invoke tsgo directly for workspace deps to skip pi-ai's
          # generate-models script which requires network access
          # (models.generated.ts is committed to the repo).
          buildPhase = ''
            runHook preBuild

            npx tsgo -p packages/ai/tsconfig.build.json
            npx tsgo -p packages/tui/tsconfig.build.json
            npx tsgo -p packages/agent/tsconfig.build.json
            npm run build --workspace=packages/coding-agent

            runHook postBuild
          '';

          # npm workspace symlinks in the output point into packages/ which
          # doesn't exist there. Replace runtime deps with built content and
          # delete the rest.
          postInstall = ''
            local nm="$out/lib/node_modules/pi-monorepo/node_modules"

            # Replace workspace deps needed at runtime with real copies
            for ws in @earendil-works/pi-ai:packages/ai \
                      @earendil-works/pi-agent-core:packages/agent \
                      @earendil-works/pi-tui:packages/tui; do
              IFS=: read -r pkg src <<< "$ws"
              rm "$nm/$pkg"
              cp -r "$src" "$nm/$pkg"
            done

            # Delete remaining workspace symlinks
            find "$nm" -type l -lname '*/packages/*' -delete

            # Clean up now-dangling .bin symlinks
            find "$nm/.bin" -xtype l -delete
          ''
          + lib.optionalString pkgs.stdenvNoCC.hostPlatform.isDarwin ''
            # Remove foreign Linux binaries that make audit-tmpdir try to inspect ELF
            # RPATHs with patchelf
            find "$nm/koffi/build/koffi" -mindepth 1 -maxdepth 1 -type d \
              ! -name 'darwin_*' -exec rm -r {} +
            rm -rf \
              "$nm/@anthropic-ai/sandbox-runtime/dist/vendor/seccomp" \
              "$nm/@anthropic-ai/sandbox-runtime/vendor/seccomp"
          '';

          postFixup = "wrapProgram $out/bin/pi --prefix PATH : ${
            lib.makeBinPath [
              pkgs.ripgrep
              pkgs.fd
            ]
          }";

          doInstallCheck = true;
          nativeInstallCheckInputs = [
            pkgs.writableTmpDirAsHomeHook
            pkgs.versionCheckHook
          ];
          versionCheckKeepEnvironment = [ "HOME" ];
          versionCheckProgram = "${placeholder "out"}/bin/pi";
          versionCheckProgramArg = "--version";

          meta = {
            description = "Coding agent CLI with read, bash, edit, write tools and session management";
            homepage = "https://pi.dev/";
            downloadPage = "https://www.npmjs.com/package/@earendil-works/pi-coding-agent";
            changelog = "https://github.com/earendil-works/pi/blob/main/packages/coding-agent/CHANGELOG.md";
            license = lib.licenses.mit;
            mainProgram = "pi";
          };
        });
    in
    {
      devShells = forAllSystems (system: {
        default = mkShell { inherit system; };
        no-bun = mkShell { inherit system; withBun = false; };
      });

      packages = forAllSystems (system: {
        pi-coding-agent = mkCodingAgent system;
        default = mkCodingAgent system;
      });
    };
}
