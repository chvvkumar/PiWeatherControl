#!/usr/bin/env bash
# PiWeatherControl — Uninstaller
# Removes the virtual environment, systemd service, and optionally the config.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
SERVICE_NAME="piweathercontrol"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

echo "=== PiWeatherControl Uninstaller ==="

# ── Stop and remove systemd service (Linux only) ─────────────
if [ "$(uname)" = "Linux" ] && [ -f "$SERVICE_FILE" ]; then
    echo "Found systemd service: $SERVICE_NAME"
    read -rp "Stop and remove the systemd service? [y/N] " remove_service
    if [[ "$remove_service" =~ ^[Yy]$ ]]; then
        if [ "$(id -u)" -eq 0 ]; then
            systemctl stop "$SERVICE_NAME" 2>/dev/null || true
            systemctl disable "$SERVICE_NAME" 2>/dev/null || true
            rm -f "$SERVICE_FILE"
            systemctl daemon-reload
            echo "Service removed."
        else
            echo "Run with sudo to remove the systemd service:"
            echo "  sudo systemctl stop $SERVICE_NAME"
            echo "  sudo systemctl disable $SERVICE_NAME"
            echo "  sudo rm $SERVICE_FILE"
            echo "  sudo systemctl daemon-reload"
        fi
    fi
fi

# ── Remove virtual environment ────────────────────────────────
if [ -d "$VENV_DIR" ]; then
    read -rp "Remove virtual environment at $VENV_DIR? [y/N] " remove_venv
    if [[ "$remove_venv" =~ ^[Yy]$ ]]; then
        rm -rf "$VENV_DIR"
        echo "Virtual environment removed."
    fi
else
    echo "No virtual environment found at $VENV_DIR"
fi

# ── Optionally remove config ─────────────────────────────────
if [ -f "$SCRIPT_DIR/config.json" ]; then
    read -rp "Remove config.json (your settings will be lost)? [y/N] " remove_config
    if [[ "$remove_config" =~ ^[Yy]$ ]]; then
        rm -f "$SCRIPT_DIR/config.json"
        echo "Config removed."
    fi
fi

echo ""
echo "=== Uninstall complete ==="
echo "Source files remain in $SCRIPT_DIR"
