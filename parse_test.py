import json
import urllib.request

# Change this one line to try a different model (e.g. "qwen2.5:7b")
MODEL = "llama3.2:3b"

# Seconds to wait for Ollama. The first note after a restart also loads the
# model, which can take a while on a computer without a graphics card.
TIMEOUT = 120

# One reading = systolic, diastolic, pulse (any of them can be null)
READING = {
    "type": "object",
    "properties": {
        "systolic": {"type": ["integer", "null"]},
        "diastolic": {"type": ["integer", "null"]},
        "pulse": {"type": ["integer", "null"]},
    },
    "required": ["systolic", "diastolic", "pulse"],
}

# A note can hold zero, one, or several readings
SCHEMA = {
    "type": "object",
    "properties": {
        "readings": {"type": "array", "items": READING},
    },
    "required": ["readings"],
}

SYSTEM = (
    "Extract every blood pressure and pulse reading that was actually measured "
    "from the user's note. Return one entry per reading, in the order they "
    "appear. A note can contain zero, one, or several readings. "
    "If the note has no measured reading, return an empty list. "
    "Use null for anything not stated for a reading. Never guess. "
    "Dates and times are NOT readings. Things like '10/2', '9/28', '7am', "
    "or '2026-10-01' are dates or times, so ignore them. "
    "Blood pressure is two numbers like 120/80. Pulse is a separate number, "
    "usually marked with 'pulse', 'p', 'hr', 'bpm', or 'heart rate'. "
    "A pulse belongs to the same reading as the blood pressure it is "
    "written next to. "
    "Ignore any other numbers that are not a measured reading."
)

# Worked examples shown to the model before every note ("few-shot").
# Small models follow examples much better than they follow rules.
# Keep these DIFFERENT from the notes in test_set.py.
FEW_SHOT = [
    ("pulse 88, bp 131/86 after lunch",
     [{"systolic": 131, "diastolic": 86, "pulse": 88}]),
    ("morning 124/80, evening 133/87 pulse 76",
     [{"systolic": 124, "diastolic": 80, "pulse": None},
      {"systolic": 133, "diastolic": 87, "pulse": 76}]),
    ("one forty over ninety",
     [{"systolic": 140, "diastolic": 90, "pulse": None}]),
    ("doctor wants me under 120/80 someday",
     []),
    ("11/5 8am 129/84 p70",
     [{"systolic": 129, "diastolic": 84, "pulse": 70}]),
    ("pulse 58 after a run",
     [{"systolic": None, "diastolic": None, "pulse": 58}]),
]


def parse_reading(note):
    """Send one note to the local model. Returns a list of reading dicts."""
    messages = [{"role": "system", "content": SYSTEM}]
    for example_note, example_readings in FEW_SHOT:
        messages.append({"role": "user", "content": example_note})
        messages.append({
            "role": "assistant",
            "content": json.dumps({"readings": example_readings}),
        })
    messages.append({"role": "user", "content": note})

    payload = {
        "model": MODEL,
        "stream": False,
        "format": SCHEMA,
        "options": {"temperature": 0},
        "messages": messages,
    }
    req = urllib.request.Request(
        "http://localhost:11434/api/chat",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        content = json.loads(json.loads(resp.read())["message"]["content"])

    # Plain-code cleanup: drop "readings" where the model found nothing at all
    return [
        r for r in content["readings"]
        if not (r["systolic"] is None and r["diastolic"] is None and r["pulse"] is None)
    ]


def to_tuples(readings):
    """Turn [{'systolic':120,...}] into [(120, 80, None)] for easy comparing."""
    return [(r["systolic"], r["diastolic"], r["pulse"]) for r in readings]


def looks_plausible(r):
    """Return a list of problems; empty list means the reading looks sane."""
    problems = []
    if r["systolic"] is not None and not 70 <= r["systolic"] <= 250:
        problems.append(f"the top number ({r['systolic']}) is outside the usual 70 to 250")
    if r["diastolic"] is not None and not 40 <= r["diastolic"] <= 150:
        problems.append(f"the bottom number ({r['diastolic']}) is outside the usual 40 to 150")
    if r["pulse"] is not None and not 30 <= r["pulse"] <= 220:
        problems.append(f"the pulse ({r['pulse']}) is outside the usual 30 to 220")
    if (
        r["systolic"] is not None
        and r["diastolic"] is not None
        and r["systolic"] <= r["diastolic"]
    ):
        problems.append("the top number should be higher than the bottom number")
    return problems


if __name__ == "__main__":
    notes = [
        "bp high today 140 over 90, pulse 78",
        "122/80 am, 135/85 pm",
        "forgot to check today",
    ]
    for note in notes:
        readings = parse_reading(note)
        print(note)
        if not readings:
            print("   (no readings found)")
        for r in readings:
            print("   ->", r, looks_plausible(r))