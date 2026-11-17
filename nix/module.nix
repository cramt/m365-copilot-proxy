# NixOS module for m365-copilot-proxy.
#
# Runs the Nitro proxy as a hardened systemd service. Credentials are delivered
# via systemd LoadCredential (never copied into the world-readable Nix store) and
# symlinked to where the app reads them ($HOME/.config/opencode-m365/secrets.json).
# msal-cache.json + agent-id.json persist in the StateDirectory across restarts.
#
# Imported from the flake as `import ./nix/module.nix self`, where `self` supplies
# the default package for the host's system.
self:
{ config, lib, pkgs, ... }:

let
  cfg = config.services.m365-copilot-proxy;
in
{
  options.services.m365-copilot-proxy = {
    enable = lib.mkEnableOption "the M365 Copilot OpenAI-compatible proxy";

    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.system}.m365-copilot-proxy;
      defaultText = lib.literalExpression "m365-copilot-proxy.packages.\${system}.m365-copilot-proxy";
      description = "The proxy package to run (the wrapper that sets CHROMIUM_PATH and execs the Nitro server).";
    };

    secretsFile = lib.mkOption {
      type = lib.types.path;
      example = "/run/secrets/m365-copilot.json";
      description = ''
        Path to a JSON file with M365 credentials:
        `{ "email": "...", "password": "...", "mfaSecret": "..." }`.

        Delivered to the service via systemd LoadCredential, so it is never placed
        in the Nix store. Manage it with sops-nix, agenix, or any out-of-band method.
      '';
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 4141;
      description = "TCP port the proxy listens on.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      description = ''
        Address to bind. Defaults to localhost — the proxy fronts a paid M365
        account, so set {option}`apiKeyFile` before exposing it to any network.
      '';
    };

    apiKeyFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/m365-proxy-key";
      description = ''
        File holding an API key every client must send as `Authorization: Bearer <key>`
        or `x-api-key` (`/health` stays open). Null means no key. Delivered via
        systemd LoadCredential like {option}`secretsFile`, so it stays out of the Nix store.
        Browser clients additionally need `M365_CORS_ORIGIN` in {option}`environment`.
      '';
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open {option}`port` in the firewall. Leave off unless you have a trusted-network reason.";
    };

    chromium = lib.mkOption {
      type = lib.types.package;
      default = pkgs.chromium;
      defaultText = lib.literalExpression "pkgs.chromium";
      description = "Chromium used for the headless M365 login (CHROMIUM_PATH).";
    };

    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
      example = { M365_TRACE = "1"; };
      description = ''
        Extra environment variables for the service.

        Set `M365_DEBUG = "1"` for truncated debug logging, or `M365_TRACE = "1"`
        for full, untruncated logging (every WS frame, prompt, and response) —
        useful for reverse engineering failures. Both write to a debug file at
        `$STATE_DIRECTORY/.config/opencode-m365/debug.log`
        (i.e. `/var/lib/m365-copilot-proxy/.config/opencode-m365/debug.log`),
        which persists across restarts.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];

    systemd.services.m365-copilot-proxy = {
      description = "M365 Copilot OpenAI-compatible proxy";
      wantedBy = [ "multi-user.target" ];
      after = [ "network-online.target" ];
      wants = [ "network-online.target" ];

      environment = {
        HOME = "%S/m365-copilot-proxy";
        PORT = toString cfg.port;
        HOST = cfg.host;
        CHROMIUM_PATH = "${cfg.chromium}/bin/chromium";
        # Headless automated login still runs; only the interactive (visible-browser)
        # fallback is refused — so a bad/expired credential fails loudly instead of hanging.
        M365_NO_INTERACTIVE = "1";
        PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
      } // cfg.environment;

      serviceConfig = {
        ExecStartPre = pkgs.writeShellScript "m365-copilot-proxy-pre" ''
          set -eu
          mkdir -p "$HOME/.config/opencode-m365"
          # Point the app at the LoadCredential-provided secrets file via symlink,
          # so the plaintext is never persisted into the state directory on disk.
          ln -sf "$CREDENTIALS_DIRECTORY/secrets.json" "$HOME/.config/opencode-m365/secrets.json"
        '';
        # The key's path only exists at runtime ($CREDENTIALS_DIRECTORY); systemd
        # doesn't expand %d in Environment= for every unit type, so export it here.
        ExecStart =
          if cfg.apiKeyFile == null then "${cfg.package}/bin/m365-copilot-proxy"
          else pkgs.writeShellScript "m365-copilot-proxy-start" ''
            export M365_PROXY_KEY_FILE="$CREDENTIALS_DIRECTORY/proxy-key"
            exec ${cfg.package}/bin/m365-copilot-proxy
          '';

        LoadCredential = [ "secrets.json:${cfg.secretsFile}" ]
          ++ lib.optional (cfg.apiKeyFile != null) "proxy-key:${cfg.apiKeyFile}";

        DynamicUser = true;
        StateDirectory = "m365-copilot-proxy";
        StateDirectoryMode = "0700";

        Restart = "on-failure";
        RestartSec = 10;

        # Hardening — kept moderate so headless Chromium (--no-sandbox) can launch.
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectControlGroups = true;
        ProtectKernelModules = true;
        ProtectKernelTunables = true;
        RestrictAddressFamilies = [ "AF_INET" "AF_INET6" "AF_UNIX" ];
        RestrictNamespaces = false; # Chromium needs user namespaces under --no-sandbox
      };
    };
  };
}
