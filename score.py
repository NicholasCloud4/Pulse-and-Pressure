import time

from parse_test import parse_reading, to_tuples, MODEL
from test_set import TESTS, HOLDOUT


def run_set(name, tests):
    print(f"=== {name} ===")
    correct = 0
    start = time.time()

    for note, expected in tests:
        try:
            got = to_tuples(parse_reading(note))
        except Exception as e:
            got = f"ERROR: {e}"

        if got == expected:
            correct += 1
            print("OK   ", note, "->", got)
        else:
            print("MISS ", note)
            print("        got:     ", got)
            print("        expected:", expected)

    per_note = (time.time() - start) / len(tests)
    print(f"\n{name}: {correct}/{len(tests)} correct, {per_note:.1f}s per note\n")
    return correct, len(tests)


# Warm-up call so the one-time model load doesn't skew the speed number
print(f"Loading {MODEL} (warm-up)...\n")
parse_reading("120/80")

dev_correct, dev_total = run_set("DEVELOPMENT SET", TESTS)
hold_correct, hold_total = run_set("HOLDOUT SET (unseen)", HOLDOUT)

print("=" * 40)
print(f"Model: {MODEL}")
print(f"Development: {dev_correct}/{dev_total}")
print(f"Holdout:     {hold_correct}/{hold_total}   <-- the honest number")