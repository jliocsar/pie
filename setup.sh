#!/bin/sh
set -eu

pie_release_url="${PIE_RELEASE_URL:-https://github.com/jliocsar/pie/releases/latest/download}"
pie_install_directory="${PIE_INSTALL_DIRECTORY:-/usr/local/bin}"
current_step=start

report_failed_step() {
  exit_status=$?
  if [ "$exit_status" -ne 0 ]; then
    echo "pie setup: failed at step \"$current_step\"." >&2
  fi
}

run_as_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    echo "pie setup: $1 needs root, and this box has no sudo. Re-run as root." >&2
    return 1
  fi
}

install_pie() {
  case "$(uname -m)" in
    x86_64 | amd64) pie_architecture=x64 ;;
    aarch64 | arm64) pie_architecture=arm64 ;;
    *)
      echo "pie setup: no build for $(uname -m), only x86_64 and aarch64." >&2
      return 1
      ;;
  esac
  pie_download="$(mktemp)"
  curl -fsSL "$pie_release_url/pie-linux-$pie_architecture" -o "$pie_download"
  run_as_root mkdir -p "$pie_install_directory"
  run_as_root install -m 755 "$pie_download" "$pie_install_directory/pie"
  rm -f "$pie_download"
  "$pie_install_directory/pie" --version
}

setup_pie() {
  trap report_failed_step EXIT

  current_step="install pie"
  install_pie

  if [ "$#" -gt 0 ]; then
    current_step="pie pod up"
    "$pie_install_directory/pie" pod up "$1"
  fi
}

setup_pie "$@"
