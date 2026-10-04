"""Pulse and Pressure: a private blood pressure log.

Readings are saved in each person's own browser (see static/data.js), so the
static/ folder works on its own as a website. Running this server on a computer
adds one extra: the "Type a note" tab, which reads notes with a local model
through Ollama.

Run:  python app.py
Then open the address it prints, on this computer or on a phone on the same Wi-Fi.
"""

import socket
import urllib.error
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory

from parse_test import MODEL, looks_plausible, parse_reading

BASE_DIR = Path(__file__).parent
PORT = 8000

# Serve static/ at the site root, the same way a static host like Vercel does
app = Flask(__name__, static_folder=str(BASE_DIR / "static"), static_url_path="")


@app.get("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.get("/api/status")
def status():
    """Tells the page that note reading is available here."""
    return jsonify(notes=True, model=MODEL)


# ---------------------------------------------------------------------------
# Parsing a note with the local model
# ---------------------------------------------------------------------------
@app.post("/api/parse")
def parse():
    note = ((request.get_json(silent=True) or {}).get("note") or "").strip()
    if not note:
        return jsonify(error="Type a reading first."), 400
    if len(note) > 500:
        return jsonify(error="That note is too long. Try one day at a time."), 400

    try:
        readings = parse_reading(note)
    except urllib.error.HTTPError:
        return jsonify(
            error=f"Ollama replied with an error. Is the model downloaded? "
            f"Run: ollama pull {MODEL}"
        ), 503
    except urllib.error.URLError:
        return jsonify(
            error="Can't reach Ollama. Make sure it is running on the computer."
        ), 503
    except Exception:
        return jsonify(
            error="The model gave an unexpected answer. Try rewording the note."
        ), 500

    for r in readings:
        r["problems"] = looks_plausible(r)
    return jsonify(readings=readings)


# ---------------------------------------------------------------------------
# Start the server
# ---------------------------------------------------------------------------
def local_ip():
    """This computer's address on the home network (sends no data)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    ip = local_ip()
    print()
    print("Pulse and Pressure is running.")
    print(f"  On this computer:  http://localhost:{PORT}")
    print(f"  On your phone:     http://{ip}:{PORT}   (same Wi-Fi)")
    print(f"  Model:             {MODEL}")
    print("Press Ctrl+C to stop.")
    print()
    # debug stays off: debug mode on a network-facing server is unsafe
    app.run(host="0.0.0.0", port=PORT, debug=False)
