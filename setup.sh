#!/bin/sh
set -eu

case "$(uname -m)" in
  x86_64 | amd64) pie_architecture=x64 ;;
  aarch64 | arm64) pie_architecture=arm64 ;;
  *)
    echo "pie: no build for $(uname -m), only x86_64 and aarch64" >&2
    exit 1
    ;;
esac

pie_install_directory="${PIE_INSTALL_DIRECTORY:-$HOME/.local/bin}"
mkdir -p "$pie_install_directory"
curl -fsSL "https://github.com/jliocsar/pie/releases/latest/download/pie-linux-$pie_architecture" -o "$pie_install_directory/pie.download"
chmod +x "$pie_install_directory/pie.download"
mv "$pie_install_directory/pie.download" "$pie_install_directory/pie"

"$pie_install_directory/pie" --version
