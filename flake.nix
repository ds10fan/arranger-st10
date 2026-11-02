{
  description = "Arranger ST desktop app: webview UI, native audio, VST3 instrument tracks";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  outputs = { self, nixpkgs }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      libs = with pkgs; [ gtk3 webkitgtk_4_1 libsoup_3 glib alsa-lib libx11 pipewire libpulseaudio libjack2 dbus ];
      # libraries Linux plugin binaries commonly link against without bundling them (they are built for
      # ordinary distributions, so the nix-built host has to provide them)
      pluginLibs = with pkgs; [
        libxcb
        libxcb-util
        libxcb-keysyms
        libxcb-wm
        libxcb-image
        libxcb-cursor
        libxcb-render-util
        libx11
        libxext
        libxrandr
        libxcursor
        libxinerama
        libxi
        libxrender
        libxfixes
        cairo
        pango
        freetype
        fontconfig
        zlib
        libGL
        glib
        gtk3
        alsa-lib
        libjack2
        curl
        openssl
        libxkbcommon
        stdenv.cc.cc.lib
      ];
      # prebuilt V8 for the `v8` crate (its build script would download it)
      rustyV8 = pkgs.fetchurl {
        url = "https://github.com/denoland/rusty_v8/releases/download/v152.2.0/librusty_v8_release_x86_64-unknown-linux-gnu.a.gz";
        hash = "sha256-tmg+mvy3f72MssOs9F001SApqyFrMyUiyVF5wS8P7Tw=";
      };
      arranger-st = pkgs.rustPlatform.buildRustPackage {
        pname = "arranger-st";
        version = "0.1.0";
        src = pkgs.lib.cleanSourceWith {
          src = ./.;
          filter = p: t: !(pkgs.lib.hasInfix "/target" p);
        };
        cargoRoot = "native";
        buildAndTestSubdir = "native";
        cargoLock.lockFile = ./native/Cargo.lock;
        nativeBuildInputs = with pkgs; [ pkg-config python3 wrapGAppsHook3 rustPlatform.bindgenHook ];
        buildInputs = libs ++ [ pkgs.glib-networking ];
        RUSTY_V8_ARCHIVE = rustyV8;
        preBuild = "python3 build.py";
        preFixup = ''
          gappsWrapperArgs+=(--suffix LD_LIBRARY_PATH : "${pkgs.lib.makeLibraryPath pluginLibs}")
        '';
        meta.mainProgram = "arranger-st";
      };
    in
    {
      packages.${system}.default = arranger-st;
      apps.${system}.default = { type = "app"; program = "${arranger-st}/bin/arranger-st"; };
      devShells.${system}.default = pkgs.mkShell {
        inputsFrom = [ arranger-st ];
        packages = [ pkgs.rustfmt ];
      };
      formatter.${system} = pkgs.nixpkgs-fmt;
    };
}
