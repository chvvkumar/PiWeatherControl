#!/usr/bin/env bash
# PiWeatherControl — Installer
# Creates a Python virtual environment, installs dependencies,
# and optionally sets up a systemd service (Linux/Raspberry Pi).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$SCRIPT_DIR/.venv"
SERVICE_NAME="piweathercontrol"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

echo "=== PiWeatherControl Installer ==="
echo "Project directory: $SCRIPT_DIR"

# ── Check Python ──────────────────────────────────────────────
PYTHON=""
for cmd in python3 python; do
    if command -v "$cmd" &>/dev/null; then
        PYTHON="$cmd"
        break
    fi
done

if [ -z "$PYTHON" ]; then
    echo "ERROR: Python 3 is required but not found."
    exit 1
fi

PY_VERSION=$("$PYTHON" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "Found Python $PY_VERSION ($PYTHON)"

# Require Python >= 3.9
"$PYTHON" -c 'import sys; exit(0 if sys.version_info >= (3,9) else 1)' || {
    echo "ERROR: Python 3.9+ is required (found $PY_VERSION)."
    exit 1
}

# ── Create venv ───────────────────────────────────────────────
if [ -d "$VENV_DIR" ]; then
    echo "Virtual environment already exists at $VENV_DIR"
    read -rp "Recreate it? [y/N] " answer
    if [[ "$answer" =~ ^[Yy]$ ]]; then
        echo "Removing old venv..."
        rm -rf "$VENV_DIR"
    else
        echo "Reusing existing venv."
    fi
fi

if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment..."
    "$PYTHON" -m venv "$VENV_DIR"
fi

# ── Install dependencies ─────────────────────────────────────
echo "Installing dependencies..."
"$VENV_DIR/bin/pip" install --upgrade pip
"$VENV_DIR/bin/pip" install -r "$SCRIPT_DIR/requirements.txt"
echo "Dependencies installed."

# ── Systemd service (Linux only) ─────────────────────────────
if [ "$(uname)" = "Linux" ]; then
    echo ""
    read -rp "Install systemd service to run on boot? [y/N] " install_service
    if [[ "$install_service" =~ ^[Yy]$ ]]; then
        RUN_USER="${SUDO_USER:-$USER}"
        RUN_GROUP="$(id -gn "$RUN_USER")"

        if [ "$(id -u)" -eq 0 ]; then
            cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=PiWeatherControl Enclosure Controller
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_USER
Group=$RUN_GROUP
WorkingDirectory=$SCRIPT_DIR
ExecStart=$VENV_DIR/bin/python app.py
Restart=on-failure
RestartSec=10
Environment=PYTHONUNBUFFERED=1

[Install]
WantedBy=multi-user.target
EOF
            systemctl daemon-reload
            systemctl enable "$SERVICE_NAME"
            echo "Service installed and enabled."
            read -rp "Start the service now? [y/N] " start_now
            if [[ "$start_now" =~ ^[Yy]$ ]]; then
                systemctl start "$SERVICE_NAME"
                echo "Service started. Check status with: systemctl status $SERVICE_NAME"
            fi
        else
            echo "Root privileges required. Re-run with sudo to install the systemd service:"
            echo "  sudo ./install.sh"
        fi
    fi
fi

echo ""
echo "=== Installation complete ==="
echo ""
echo "To run manually:"
echo "  cd $SCRIPT_DIR"
echo "  source .venv/bin/activate"
echo "  python app.py"
echo ""
echo "Or without activating:"
echo "  $VENV_DIR/bin/python app.py"
