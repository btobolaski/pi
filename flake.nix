{
  description = "pi-monorepo development environment";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixpkgs-unstable";
    pi-ai-release = {
      url = "https://registry.npmjs.org/@earendil-works/pi-ai/-/pi-ai-0.84.3.tgz";
      flake = false;
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      pi-ai-release,
    }:
    let
      forAllSystems = nixpkgs.lib.genAttrs nixpkgs.lib.systems.flakeExposed;
      # npm ships platform-specific prebuilt binaries (e.g.
      # @biomejs/cli-linux-x64/biome) whose ELF interpreter is hardcoded to
      # /lib64/ld-linux-x86-64.so.2. NixOS has no such loader, so `npm run
      # check` fails outside an FHS environment. On Linux we wrap the dev shell
      # in buildFHSEnv, which provides a standard FHS layout (including the
      # loader) so the unmodified npm binaries run as-is. macOS uses Mach-O
      # binaries and needs no such wrapper, so it keeps a plain mkShell.
      mkShell =
        {
          system,
          withBun ? true,
        }:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          lib = pkgs.lib;
          shellPackages = [
            pkgs.nodejs_22
          ]
          ++ lib.optionals withBun [
            pkgs.bun
          ];
          banner = ''
            echo "pi-monorepo dev shell"
            echo "  node: $(node --version)"
            echo "  npm:  $(npm --version)"
            ${if withBun then ''echo "  bun:  $(bun --version)"'' else ""}
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

      mkCodingAgent =
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          inherit (pkgs) lib;
          codingAgentPackageJson = lib.importJSON ./packages/coding-agent/package.json;
          piAiReleasePackageJson = lib.importJSON "${pi-ai-release}/package.json";
        in
        assert piAiReleasePackageJson.version == codingAgentPackageJson.version;
        pkgs.buildNpmPackage (finalAttrs: {
          pname = "pi-coding-agent";
          version = codingAgentPackageJson.version;

          # Match the dev shell and CI. Node 24's ESM loader mismanages file
          # descriptors (readFileSync in node:internal/modules/esm/load), which
          # surfaces as spurious EBADF during concurrent file reads.
          nodejs = pkgs.nodejs_22;

          src = ./.;

          # Model values are generated into ignored JSON files and included in
          # the published pi-ai package. Seed the sandboxed source build from
          # that lockstep-versioned package instead of calling model APIs.
          postPatch = ''
            mkdir -p packages/ai/src/providers/data
            cp -r ${pi-ai-release}/dist/providers/data/. packages/ai/src/providers/data/
          '';

          npmDepsHash = "sha256-cDx28+c4bwtQpiy5+BCvZhZezoZb4WRqfZj2eoEeMbw=";

          npmWorkspace = "packages/coding-agent";

          # Skip native module rebuild for unneeded workspaces (e.g. canvas from web-ui)
          npmRebuildFlags = [ "--ignore-scripts" ];

          nativeBuildInputs = [
            pkgs.makeBinaryWrapper
          ];

          # Build workspace dependencies in order, then the coding-agent.
          # We invoke tsgo directly for workspace deps to skip pi-ai's
          # network-dependent generate-models script; postPatch supplies its
          # generated model data from the lockstep-versioned package input.
          buildPhase = ''
            runHook preBuild

            npx tsgo -p packages/telemetry/tsconfig.build.json
            npx tsgo -p packages/ai/tsconfig.build.json
            npx tsgo -p packages/tui/tsconfig.build.json
            npx tsgo -p packages/agent/tsconfig.build.json
            npx tsgo -p packages/protocol/tsconfig.build.json
            npx tsgo -p packages/client/tsconfig.build.json
            npm run build --workspace=packages/coding-agent

            runHook postBuild
          '';

          # npm workspace symlinks in the output point into packages/ which
          # doesn't exist there. Replace runtime deps with built content and
          # delete the rest.
          postInstall = ''
            local nm="$out/lib/node_modules/pi-monorepo/node_modules"

            # Replace workspace deps needed at runtime with real copies
            for ws in @earendil-works/pi-telemetry:packages/telemetry \
                      @earendil-works/pi-ai:packages/ai \
                      @earendil-works/pi-agent-core:packages/agent \
                      @earendil-works/pi-tui:packages/tui \
                      @earendil-works/pi-protocol:packages/protocol \
                      @earendil-works/pi-client:packages/client; do
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
            # RPATHs with patchelf. Each path is guarded because the set of bundled
            # binaries shifts as upstream deps change (e.g. koffi was removed, and
            # @anthropic-ai/sandbox-runtime no longer ships vendored seccomp blobs).
            if [ -d "$nm/koffi/build/koffi" ]; then
              find "$nm/koffi/build/koffi" -mindepth 1 -maxdepth 1 -type d \
                ! -name 'darwin_*' -exec rm -r {} +
            fi
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
        no-bun = mkShell {
          inherit system;
          withBun = false;
        };
      });

      packages = forAllSystems (system: {
        pi-coding-agent = mkCodingAgent system;
        default = mkCodingAgent system;
      });
    };
}
