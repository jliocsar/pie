#!/bin/sh
set -eu

pie_tool=github:jliocsar/pie
pie_version="${PIE_VERSION:-latest}"
pie_install_directory="${PIE_INSTALL_DIRECTORY:-/usr/local/bin}"
mise_path="$HOME/.local/bin/mise"
mise_shims_directory="$HOME/.local/share/mise/shims"
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

install_mise() {
  if [ -x "$mise_path" ]; then
    return
  fi
  mise_installer="$(mktemp)"
  curl -fsSL https://mise.run -o "$mise_installer"
  sh "$mise_installer" </dev/null
  rm -f "$mise_installer"
}

install_pie() {
  "$mise_path" settings set minimum_release_age_excludes "$pie_tool" </dev/null
  MISE_FETCH_REMOTE_VERSIONS_CACHE=0 "$mise_path" use --global "$pie_tool@$pie_version" </dev/null
  run_as_root mkdir -p "$pie_install_directory"
  run_as_root ln -sf "$mise_shims_directory/pie" "$pie_install_directory/pie"
  "$pie_install_directory/pie" --version
}

setup_pie() {
  trap report_failed_step EXIT

  current_step="install mise"
  install_mise

  current_step="install pie"
  install_pie

  if [ "$#" -gt 0 ]; then
    current_step="pie pod up"
    "$pie_install_directory/pie" pod up "$1"
  fi
}

setup_pie "$@"
