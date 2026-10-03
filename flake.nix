{
  description = "m365-copilot-proxy — OpenAI-compatible proxy for M365 Copilot (dev shell, package, NixOS module)";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    pnpm2nix = {
      url = "github:cramt/pnpm2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, nixpkgs, flake-utils, pnpm2nix, ... }:
    (flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        # pi's published npm-shrinkwrap.json omits integrity for its own
        # first-party sub-packages, which makes buildNpmPackage's prefetch
        # panic. Inject the registry integrity hashes before the lockfile is read.
        fixPiLock = pkgs.writeText "fix-pi-lock.js" ''
          const fs = require("fs");
          // 1) pi's shrinkwrap omits integrity for its own sub-packages — add them.
          const lf = "npm-shrinkwrap.json";
          const j = JSON.parse(fs.readFileSync(lf, "utf8"));
          const I = {
            "node_modules/@earendil-works/pi-agent-core": "sha512-oPwVRkkAvyKPWyM7E4k+EaTNmynbYn7ZLG/LBh9BUnMNb2gvpMp+VQ420R6JCJ20uogSqrHnWTyosSa/rU8lVw==",
            "node_modules/@earendil-works/pi-ai": "sha512-CM2pkTs1iupG/maw381lC9Q/Y/aQaMGK7GILc28ttImD0ci3LDwKroDsGkWbly5JIy3iqxdRxB9JlG7vvzCzTg==",
            "node_modules/@earendil-works/pi-tui": "sha512-07GVQo/38a0yvIPlWDr3RJn1B8gk3ZuIX9h2oIQ+Biyu3JN0KppWmgWHfaWRydQgse5JtC++KDw5MWaIRnV0mw=="
          };
          for (const [k, v] of Object.entries(I)) {
            if (j.packages && j.packages[k]) j.packages[k].integrity = v;
          }
          fs.writeFileSync(lf, JSON.stringify(j, null, 2));
          // 2) The shrinkwrap omits the dev-dependency tree, so `npm ci` would try
          // to resolve devDependencies (e.g. @types/*) that aren't in the cache.
          // dist/ is prebuilt, so drop devDependencies entirely to keep ci offline.
          const pf = "package.json";
          const p = JSON.parse(fs.readFileSync(pf, "utf8"));
          delete p.devDependencies;
          fs.writeFileSync(pf, JSON.stringify(p, null, 2));
        '';

        # pi coding agent (https://pi.dev) — a minimal agent harness, packaged
        # from its npm release so it travels with the flake across machines.
        pi = pkgs.buildNpmPackage rec {
          pname = "pi-coding-agent";
          version = "0.78.1";
          src = pkgs.fetchurl {
            url = "https://registry.npmjs.org/@earendil-works/pi-coding-agent/-/pi-coding-agent-${version}.tgz";
            hash = "sha256-72mCHDg9kv0n59mtvcseN2IUQelMUjSOR6KQHqnX3Qw=";
          };
          sourceRoot = "package";
          postPatch = "${pkgs.nodejs}/bin/node ${fixPiLock}";
          # dist/ is prebuilt in the tarball; just install prod deps + the bin
          # wrapper. Dev deps (e.g. @types/*) aren't in the prefetched cache.
          dontNpmBuild = true;
          npmFlags = [ "--ignore-scripts" ];
          npmInstallFlags = [ "--omit=dev" ];
          npmDepsHash = "sha256-ZR1dJcf5fAMK+7jtT0aDwNYYRaS0Pye1fLkUxVHtO+Y=";
        };

        # Build the Nitro proxy from the pnpm workspace. mkPnpmWorkspace assembles
        # node_modules from pre-fetched tarballs (no `pnpm install`), so Playwright's
        # browser-download postinstall never runs. preBuildPackages builds core +
        # proxy-lib (tsdown → dist/) before the proxy's `nitro build`.
        ws = pnpm2nix.lib.${system}.mkPnpmWorkspace {
          workspace = ./.;
          nodejs = pkgs.nodejs;
          packages = [ "packages/core" "packages/proxy-lib" ];
          apps = [{
            name = "m365-copilot-proxy";
            path = "packages/proxy";
            version = "0.2.0";
            script = "build"; # nitro build
            distDir = ".output"; # $out = contents of packages/proxy/.output
            preBuildPackages = [ "packages/core" "packages/proxy-lib" ];
          }];
        };

        # The raw Nitro output: $out/server/index.mjs, $out/server/node_modules, $out/public.
        m365-proxy-unwrapped = ws.apps.m365-copilot-proxy;

        # Runnable wrapper: defaults CHROMIUM_PATH to a bundled Chromium (Playwright's
        # bundled browser is broken on NixOS) and forwards PORT/HOST/HOME. Gives a
        # working `nix run .#` and is what the NixOS module execs.
        m365-proxy = pkgs.writeShellApplication {
          name = "m365-copilot-proxy";
          runtimeInputs = [ pkgs.nodejs ];
          text = ''
            export CHROMIUM_PATH="''${CHROMIUM_PATH:-${pkgs.chromium}/bin/chromium}"
            exec node ${m365-proxy-unwrapped}/server/index.mjs "$@"
          '';
        };
      in
      {
        packages = {
          inherit pi;
          m365-copilot-proxy-unwrapped = m365-proxy-unwrapped;
          m365-copilot-proxy = m365-proxy;
          default = m365-proxy;
        };

        devShells.default = pkgs.mkShell {
          # python3 + curl: the bench scripts health-check the proxy with curl,
          # and pi-reliability / phase-sweep run model-written Python on the
          # HOST (pi has no sandbox). Neither is guaranteed outside the shell,
          # and a NixOS host has no python3 at all. Docker is NOT here: the bench
          # needs the system daemon (and the user in its group) anyway.
          buildInputs = with pkgs; [
            nodejs
            pnpm
            chromium
            pi
            python3
            curl
          ];

          shellHook = ''
            export CHROMIUM_PATH="${pkgs.chromium}/bin/chromium"
          '';
        };
      }
    )) // {
      nixosModules.default = import ./nix/module.nix self;
    };
}
