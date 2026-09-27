#!/bin/sh
set -eu

pie_release_url="${PIE_RELEASE_URL:-https://github.com/jliocsar/pie/releases/latest/download}"
pie_install_directory="${PIE_INSTALL_DIRECTORY:-$HOME/.local/bin}"
pie_reachability_timeout_seconds=5
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

server_url_of_invite() {
  invite_base64="$(printf '%s' "$1" | tr '_-' '/+')"
  case $((${#invite_base64} % 4)) in
    2) invite_base64="$invite_base64==" ;;
    3) invite_base64="$invite_base64=" ;;
  esac
  printf '%s' "$invite_base64" | base64 -d 2>/dev/null | sed -n 's/.*"serverUrl":"\([^"]*\)".*/\1/p'
}

pie_is_reachable() {
  curl -s -o /dev/null --max-time "$pie_reachability_timeout_seconds" "$1"
}

join_tailnet() {
  if ! command -v tailscale >/dev/null 2>&1; then
    curl -fsSL https://tailscale.com/install.sh | sh
  fi
  run_as_root tailscale up --advertise-tags=tag:agent-pod
  if ! pie_is_reachable "$1"; then
    echo "pie setup: joined the tailnet, but pie at $1 is still unreachable. Check the tailnet ACL lets tag:agent-pod reach it." >&2
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
  mkdir -p "$pie_install_directory"
  curl -fsSL "$pie_release_url/pie-linux-$pie_architecture" -o "$pie_install_directory/pie.download"
  chmod +x "$pie_install_directory/pie.download"
  mv "$pie_install_directory/pie.download" "$pie_install_directory/pie"
  "$pie_install_directory/pie" --version
}

put_pie_on_path() {
  path_line="export PATH=\"$pie_install_directory:\$PATH\""
  case ":$PATH:" in
    *":$pie_install_directory:"*) ;;
    *)
      if ! grep -qxF "$path_line" "$HOME/.profile" 2>/dev/null; then
        printf '\n%s\n' "$path_line" >>"$HOME/.profile"
      fi
      echo "pie setup: $pie_install_directory is on PATH in ~/.profile. Open a new shell to use pie."
      ;;
  esac
}

setup_pie() {
  trap report_failed_step EXIT

  if [ "$#" -eq 0 ]; then
    current_step="install pie"
    install_pie
    current_step="put pie on PATH"
    put_pie_on_path
    return 0
  fi

  current_step="read invite"
  pie_server_url="$(server_url_of_invite "$1")"
  if [ -z "$pie_server_url" ]; then
    echo "pie setup: that isn't a pie invite. Copy the whole line that \`pie invite new\` printed." >&2
    return 1
  fi

  current_step="tailscale"
  if pie_is_reachable "$pie_server_url"; then
    echo "pie setup: pie at $pie_server_url is reachable, skipping Tailscale."
  else
    join_tailnet "$pie_server_url"
  fi

  current_step="install pie"
  install_pie
  current_step="put pie on PATH"
  put_pie_on_path
  current_step="pie join"
  "$pie_install_directory/pie" join "$1"
  current_step="pie pod up"
  "$pie_install_directory/pie" pod up
}

setup_pie "$@"
